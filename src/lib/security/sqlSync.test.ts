/**
 * SQL build-artifact sync guard. The DB can be built three ways that are
 * maintained BY HAND and have already diverged once: the incremental
 * `migrations/*.sql` (source of truth), the `migrations_combined.sql` (paste to
 * upgrade an existing DB), and `schema.sql` (paste for a fresh DB). The original
 * spin-count bug was exactly this: `schema.sql` carried an OLD `claim_spin` that
 * a migration had since replaced, so a fresh DB behaved differently from a
 * migrated one — silently.
 *
 * This test parses every `create or replace function public.NAME(...)` block and
 * asserts that the EFFECTIVE (last) definition of each function in the migrations
 * also appears, byte-for-byte (whitespace/comment-normalized), in BOTH combined
 * files. Runs in CI with no DB. If you add/redefine a function in a migration,
 * mirror it into schema.sql + migrations_combined.sql or this fails.
 */
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../supabase");
const MIG = join(ROOT, "migrations");

const migrationsSql = readdirSync(MIG)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIG, f), "utf8"))
  .join("\n");
const schemaSql = readFileSync(join(ROOT, "schema.sql"), "utf8");
const combinedSql = readFileSync(join(ROOT, "migrations_combined.sql"), "utf8");

// Normalize away comments + whitespace so cosmetic differences don't trip the
// guard — only the effective SQL matters.
function normalize(block: string): string {
  return block
    .replace(/--[^\n]*/g, " ") // strip line comments
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Map each function name -> its LAST (effective) normalized definition block. */
function functionBlocks(sql: string): Map<string, string> {
  const re =
    /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\([^)]*\)[\s\S]*?\bas\s*\$\$[\s\S]*?\$\$\s*;/gi;
  const out = new Map<string, string>();
  for (const m of sql.matchAll(re)) {
    out.set(m[1].toLowerCase(), normalize(m[0])); // later wins = effective def
  }
  return out;
}

const mig = functionBlocks(migrationsSql);
const schema = functionBlocks(schemaSql);
const combined = functionBlocks(combinedSql);

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error("  ✗", msg);
};

assert.ok(mig.size > 0, "expected to parse functions from migrations/");

for (const [name, def] of mig) {
  if (!combined.has(name)) {
    fail(`function "${name}" is defined in migrations/ but missing from migrations_combined.sql`);
  } else if (combined.get(name) !== def) {
    fail(`function "${name}" differs between migrations/ and migrations_combined.sql (out of sync)`);
  }
  if (!schema.has(name)) {
    fail(`function "${name}" is defined in migrations/ but missing from schema.sql`);
  } else if (schema.get(name) !== def) {
    fail(`function "${name}" differs between migrations/ and schema.sql (out of sync — the original spin-count bug)`);
  }
}

// Trigger parity: a `create or replace function` that's mirrored but whose
// `create trigger` is NOT means a fresh DB has the function but never fires it —
// the function/trigger split that hid the fan-spin aggregate drift. Assert every
// trigger created in migrations/ is also created in BOTH snapshots (by name).
function triggerNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/create\s+trigger\s+(\w+)/gi)) out.add(m[1].toLowerCase());
  return out;
}
const migTriggers = triggerNames(migrationsSql);
const schemaTriggers = triggerNames(schemaSql);
const combinedTriggers = triggerNames(combinedSql);
for (const name of migTriggers) {
  if (!combinedTriggers.has(name)) {
    fail(`trigger "${name}" is created in migrations/ but missing from migrations_combined.sql`);
  }
  if (!schemaTriggers.has(name)) {
    fail(`trigger "${name}" is created in migrations/ but missing from schema.sql`);
  }
}

// Constraint parity: a CHECK added by a migration but missing from a snapshot
// means a fresh DB accepts writes the migrated DB rejects (or vice versa).
function constraintNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/add\s+constraint\s+(\w+)/gi)) out.add(m[1].toLowerCase());
  return out;
}
const migConstraints = constraintNames(migrationsSql);
const schemaConstraints = constraintNames(schemaSql);
const combinedConstraints = constraintNames(combinedSql);
for (const name of migConstraints) {
  if (!combinedConstraints.has(name)) {
    fail(`constraint "${name}" is added in migrations/ but missing from migrations_combined.sql`);
  }
  if (!schemaConstraints.has(name)) {
    fail(`constraint "${name}" is added in migrations/ but missing from schema.sql`);
  }
}

// Ledger balances must never go negative. fans.spins_remaining carries an
// inline CHECK in the base schema; the per-wheel fan_passes.spins_remaining
// (the balance claim_spin actually spends) gets its CHECK from migration 0039,
// so it must be added AND validated in a migration and in both snapshots.
const normSchema = normalize(schemaSql);
const passCheck =
  /alter table public\.fan_passes add constraint fan_passes_spins_remaining_check check \(spins_remaining >= 0\)/;
const passValidate =
  /alter table public\.fan_passes validate constraint fan_passes_spins_remaining_check/;
const ledgerSources: [string, string][] = [
  ["migrations/", normalize(migrationsSql)],
  ["schema.sql", normSchema],
  ["migrations_combined.sql", normalize(combinedSql)],
];
for (const [label, src] of ledgerSources) {
  if (!passCheck.test(src)) {
    fail(`${label} does not add CHECK (spins_remaining >= 0) on public.fan_passes`);
  }
  if (!passValidate.test(src)) {
    fail(`${label} never validates fan_passes_spins_remaining_check`);
  }
}
if (!/create table if not exists public\.fans \([^;]*spins_remaining integer not null default 0 check \(spins_remaining >= 0\)/.test(normSchema)) {
  fail("schema.sql: fans.spins_remaining lost its CHECK (spins_remaining >= 0)");
}

if (failures > 0) {
  console.error(`\nSQL sync guard FAILED with ${failures} issue(s).`);
  process.exit(1);
}
console.log(
  `sqlSync.test: ${mig.size} migration functions + ${migTriggers.size} trigger(s) + ${migConstraints.size} constraint(s) match schema.sql + migrations_combined.sql; ledger balance CHECKs present`,
);
