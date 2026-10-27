/**
 * Every fan page load reads the fan's win history with
 * `spins where fan_id = $1 order by created_at desc limit 50`
 * (src/lib/data/spins.ts getFanPass), and the fan drill-in and boosts filter
 * spins by fan_id the same way. Without an index leading on fan_id that is a
 * scan of every spin. Migration 0045 adds `spins (fan_id, created_at desc)`;
 * this asserts it exists in the migrations AND in both hand-maintained
 * snapshots (schema.sql, migrations_combined.sql), so a fresh or upgraded DB
 * gets it too. The DEBT-7 drift check compares the built catalogs.
 */
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../supabase");
const MIG = join(ROOT, "migrations");

const INDEX =
  /create\s+index\s+if\s+not\s+exists\s+spins_fan_created_idx\s+on\s+public\.spins\s*\(\s*fan_id\s*,\s*created_at\s+desc\s*\)\s*;/i;

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const migFile = readdirSync(MIG).find((f) => f.startsWith("0045_"));
check("migration 0045 exists", migFile === "0045_spins_fan_id_index.sql");
check("0045 creates spins (fan_id, created_at desc)", !!migFile && INDEX.test(readFileSync(join(MIG, migFile), "utf8")));
for (const f of ["schema.sql", "migrations_combined.sql"]) {
  check(`${f} mirrors the spins fan_id index`, INDEX.test(readFileSync(join(ROOT, f), "utf8")));
}

console.log(`spinsFanIndex.test: ${passed} checks passed`);
