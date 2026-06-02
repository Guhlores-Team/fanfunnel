/**
 * Automated RLS / security lint for the SQL schema. Runs in CI (no DB needed):
 * it parses schema.sql + every migration and asserts the invariants that keep
 * tenants isolated, so a future migration can't silently ship a table with RLS
 * off, a table with no policy, a wide-open `using (true)` rule, or a
 * SECURITY DEFINER function missing search_path (a classic privilege-escalation
 * vector). Complements the runtime cross-tenant test in scripts/security/.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../supabase");
const MIG = join(ROOT, "migrations");

const sql = [
  readFileSync(join(ROOT, "schema.sql"), "utf8"),
  ...readdirSync(MIG)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIG, f), "utf8")),
].join("\n");

// Tables intentionally exempt from creator-scoping (none today). Kept explicit
// so adding one is a deliberate, reviewed decision.
const EXEMPT = new Set<string>([]);

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error("  ✗", msg);
};
const ok = (msg: string) => console.log("  ✓", msg);

// --- Collect every table in the public schema -------------------------------
const tables = new Set<string>();
for (const m of sql.matchAll(/create table (?:if not exists )?public\.(\w+)/g)) {
  tables.add(m[1]);
}

// --- 1. Every table has RLS enabled -----------------------------------------
for (const t of tables) {
  if (EXEMPT.has(t)) continue;
  const re = new RegExp(`alter table public\\.${t}\\s+enable row level security`);
  if (!re.test(sql)) fail(`table "${t}" never enables row level security`);
}

// --- 2. Every table has at least one policy ---------------------------------
for (const t of tables) {
  if (EXEMPT.has(t)) continue;
  const re = new RegExp(`create policy \\w+ on public\\.${t}\\b`);
  if (!re.test(sql)) fail(`table "${t}" has RLS but no policy (= deny-all by accident)`);
}
if (failures === 0) ok(`all ${tables.size} tables enable RLS and define a policy`);

// --- 3. No wide-open policies (using (true) / with check (true)) ------------
const wideOpen = [...sql.matchAll(/using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/g)];
if (wideOpen.length > 0) {
  fail(`found ${wideOpen.length} wide-open policy clause(s) — every row readable/writable`);
} else {
  ok("no wide-open (using/with check true) policies");
}

// --- 4. Every SECURITY DEFINER function pins search_path --------------------
// Split on function definitions and inspect each block's header.
const fnBlocks = sql.split(/create or replace function/i).slice(1);
let definerCount = 0;
for (const block of fnBlocks) {
  const header = block.slice(0, 400).toLowerCase();
  if (header.includes("security definer")) {
    definerCount++;
    const name = block.trim().split(/[(\s]/)[0];
    if (!header.includes("set search_path")) {
      fail(`SECURITY DEFINER function "${name}" does not set search_path`);
    }
  }
}
if (failures === 0) ok(`all ${definerCount} SECURITY DEFINER functions pin search_path`);

// --- Result -----------------------------------------------------------------
if (failures > 0) {
  console.error(`\nRLS lint FAILED with ${failures} issue(s).`);
  process.exit(1);
}
console.log(`\nRLS lint passed (${tables.size} tables, ${definerCount} definer fns).`);
