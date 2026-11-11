/**
 * AUTH-SENSITIVE (AGENTS.md rules 5/6): the bell's server-side unread marker.
 *
 * `profiles.notifications_seen_at` lives on the profiles row, which a creator
 * must never UPDATE directly (profiles_update is admin-only: role / features
 * escalation). The only write path is the narrow SECURITY DEFINER
 * `set_notifications_seen()` from migration 0043, which stamps now() on the
 * caller's OWN row and nothing else. This static guard pins that shape so a
 * later edit can't widen it, and the app code can't grow a direct write.
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const norm = (s: string) =>
  s
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const migFile = readdirSync(join(SUPA, "migrations")).find((f) => /^0043_.*\.sql$/.test(f));
check("migration 0043 exists", !!migFile);
const mig = norm(readFileSync(join(SUPA, "migrations", migFile!), "utf8"));

function fnBlock(sql: string): string | null {
  const m = sql.match(
    /create or replace function public\.set_notifications_seen\s*\(\s*\)[\s\S]*?as \$\$[\s\S]*?\$\$\s*;/
  );
  return m ? m[0] : null;
}

for (const [name, sql] of [
  ["migration 0043", mig],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["migrations_combined.sql", norm(readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  check(`${name}: adds profiles.notifications_seen_at timestamptz`, /alter table public\.profiles add column if not exists notifications_seen_at timestamptz/.test(sql));
  const fn = fnBlock(sql);
  check(`${name}: defines set_notifications_seen() with no arguments`, !!fn);
  check(`${name}: SECURITY DEFINER`, /security definer/.test(fn!));
  check(`${name}: pins search_path`, /set search_path = public/.test(fn!));
  const body = fn!.slice(fn!.indexOf("$$") + 2, fn!.lastIndexOf("$$"));
  check(`${name}: writes only notifications_seen_at`, /update public\.profiles set notifications_seen_at = now\(\) where id = auth\.uid\(\)/.test(body));
  check(`${name}: touches no role / features / is_active`, !/\b(role|features|is_active|approval_status)\b/.test(body));
  check(`${name}: one statement`, (body.match(/;/g) ?? []).length === 1);
  check(
    `${name}: revoked from public + anon`,
    /revoke execute on function public\.set_notifications_seen\(\) from public, anon;/.test(sql)
  );
  check(
    `${name}: granted to authenticated`,
    /grant execute on function public\.set_notifications_seen\(\) to authenticated;/.test(sql)
  );
}

check("0043 adds no profiles policy (profiles_update stays admin-only)", !/create policy/.test(mig) && !/drop policy/.test(mig));
check("0043 does not grant table privileges", !/grant (select|insert|update|delete|all)/.test(mig));

// No app code writes the column directly: the data layer goes through the RPC.
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts") && e !== "db.types.ts") out.push(p);
  }
  return out;
}
const writers = files(join(ROOT, "src")).filter((f) => {
  const src = readFileSync(f, "utf8");
  return /notifications_seen_at/.test(src) && /\.(update|upsert|insert)\(/.test(src.slice(src.indexOf("notifications_seen_at") - 400, src.indexOf("notifications_seen_at") + 400));
});
check(`no direct write of notifications_seen_at in src (${writers.join(", ")})`, writers.length === 0);
const dataSrc = readFileSync(join(ROOT, "src/lib/data/notifications.ts"), "utf8");
check("data layer marks seen via the RPC", /rpc\(\s*["']set_notifications_seen["']/.test(dataSrc));
check("data layer never uses the service role", !/createServiceClient/.test(dataSrc));

console.log(`notificationsSeen: ${passed} checks passed`);
