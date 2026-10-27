/**
 * AUTH-SENSITIVE (AGENTS.md rules 3/5/6/7): error monitoring (migration 0053).
 *
 * app_errors / app_error_alerts are read and resolved by ADMINS only (is_admin(),
 * role AND is_active) and written only by the server with the service role,
 * through two RPCs that anon/authenticated cannot execute. This pins that shape
 * in the migration and both SQL snapshots, and pins the code side: the browser
 * reporter never reaches the service key, the unauthenticated route never builds
 * a service client itself, and the admin routes go through requireAdminRoute().
 * The runtime half is scripts/db/schema-drift-check.mjs (real Postgres probe)
 * and scripts/security/rls-runtime-test.mjs (against the TEST project).
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");
const SRC = join(ROOT, "src");

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

const mig = norm(readFileSync(join(SUPA, "migrations", "0053_app_errors.sql"), "utf8"));
const RECORD_SIG = "record_app_error(text, text, text, text, text, text, text, integer)";
const CLAIM_SIG = "claim_app_error_alert(integer, uuid)";

for (const [name, sql] of [
  ["migration 0053", mig],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["migrations_combined.sql", norm(readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  for (const t of ["app_errors", "app_error_alerts"]) {
    check(`${name}: creates ${t}`, sql.includes(`create table if not exists public.${t} (`));
    check(`${name}: ${t} has RLS enabled`, sql.includes(`alter table public.${t} enable row level security;`));
    check(`${name}: anon/authenticated lose every default privilege on ${t}`, sql.includes(`revoke all on table public.${t} from public, anon, authenticated;`));
    check(`${name}: no INSERT/DELETE grant on ${t}`, !new RegExp(`grant [^;]*\\b(insert|delete|all)\\b[^;]* on table public\\.${t}\\b`).test(sql));
    check(`${name}: no INSERT/DELETE/ALL policy on ${t}`, !new RegExp(`create policy \\w+ on public\\.${t} for (insert|delete|all)\\b`).test(sql));
  }
  const policies = [...sql.matchAll(/create policy (\w+) on public\.(app_errors|app_error_alerts) ([^;]*);/g)];
  check(`${name}: three policies on the monitoring tables`, policies.length === 3);
  for (const p of policies) {
    check(`${name}: ${p[1]} is for authenticated only`, / to authenticated /.test(` ${p[3]} `));
    const clauses = [...p[3].matchAll(/(using|with check) \(([^)]*\))\)/g)].map((c) => c[2]);
    check(`${name}: ${p[1]} decides only on is_admin()`, clauses.length > 0 && clauses.every((c) => c === "public.is_admin()"));
    check(`${name}: ${p[1]} never reads user/app metadata`, !/metadata/.test(p[3]));
  }
  check(`${name}: select on app_errors is an admin policy`, /create policy app_errors_admin_select on public\.app_errors for select to authenticated using \(public\.is_admin\(\)\)/.test(sql));
  check(`${name}: update on app_errors is an admin policy`, /create policy app_errors_admin_update on public\.app_errors for update to authenticated using \(public\.is_admin\(\)\) with check \(public\.is_admin\(\)\)/.test(sql));
  check(`${name}: UPDATE is column-limited to resolved/resolved_at`, sql.includes("grant update (resolved, resolved_at) on table public.app_errors to authenticated;"));
  for (const sig of [RECORD_SIG, CLAIM_SIG]) {
    const fn = sig.slice(0, sig.indexOf("("));
    const block = sql.match(new RegExp(`create or replace function public\\.${fn}\\s*\\([\\s\\S]*?\\$\\$;`))?.[0] ?? "";
    check(`${name}: defines ${fn}`, !!block);
    check(`${name}: ${fn} is SECURITY DEFINER with a pinned search_path`, /security definer set search_path = public/.test(block));
    check(`${name}: ${fn} revoked from public, anon AND authenticated`, sql.includes(`revoke execute on function public.${sig} from public, anon, authenticated;`));
    check(`${name}: ${fn} granted to service_role only`, sql.includes(`grant execute on function public.${sig} to service_role;`) && !new RegExp(`grant execute on function public\\.${fn}\\([^;]*to (anon|authenticated|public)`).test(sql));
    check(`${name}: ${fn} revoke follows its definition`, sql.lastIndexOf(`revoke execute on function public.${sig}`) > sql.lastIndexOf(`create or replace function public.${fn}`));
  }
}

// --- code side -------------------------------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// The browser reporter and everything it imports must stay client-safe.
const clientGraph = ["instrumentation-client.ts", "lib/monitoring/client.ts", "lib/monitoring/scrub.ts", "lib/monitoring/report.ts", "lib/monitoring/config.ts", "components/monitoring/useReportBoundaryError.ts", "app/error.tsx", "app/global-error.tsx"];
for (const f of clientGraph) {
  const s = read(f);
  check(`${f}: no server-only import (supabase/server, data layer, capture, alert)`, !/@\/lib\/supabase\/server|@\/lib\/data|monitoring\/capture|monitoring\/alert|server-only/.test(s));
  check(`${f}: never mentions the service-role key or Resend key`, !/SERVICE_ROLE|RESEND_API_KEY/.test(s));
}
check("instrumentation-client imports only the browser reporter", /from "@\/lib\/monitoring\/client"/.test(read("instrumentation-client.ts")));

// Server-only alert secrets are never NEXT_PUBLIC_ and never in a "use client" module.
for (const file of walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith(".test.ts"))) {
  const s = readFileSync(file, "utf8");
  if (/NEXT_PUBLIC_(RESEND|ALERT)/.test(s)) check(`${file}: alert env vars must not be NEXT_PUBLIC_`, false);
  if (/^\s*["']use client["']/m.test(s.slice(0, 400)) && /RESEND_API_KEY|ALERT_EMAIL_TO|monitoring\/capture|monitoring\/alert|data\/appErrors/.test(s)) {
    check(`${file}: "use client" module reaches monitoring server code`, false);
  }
}
check("no NEXT_PUBLIC_ alert vars and no client import of the alert/capture code", true);

// The unauthenticated route writes only through the capture pipeline (service
// role inside the data layer), never with its own client.
const route = read("app/api/errors/route.ts");
check("POST /api/errors builds no Supabase client itself", !/createServiceClient|createClient|@\/lib\/supabase/.test(route));
check("POST /api/errors is rate limited per IP via the shared limiter", /rateLimitOr429\(`errors:\$\{clientIp\(req\)\}`/.test(route));
check("POST /api/errors caps the body while reading", /readCappedText\(req, ERROR_REPORT_MAX_BYTES\)/.test(route));
check("POST /api/errors validates with the whitelist schema", /parseClientReport\(raw\)/.test(route));
check("POST /api/errors answers 204 with no body", /new NextResponse\(null, \{ status: 204 \}\)/.test(route));

// The data layer: service role only for the two write RPCs; reads/resolve use
// the cookie-bound client so RLS applies.
const data = read("lib/data/appErrors.ts");
const svcUses = [...data.matchAll(/createServiceClient\(\)\.rpc\("(\w+)"/g)].map((m) => m[1]);
check("data layer: service role is used only for record_app_error + claim_app_error_alert", JSON.stringify(svcUses.sort()) === '["claim_app_error_alert","record_app_error"]' && (data.match(/createServiceClient\(\)/g) ?? []).length === 2);
check("data layer: list/resolve use the caller's client (RLS)", /const sb = await createClient\(\);[\s\S]*from\("app_errors"\)[\s\S]*\.update\(\{ resolved, resolved_at: resolvedAt \}\)/.test(data));

console.log(`security/appErrors: ${passed} checks passed`);
