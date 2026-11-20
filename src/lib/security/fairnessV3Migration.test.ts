/**
 * AUTH-SENSITIVE: migration 0047 (fairness v3) adds the spin's recorded odds
 * to `spins`. Static checks:
 *  - 0047 adds fair_version / pool_snapshot / pool_hash / fair_trace with their
 *    CHECKs, and schema.sql + migrations_combined.sql mirror every statement;
 *  - any function 0047 creates or redefines carries an explicit revoke from
 *    public + anon and a grant (the 0038/0044 patterns). Today it defines none,
 *    so claim_spin, rollback_claimed_spin and every other grant are untouched;
 *  - negative: spins has no INSERT/UPDATE/DELETE policy for any role, so a
 *    creator (or anyone with the anon key) cannot rewrite a spin's recorded
 *    odds or fingerprint after the fact; only the service role writes spins;
 *  - db.types.ts carries the new columns.
 * The DEBT-7 drift check builds the database from all three SQL sources.
 */
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");
const MIG = join(SUPA, "migrations");

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

const migFile = readdirSync(MIG).find((f) => f.startsWith("0047_"));
check("migration 0047 is 0047_fairness_v3.sql", migFile === "0047_fairness_v3.sql");
const mig = norm(readFileSync(join(MIG, migFile!), "utf8"));
const statements = mig
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

for (const [col, type] of [
  ["fair_version", "smallint"],
  ["pool_snapshot", "jsonb"],
  ["pool_hash", "text"],
  ["fair_trace", "jsonb"],
]) {
  check(
    `0047 adds spins.${col} ${type}`,
    statements.some((s) => s.startsWith(`alter table public.spins add column if not exists ${col} ${type}`)),
  );
}
check("fair_version is limited to 1, 2, 3", /fair_version smallint check \(fair_version is null or fair_version in \(1, 2, 3\)\)/.test(mig));
check("pool_hash must be a SHA-256 hex digest", /pool_hash text check \(pool_hash is null or pool_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(mig));
check(
  "a v3 row must carry snapshot, hash and trace",
  /add constraint spins_fair_v3_complete check \(fair_version is distinct from 3 or \(pool_snapshot is not null and pool_hash is not null and fair_trace is not null\)\)/.test(mig),
);

for (const f of ["schema.sql", "migrations_combined.sql"]) {
  const body = norm(readFileSync(join(SUPA, f), "utf8"));
  check(`${f} mirrors every 0047 statement`, statements.every((s) => body.includes(s)));
}

// Any function 0047 (re)defines must be locked down explicitly.
const fnNames = [...mig.matchAll(/create (?:or replace )?function public\.(\w+)\s*\(/g)].map((m) => m[1]);
for (const name of fnNames) {
  check(
    `0047 revokes ${name} from public and anon`,
    new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon`).test(mig),
  );
  check(`0047 grants ${name} explicitly`, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to `).test(mig));
}
check("0047 redefines no function (claim_spin and its grants stand as in 0035/0038/0044)", fnNames.length === 0);
check("0047 changes no grants or policies", !/\b(grant|revoke)\b|create policy|drop policy/.test(mig));

// Negative: nobody but the service role can write spins.
for (const f of ["schema.sql", "migrations_combined.sql"]) {
  const body = norm(readFileSync(join(SUPA, f), "utf8"));
  const writePolicies = [...body.matchAll(/create policy \w+ on public\.spins for (\w+)/g)]
    .map((m) => m[1])
    .filter((op) => op !== "select");
  check(`${f}: spins has no insert/update/delete/all policy (recorded odds can't be rewritten)`, writePolicies.length === 0);
}
check(
  "schema.sql: spins keeps RLS enabled",
  /alter table public\.spins enable row level security/.test(norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))),
);
for (const f of readdirSync(MIG)) {
  const body = norm(readFileSync(join(MIG, f), "utf8"));
  const writes = [...body.matchAll(/create policy \w+ on public\.spins for (\w+)/g)].filter((m) => m[1] !== "select");
  check(`${f}: no write policy on spins`, writes.length === 0);
}

// Generated types carry the columns (Row, Insert, Update).
const types = readFileSync(join(ROOT, "src/lib/data/db.types.ts"), "utf8");
const spinsBlock = types.slice(types.indexOf("      spins: {"), types.indexOf("Relationships", types.indexOf("      spins: {")));
for (const line of [
  "fair_trace: Json | null",
  "fair_version: number | null",
  "pool_hash: string | null",
  "pool_snapshot: Json | null",
  "fair_trace?: Json | null",
  "fair_version?: number | null",
  "pool_hash?: string | null",
  "pool_snapshot?: Json | null",
]) {
  check(`db.types spins has \`${line}\``, spinsBlock.includes(line));
}

console.log(`fairnessV3Migration.test: ${passed} checks passed`);
