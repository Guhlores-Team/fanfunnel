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

if (failures > 0) {
  console.error(`\nSQL sync guard FAILED with ${failures} issue(s).`);
  process.exit(1);
}
console.log(
  `sqlSync.test: ${mig.size} migration functions match schema.sql + migrations_combined.sql`,
);
