/**
 * Static guard for the admin surface (AGENTS.md rules 2, 5, 7). No DB needed:
 * it reads the sources and asserts that every admin page / route authorizes via
 * the ONE shared check (`is_admin()`: role AND is_active), that nothing on that
 * surface decides from user_metadata / app_metadata or from a role-only read,
 * and that the server-only check never reaches a "use client" module. The
 * behavioural half (a suspended admin is refused) is src/lib/auth/adminCheck.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "../..");
const ROOT = join(SRC, "..");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const read = (p: string) => readFileSync(p, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error("  ✗", msg);
};
const ok = (msg: string) => console.log("  ✓", msg);

// The data layer is split by domain under src/lib/data (index.ts is the
// barrel), so a guard on "the data layer" scans every non-test module there.
const dataModules = walk(join(SRC, "lib/data")).filter((p) => /\.ts$/.test(p) && !p.endsWith(".test.ts"));
/** The ONE data module that declares `needle` (a function head); fails otherwise. */
function dataModuleDeclaring(needle: string): { path: string; source: string } | null {
  const hits = dataModules.filter((p) => read(p).includes(needle));
  if (hits.length !== 1) {
    fail(`expected exactly one module under src/lib/data to declare ${needle.trim()}, found ${hits.length}`);
    return null;
  }
  return { path: hits[0], source: read(hits[0]) };
}

// The one-time bootstrap is the only admin route a NON-admin may call: it
// promotes the caller only if their email is in ADMIN_EMAILS and no admin
// exists yet. It is exempt from the guard but must keep both locks.
const BOOTSTRAP_ROUTE = "src/app/api/admin/claim/route.ts";

// --- 1. Every admin route handler calls the shared guard first --------------
const routes = walk(join(SRC, "app/api/admin")).filter((p) => p.endsWith("route.ts"));
if (routes.length < 5) fail(`expected the admin routes under src/app/api/admin, found ${routes.length}`);

for (const file of routes) {
  const path = rel(file);
  const source = read(file);
  if (path === BOOTSTRAP_ROUTE) {
    const mod = dataModuleDeclaring("export async function claimAdmin(");
    if (!mod) continue;
    const body = mod.source.slice(mod.source.indexOf("export async function claimAdmin("));
    const cut = body.indexOf("\nexport ");
    const claim = cut === -1 ? body : body.slice(0, cut);
    if (!/ADMIN_EMAILS/.test(claim)) fail(`${path}: claimAdmin lost the ADMIN_EMAILS allowlist`);
    if (!/already_bootstrapped/.test(claim)) fail(`${path}: claimAdmin lost the first-admin-only lock`);
    continue;
  }
  if (!/from "@\/lib\/auth\/admin"/.test(source)) {
    fail(`${path}: does not import the shared admin guard from "@/lib/auth/admin"`);
  }
  const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
  if (handlers.length === 0) fail(`${path}: no HTTP handler found`);
  handlers.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = handlers[i + 1]?.index ?? source.length;
    const chunk = source.slice(start, end);
    if (!/await requireAdminRoute\(\)/.test(chunk)) {
      fail(`${path}: ${m[1]} handler never awaits requireAdminRoute()`);
    }
    if (!/if \(!\w+\.ok\) return \w+\.response;/.test(chunk)) {
      fail(`${path}: ${m[1]} handler does not return the guard's response`);
    }
  });
}
if (failures === 0) ok(`${routes.length - 1} admin routes call requireAdminRoute() in every handler (bootstrap exempt + locked)`);

// --- 2. The admin page gates on the same check -------------------------------
const page = read(join(SRC, "app/admin/page.tsx"));
if (!/from "@\/lib\/auth\/admin"/.test(page) || !/await checkAdmin\(/.test(page)) {
  fail("src/app/admin/page.tsx: must gate on checkAdmin() from @/lib/auth/admin");
} else ok("src/app/admin/page.tsx gates on checkAdmin()");

// --- 3. No metadata-based or role-only decisions on the admin surface -------
const surface = [
  ...routes,
  join(SRC, "app/admin/page.tsx"),
  ...walk(join(SRC, "lib/auth")).filter((p) => !p.endsWith(".test.ts")),
];
const before = failures;
for (const file of surface) {
  const source = read(file);
  if (/user_metadata|app_metadata/.test(source)) {
    fail(`${rel(file)}: reads user_metadata/app_metadata (user-editable, never an authz source)`);
  }
  if (/\.select\(\s*["']role["']\s*\)/.test(source)) {
    fail(`${rel(file)}: role-only profiles read — ignores is_active (HARD-5 regression)`);
  }
}
if (failures === before) ok("no user_metadata/app_metadata or role-only reads on the admin surface");

// --- 4. The predicate mirrors is_admin() and the data layer reuses it -------
const check = read(join(SRC, "lib/auth/adminCheck.ts"));
if (!/rpc\("is_admin"\)/.test(check)) fail("adminCheck.ts: must call the is_admin() RPC");
if (!/role === "admin" && profile\?\.is_active === true/.test(check)) {
  fail("adminCheck.ts: fallback predicate must require role === 'admin' AND is_active === true");
}
const sqlFn = read(join(ROOT, "supabase/schema.sql")).match(
  /create or replace function public\.is_admin\(\)[\s\S]*?\$\$;/
)?.[0];
if (!sqlFn || !/role = 'admin' and is_active/.test(sqlFn) || !/security definer/.test(sqlFn)) {
  fail("schema.sql: is_admin() must be SECURITY DEFINER and require role = 'admin' and is_active");
}
// Every data module: no private admin predicate anywhere, and any module that
// decides on `isActiveAdmin` must take it from @/lib/auth/adminCheck.
let adminCheckUsers = 0;
for (const file of dataModules) {
  const data = read(file);
  if (/async function requireAdmin\(/.test(data)) {
    fail(`${rel(file)}: defines a private requireAdmin() instead of reusing isActiveAdmin()`);
  }
  if (!/\bisActiveAdmin\b/.test(data)) continue;
  if (!/import \{[^}]*\bisActiveAdmin\b[^}]*\} from "@\/lib\/auth\/adminCheck"/.test(data)) {
    fail(`${rel(file)}: must import isActiveAdmin() from @/lib/auth/adminCheck, not define its own`);
  }
  adminCheckUsers++;
}
if (adminCheckUsers === 0) fail("no module under src/lib/data reuses isActiveAdmin() from @/lib/auth/adminCheck");
if (failures === 0) ok(`adminCheck.ts mirrors is_admin() (role AND is_active); ${adminCheckUsers} data module(s) reuse it`);

// --- 5. The server-only check never reaches the browser bundle --------------
for (const file of walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith(".test.ts"))) {
  const source = read(file);
  if (!/^\s*["']use client["']/m.test(source.slice(0, 400))) continue;
  if (/@\/lib\/auth\/admin|lib\/auth\/adminCheck|@\/lib\/supabase\/server/.test(source)) {
    fail(`${rel(file)}: "use client" module imports a server-only auth module`);
  }
}
ok('no "use client" module imports @/lib/auth/* or @/lib/supabase/server');

if (failures > 0) {
  console.error(`\nadminGuard.test: ${failures} failure(s)`);
  process.exit(1);
}
console.log("adminGuard.test: all checks passed");
