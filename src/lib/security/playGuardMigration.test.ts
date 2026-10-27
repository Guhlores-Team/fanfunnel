/**
 * AUTH-SENSITIVE (AGENTS.md rules 3/5/6): the fan's break and reminder (RM-6,
 * migration 0049).
 *
 * Pins the shape that makes the break a real guardrail, in the migration AND
 * both SQL snapshots, and fails if app code grows a way around it:
 *   - the effective claim_spin refuses a fan on a break, still server-only;
 *   - fan_take_break() only lengthens (greatest), is keyed by a live link
 *     token, and is server-only (revoked from public, anon, authenticated);
 *   - a trigger stops a creator's session from setting/clearing break_until
 *     and stops anyone shortening a break in force;
 *   - fan_play_reminders has RLS with an admin-only read and no creator policy;
 *   - only the data layer calls fan_take_break, on the service client, and no
 *     app code writes break_until directly or reaches it from a client module.
 * The runtime half (real Postgres) is the RM-6 probe in
 * scripts/db/schema-drift-check.mjs and scripts/security/rls-runtime-test.mjs.
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

const migFile = readdirSync(join(SUPA, "migrations")).find((f) => /^0049_/.test(f));
check("migration 0049_play_reminders_breaks.sql exists", migFile === "0049_play_reminders_breaks.sql");
const mig = norm(readFileSync(join(SUPA, "migrations", migFile!), "utf8"));
const allMigs = norm(
  readdirSync(join(SUPA, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(SUPA, "migrations", f), "utf8"))
    .join("\n")
);

/** The LAST definition of public.<name>(...) in `sql`. */
function lastFn(sql: string, name: string): string | null {
  const re = new RegExp(`create or replace function public\\.${name}\\s*\\([^)]*\\)[\\s\\S]*?as \\$\\$[\\s\\S]*?\\$\\$\\s*;`, "g");
  const all = [...sql.matchAll(re)];
  return all.length ? all[all.length - 1][0] : null;
}

for (const [name, sql] of [
  ["migrations/ (effective)", allMigs],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["migrations_combined.sql", norm(readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  check(`${name}: adds fans.break_until`, sql.includes("alter table public.fans add column if not exists break_until timestamptz"));

  const claim = lastFn(sql, "claim_spin");
  check(`${name}: the effective claim_spin refuses a fan on a break`, !!claim && claim.includes("and (f.break_until is null or f.break_until <= now())"));
  check(`${name}: claim_spin still refuses blocked / paused links`, !!claim && claim.includes("and fp.self_excluded_at is null and f.blocked_at is null"));
  check(
    `${name}: claim_spin stays server-only`,
    sql.lastIndexOf("revoke execute on function public.claim_spin(text) from public, anon, authenticated;") >
      sql.lastIndexOf("create or replace function public.claim_spin")
  );

  const take = lastFn(sql, "fan_take_break");
  check(`${name}: defines fan_take_break(p_token text, p_until timestamptz)`, !!take && /fan_take_break\s*\(\s*p_token text, p_until timestamptz\s*\)/.test(take));
  check(`${name}: fan_take_break is SECURITY DEFINER with a pinned search_path`, !!take && /security definer set search_path = public/.test(take));
  check(`${name}: fan_take_break only lengthens`, !!take && take.includes("set break_until = greatest(coalesce(f.break_until, now()), p_until)"));
  check(`${name}: fan_take_break bounds the end`, !!take && take.includes("p_until <= now() or p_until > now() + interval '31 days'"));
  check(
    `${name}: fan_take_break reaches only the token's live link`,
    !!take && take.includes("where fp.token = p_token and fp.fan_id = f.id and fp.is_active = true and fp.self_excluded_at is null and f.blocked_at is null")
  );
  check(`${name}: fan_take_break takes no fan / creator id`, !!take && !/p_(fan|creator|id)\b/.test(take));
  check(
    `${name}: fan_take_break is revoked from public, anon, authenticated`,
    sql.includes("revoke execute on function public.fan_take_break(text, timestamptz) from public, anon, authenticated;")
  );
  check(`${name}: fan_take_break is granted to service_role only`, sql.includes("grant execute on function public.fan_take_break(text, timestamptz) to service_role;") && !/grant execute on function public\.fan_take_break\([^)]*\) to (anon|authenticated|public)/.test(sql));

  const guard = lastFn(sql, "guard_fan_break");
  check(`${name}: the break guard refuses a creator's session`, !!guard && guard.includes("if current_user in ('anon', 'authenticated') then raise exception"));
  check(
    `${name}: the break guard refuses shortening a break in force`,
    !!guard && guard.includes("if old.break_until is not null and old.break_until > now() and (new.break_until is null or new.break_until < old.break_until) then raise exception")
  );
  check(`${name}: the break guard is not SECURITY DEFINER (current_user must be the caller)`, !!guard && !/security definer/.test(guard));
  check(
    `${name}: the break guard fires on every break_until update`,
    sql.includes("create trigger trg_guard_fan_break before update of break_until on public.fans for each row execute function public.guard_fan_break();")
  );

  check(`${name}: fan_play_reminders bounds the reminder`, sql.includes("daily integer not null check (daily between 10 and 500)"));
  check(`${name}: fan_play_reminders enables RLS`, sql.includes("alter table public.fan_play_reminders enable row level security;"));
  const policies = [...sql.matchAll(/create policy (\w+) on public\.fan_play_reminders\b([^;]*);/g)];
  check(`${name}: fan_play_reminders has exactly one policy`, policies.length === 1);
  check(`${name}: and it is an admin-only read (creators read nothing)`, !!policies[0] && /for select using \(public\.is_admin\(\)\)$/.test(policies[0][2].trim()));
}

check("0049 creates no creator-facing policy on fans", !/create policy \w+ on public\.fans\b/.test(mig));
check("0049 grants no table privileges", !/grant (select|insert|update|delete|all)/.test(mig));

// --- app code ----------------------------------------------------------------------
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts") && e !== "db.types.ts") out.push(p);
  }
  return out;
}
const src = files(join(ROOT, "src")).map((f) => ({ f, text: readFileSync(f, "latin1") }));
const writers = src.filter(({ text }) => /\.(update|upsert|insert)\(\s*\{[^}]*\bbreak_until\s*:/.test(text));
check(`no direct break_until writes in src (found: ${writers.map((w) => w.f).join(", ") || "none"})`, writers.length === 0);
const callers = src.filter(({ text }) => /\.rpc\(\s*["']fan_take_break["']/.test(text));
check("exactly one caller of fan_take_break (the data layer)", callers.length === 1 && callers[0].f.endsWith(join("lib", "data", "playGuard.ts")));
check(
  "the caller uses the service client, after resolving the live link",
  /export async function takeBreak[\s\S]*?const sb = createServiceClient\(\);[\s\S]*?resolveLiveFan\(sb, token\)[\s\S]*?\.rpc\("fan_take_break"/.test(callers[0].text)
);
const reminderWriters = src.filter(({ text }) => /from\(\s*["']fan_play_reminders["']\s*\)[\s\S]{0,80}\.(upsert|insert|update|delete)\(/.test(text));
check(
  "only the data layer writes fan_play_reminders",
  reminderWriters.length === 1 && reminderWriters[0].f.endsWith(join("lib", "data", "playGuard.ts"))
);
const clientImports = src.filter(
  ({ text }) => /^\s*["']use client["']/m.test(text) && /from ["']@\/lib\/data(\/playGuard)?["']/.test(text)
);
check(`no "use client" module imports the data layer (found: ${clientImports.map((c) => c.f).join(", ") || "none"})`, clientImports.length === 0);

console.log(`playGuardMigration: ${passed} checks passed`);
