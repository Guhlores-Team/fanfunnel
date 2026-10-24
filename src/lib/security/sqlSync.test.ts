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

// ---------------------------------------------------------------------------
// DEBT-7: functions were mirrored but the DDL around them was not. schema.sql
// lacked 0028's fans.rl_* and 0025's profiles.notify_* columns that claim_spin /
// set_notification_prefs read, 0032's re-shaped RLS policies and 0027/0030's
// grant lock-down; migrations_combined.sql had an unguarded `create policy` that
// made it fail (= not idempotent) on top of schema.sql. The static checks below
// catch each of those classes; scripts/db/schema-drift-check.mjs is the full
// catalog diff on a real Postgres.
// ---------------------------------------------------------------------------

/** Top-level statements with comments stripped, $$ bodies blanked, whitespace collapsed. */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, () => "$$body$$")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
/** Lower-cased, whitespace-free, `public.`-free form for comparing DDL text. */
function canon(st: string): string {
  return st.toLowerCase().replace(/\bpublic\./g, "").replace(/\bint\b/g, "integer").replace(/\s+/g, "");
}

// Column parity: every `alter table … add column` in migrations/ must leave the
// column present in BOTH snapshots (via add column or the create table body).
function addedColumns(sql: string): Set<string> {
  const out = new Set<string>();
  for (const st of statements(sql)) {
    const m = /^alter table (?:only )?(?:public\.)?(\w+) (add column .*)$/i.exec(st);
    if (!m) continue;
    for (const c of m[2].matchAll(/add column (?:if not exists )?(\w+)/gi)) {
      out.add(`${m[1]}.${c[1]}`.toLowerCase());
    }
  }
  return out;
}
function createdTables(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  for (const m of sql.replace(/--[^\n]*/g, " ").matchAll(re)) out.set(m[1].toLowerCase(), m[2]);
  return out;
}
const CONSTRAINT_WORDS = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude"]);
function tableColumns(sql: string): Set<string> {
  const out = new Set<string>();
  for (const [table, body] of createdTables(sql)) {
    for (const line of body.split("\n")) {
      const word = line.trim().split(/[\s,(]/)[0]?.toLowerCase();
      if (word && !CONSTRAINT_WORDS.has(word)) out.add(`${table}.${word}`);
    }
  }
  return out;
}
const schemaCols = new Set([...addedColumns(schemaSql), ...tableColumns(schemaSql)]);
const combinedCols = new Set([...addedColumns(combinedSql), ...tableColumns(combinedSql)]);
const migCols = addedColumns(migrationsSql);
for (const col of migCols) {
  if (!schemaCols.has(col)) fail(`column "${col}" is added in migrations/ but missing from schema.sql`);
  if (!combinedCols.has(col)) fail(`column "${col}" is added in migrations/ but missing from migrations_combined.sql`);
}
const migTables = createdTables(migrationsSql);
for (const table of migTables.keys()) {
  if (!createdTables(schemaSql).has(table)) fail(`table "${table}" is created in migrations/ but missing from schema.sql`);
  if (!createdTables(combinedSql).has(table)) {
    fail(`table "${table}" is created in migrations/ but missing from migrations_combined.sql`);
  }
}

// Policy parity: the effective (last) definition of every policy in migrations/
// must be the effective definition in both snapshots (0032 drift class).
function policyBlocks(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of statements(sql)) {
    const m = /^create policy (\w+) on (?:\w+\.)?(\w+)\b/i.exec(st);
    if (m) out.set(`${m[2]}.${m[1]}`.toLowerCase(), canon(st));
  }
  return out;
}
const migPolicies = policyBlocks(migrationsSql);
const schemaPolicies = policyBlocks(schemaSql);
const combinedPolicies = policyBlocks(combinedSql);
for (const [key, def] of migPolicies) {
  if (!schemaPolicies.has(key)) fail(`policy "${key}" is created in migrations/ but missing from schema.sql`);
  else if (schemaPolicies.get(key) !== def) fail(`policy "${key}" differs between migrations/ and schema.sql (out of sync)`);
  if (!combinedPolicies.has(key)) {
    fail(`policy "${key}" is created in migrations/ but missing from migrations_combined.sql`);
  } else if (combinedPolicies.get(key) !== def) {
    fail(`policy "${key}" differs between migrations/ and migrations_combined.sql (out of sync)`);
  }
}

// Grant parity: every grant/revoke in migrations/ must appear in both snapshots
// (0027/0030 class: a fresh DB left server-only RPCs callable by anon).
const migGrants = new Set(
  statements(migrationsSql)
    .filter((st) => /^(grant|revoke) /i.test(st))
    .map(canon),
);
const schemaGrants = new Set(statements(schemaSql).filter((st) => /^(grant|revoke) /i.test(st)).map(canon));
const combinedGrants = new Set(statements(combinedSql).filter((st) => /^(grant|revoke) /i.test(st)).map(canon));
for (const g of migGrants) {
  if (!schemaGrants.has(g)) fail(`grant/revoke "${g}" is in migrations/ but missing from schema.sql`);
  if (!combinedGrants.has(g)) fail(`grant/revoke "${g}" is in migrations/ but missing from migrations_combined.sql`);
}

// Re-runnability: both snapshots are documented as safe to run repeatedly, so
// every `create policy` / `create trigger` needs a `drop … if exists` guard
// since the previous creation of that object (the unguarded `fans_select` that
// broke migrations_combined.sql on top of schema.sql).
function unguarded(sql: string): string[] {
  const guarded = new Set<string>();
  const bad: string[] = [];
  for (const st of statements(sql)) {
    const create =
      /^create (policy) (\w+) on ([\w.]+)/i.exec(st) ?? /^create (trigger) (\w+) .*? on ([\w.]+)/i.exec(st);
    if (create) {
      const key = `${create[1]} ${create[2]} on ${create[3]}`.toLowerCase();
      if (!guarded.has(key)) bad.push(key);
      guarded.delete(key);
      continue;
    }
    const drop = /^drop (policy|trigger) if exists (\w+) on ([\w.]+)/i.exec(st);
    if (drop) guarded.add(`${drop[1]} ${drop[2]} on ${drop[3]}`.toLowerCase());
  }
  return bad;
}
for (const key of unguarded(combinedSql)) {
  fail(`migrations_combined.sql: "create ${key}" has no "drop … if exists" guard, so re-running the file fails`);
}
for (const key of unguarded(schemaSql)) {
  fail(`schema.sql: "create ${key}" has no "drop … if exists" guard, so re-running the file fails`);
}

if (failures > 0) {
  console.error(`\nSQL sync guard FAILED with ${failures} issue(s).`);
  process.exit(1);
}
console.log(
  `sqlSync.test: ${mig.size} migration functions + ${migTriggers.size} trigger(s) + ${migCols.size} added columns + ${migTables.size} tables + ${migPolicies.size} policies + ${migGrants.size} grants match schema.sql + migrations_combined.sql; both snapshots are re-runnable`,
);
