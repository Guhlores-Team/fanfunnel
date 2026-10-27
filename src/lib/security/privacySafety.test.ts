/**
 * Static guard for the privacy & safety pack (migration 0054). Runs in CI with
 * no database (schema-drift-check.mjs proves the same rules against Postgres):
 *
 *  - the new tables have RLS, an admin/owner-scoped SELECT policy, and NO
 *    insert/update/delete grant for anon or authenticated;
 *  - is_admin() requires aal2, so a password-only admin session gets nothing
 *    from PostgREST either;
 *  - the new server-only functions are revoked from anon/authenticated;
 *  - every admin API route that changes something writes the activity log;
 *  - every privacy route answers no-store;
 *  - nothing user-facing imports the service-role client.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dirname, "../../..");
const SRC = join(REPO, "src");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const sql = read("supabase/migrations/0054_privacy_safety.sql").replace(/--[^\n]*/g, "");

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, match, out);
    else if (match(e)) out.push(p);
  }
  return out;
}

// --- 0054 tables ------------------------------------------------------------
for (const t of ["admin_audit_log", "creator_notices", "link_tombstones"]) {
  check(`${t}: RLS enabled`, new RegExp(`alter table public\\.${t} enable row level security`).test(sql));
  check(`${t}: revoked from anon/authenticated`, new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated`).test(sql));
  const grants = [...sql.matchAll(new RegExp(`grant ([a-z, ]+) on table public\\.${t} to ([a-z_, ]+);`, "g"))];
  for (const [, privs, roles] of grants) {
    if (/\b(anon|authenticated)\b/.test(roles)) {
      check(`${t}: client roles may only SELECT (got ${privs})`, privs.trim() === "select");
    }
  }
  check(`${t}: no wide-open policy`, !new RegExp(`on public\\.${t}[^;]*\\((\\s*)true(\\s*)\\)`).test(sql));
}
check("audit log: select policy is admin-only", /admin_audit_log_admin_select on public\.admin_audit_log for select to authenticated\s+using \(public\.is_admin\(\)\)/.test(sql));
check("audit log: updates blocked by a trigger", /before update on public\.admin_audit_log/.test(sql));
check("tombstones: no client grant at all", !/grant [a-z, ]+ on table public\.link_tombstones to [a-z_, ]*\b(anon|authenticated)\b/.test(sql));
check("notices: own account only", /creator_notices_select on public\.creator_notices for select to authenticated\s+using \(public\.can_act_for\(creator_id, 'view'\)\)/.test(sql));

// --- is_admin needs aal2 ----------------------------------------------------
const isAdmin = sql.match(/create or replace function public\.is_admin\(\)[\s\S]*?\$\$;/)?.[0] ?? "";
check("is_admin(): reads profiles.role + is_active", /role = 'admin'/.test(isAdmin) && /is_active/.test(isAdmin));
check("is_admin(): requires the aal2 claim", /auth\.jwt\(\) ->> 'aal'/.test(isAdmin) && /'aal2'/.test(isAdmin));
check("is_admin(): never reads metadata", !/metadata/.test(isAdmin));

// --- server-only functions --------------------------------------------------
for (const fn of ["reserve_self_account_deletion(uuid)", "run_retention_cleanup(integer, integer, integer, integer)"]) {
  const esc = fn.replace(/[()]/g, "\\$&");
  check(`${fn}: revoked from anon/authenticated`, new RegExp(`revoke execute on function public\\.${esc} from public, anon, authenticated`).test(sql));
  check(`${fn}: no grant to a client role`, !new RegExp(`grant execute on function public\\.${esc} to [a-z_, ]*\\b(anon|authenticated)\\b`).test(sql));
}
check("retention never touches business records", !/delete from public\.(fans|spins|redemptions|fan_passes|grants|messages)\b/.test(sql));
check("fan delete keeps spins (fan_pass_id ON DELETE SET NULL)", /spins_fan_pass_id_fkey[\s\S]*?on delete set null/.test(sql));

// --- every mutating admin route writes the activity log ---------------------
const ADMIN_API = join(SRC, "app/api/admin");
const adminRoutes = walk(ADMIN_API, (f) => f === "route.ts");
for (const file of adminRoutes) {
  const name = relative(SRC, file).split("\\").join("/");
  const src = readFileSync(file, "utf8");
  if (!/export async function (POST|PATCH|PUT|DELETE)\b/.test(src)) continue;
  if (name === "app/api/admin/claim/route.ts") {
    // The one-time bootstrap logs inside claimAdmin() (it knows the new admin's id).
    const claim = read("src/lib/data/admin.ts").split("export async function claimAdmin")[1] ?? "";
    check(`${name}: claimAdmin writes the activity log`, /claimAdmin\(/.test(src) && /recordAudit\(\{[^}]*"admin\.bootstrap"/.test(claim));
    continue;
  }
  check(`${name}: writes the activity log`, /recordAudit\(/.test(src));
}
check("found the admin routes", adminRoutes.length >= 7);

// --- privacy routes are never cached ----------------------------------------
for (const r of ["fan-data/export", "fan-data/delete", "account/export", "account/close", "account/mfa/unenroll", "admin/audit", "cron/retention"]) {
  const src = read(`src/app/api/${r}/route.ts`);
  check(`${r}: no-store responses`, /NO_STORE_HEADERS|privateError|privateJson|jsonDownload/.test(src));
  check(`${r}: no bare NextResponse.json without headers`, !/NextResponse\.json\([^;]*\{\s*status:\s*\d+\s*\}\)/.test(src));
}
check("fan routes are rate limited per token and per IP", ["fan-data/export", "fan-data/delete"].every((r) => (read(`src/app/api/${r}/route.ts`).match(/rateLimitOr429\(/g) ?? []).length >= 2));
check("creator export never builds a service client", !/createServiceClient/.test(read("src/app/api/account/export/route.ts")) && !/createServiceClient/.test(read("src/lib/data/privacy.ts").split("export async function exportCreatorData")[1] ?? "x"));

// --- the service role stays on the server -----------------------------------
const clientFiles = walk(SRC, (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts")).filter((f) => /^\s*["']use client["']/m.test(readFileSync(f, "utf8").slice(0, 200)));
for (const f of clientFiles) {
  const src = readFileSync(f, "utf8");
  if (/@\/lib\/supabase\/server|SUPABASE_SERVICE_ROLE_KEY|@\/lib\/account\/|@\/lib\/privacy\/cron/.test(src)) {
    assert.fail(`${relative(SRC, f)} is a client module that reaches server-only code`);
  }
}
check(`no "use client" module imports server-only code (${clientFiles.length} checked)`, clientFiles.length > 20);
check("CRON_SECRET is never public", !/NEXT_PUBLIC_CRON_SECRET/.test(walk(SRC, (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts")).map((f) => readFileSync(f, "utf8")).join("\n")));

console.log(`privacySafety.test: ${passed} checks passed`);
