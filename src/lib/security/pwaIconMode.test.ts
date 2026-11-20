/**
 * AUTH-SENSITIVE (AGENTS.md rules 2/5/6): the creator's home-screen icon choice
 * (RM-4, migration 0046).
 *
 * `profiles.pwa_icon_mode` lives on the profiles row, which a creator must never
 * UPDATE directly (profiles_update is admin-only). The only write path is the
 * SECURITY DEFINER `set_pwa_icon_mode(text)`, which writes the caller's OWN
 * active row, validates the value, and is not executable by anon. This pins
 * that shape in the migration and both SQL snapshots, and fails if app code
 * grows a direct write to the column.
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

const migFile = readdirSync(join(SUPA, "migrations")).find((f) => /^0046_pwa_icon_mode\.sql$/.test(f));
check("migration 0046_pwa_icon_mode.sql exists", !!migFile);
const mig = norm(readFileSync(join(SUPA, "migrations", migFile!), "utf8"));

function fnBlock(sql: string): string | null {
  const m = sql.match(
    /create or replace function public\.set_pwa_icon_mode\s*\(\s*p_mode text\s*\)[\s\S]*?as \$\$[\s\S]*?\$\$\s*;/
  );
  return m ? m[0] : null;
}

for (const [name, sql] of [
  ["migration 0046", mig],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["migrations_combined.sql", norm(readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  check(
    `${name}: adds profiles.pwa_icon_mode, neutral by default, constrained`,
    sql.includes(
      "alter table public.profiles add column if not exists pwa_icon_mode text not null default 'neutral' check (pwa_icon_mode in ('neutral', 'avatar'))"
    )
  );
  const fn = fnBlock(sql);
  check(`${name}: defines set_pwa_icon_mode(p_mode text)`, !!fn);
  check(`${name}: SECURITY DEFINER`, /security definer/.test(fn!));
  check(`${name}: pins search_path`, /set search_path = public/.test(fn!));
  const body = fn!.slice(fn!.indexOf("$$") + 2, fn!.lastIndexOf("$$"));
  check(`${name}: rejects values outside the allowed set`, /if p_mode is null or p_mode not in \('neutral', 'avatar'\) then raise exception/.test(body));
  check(
    `${name}: writes only pwa_icon_mode on the caller's own active row`,
    /update public\.profiles set pwa_icon_mode = p_mode where id = auth\.uid\(\) and is_active = true;/.test(body)
  );
  check(`${name}: takes no target id`, !/p_(id|user|creator|profile)/.test(fn!));
  check(`${name}: touches no role / features / approval`, !/\b(role|features|approval_status)\b/.test(body));
  check(`${name}: one write`, (body.match(/\bupdate\b/g) ?? []).length === 1);
  check(
    `${name}: revoked from public + anon`,
    /revoke execute on function public\.set_pwa_icon_mode\(text\) from public, anon;/.test(sql)
  );
  check(
    `${name}: granted to authenticated`,
    /grant execute on function public\.set_pwa_icon_mode\(text\) to authenticated;/.test(sql)
  );
  // The revoke must come after (re)defining the function, or a later
  // `create or replace` in the same file would not matter but a reorder could.
  check(`${name}: revoke follows the definition`, sql.lastIndexOf("revoke execute on function public.set_pwa_icon_mode(text)") > sql.lastIndexOf("create or replace function public.set_pwa_icon_mode"));
}

check("0046 adds no policy (profiles_update stays admin-only)", !/create policy|drop policy|alter policy/.test(mig));
check("0046 grants no table privileges", !/grant (select|insert|update|delete|all)/.test(mig));
check("0046 creates no table", !/create table/.test(mig));

// No app code writes the column directly; the data layer goes through the RPC.
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts") && e !== "db.types.ts") out.push(p);
  }
  return out;
}
const directWriters = files(join(ROOT, "src")).filter((f) => {
  const src = readFileSync(f, "latin1");
  return /pwa_icon_mode\s*:/.test(src) && /\.(update|upsert|insert)\(/.test(src);
});
check(`no direct pwa_icon_mode writes in src (found: ${directWriters.join(", ") || "none"})`, directWriters.length === 0);
const rpcCallers = files(join(ROOT, "src")).filter((f) => /\.rpc\(\s*["']set_pwa_icon_mode["']/.test(readFileSync(f, "latin1")));
check("exactly one caller of set_pwa_icon_mode (the data layer)", rpcCallers.length === 1 && rpcCallers[0].endsWith(join("lib", "data", "pwa.ts")));
const caller = readFileSync(rpcCallers[0], "latin1");
check("the caller uses the session client, after auth.getUser()", /setMyPwaIconMode[\s\S]*?await createClient\(\)[\s\S]*?auth\.getUser\(\)[\s\S]*?\.rpc\(\s*"set_pwa_icon_mode"/.test(caller));

console.log(`pwaIconMode: ${passed} checks passed`);
