import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_SCHEMA_VERSION } from "./config";

// A39 (0067): public.schema_version() is how a running deployment learns the
// migration level of its database, so it must never fall behind the files.
// Every migration from 0067 on redefines it with its own number, the app's
// EXPECTED_SCHEMA_VERSION names the newest migration, both snapshots carry the
// same final definition, and the function stays service-role only.

const SUPABASE = join(import.meta.dirname, "../../../supabase");
const files = readdirSync(join(SUPABASE, "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const number = (f: string) => Number(f.slice(0, 4));
const latest = files.at(-1)!;
// 0072 pins its search_path (public, pg_temp); earlier definitions had none.
const DEF = /create\s+or\s+replace\s+function\s+public\.schema_version\(\)\s+returns\s+integer\s+language\s+sql\s+immutable\s+(?:set\s+search_path\s*=\s*public\s*,\s*pg_temp\s+)?as\s+\$\$\s*select\s+(\d+)\s*\$\$\s*;/gi;
const lastValue = (sql: string) => [...sql.matchAll(DEF)].map((m) => Number(m[1])).at(-1);
let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };

check("schema_version() is introduced by 0067", lastValue(readFileSync(join(SUPABASE, "migrations", files.find((f) => number(f) === 67)!), "utf8")) === 67);
for (const f of files.filter((f) => number(f) >= 67)) {
  check(`${f} redefines schema_version() to return ${number(f)}`, lastValue(readFileSync(join(SUPABASE, "migrations", f), "utf8")) === number(f));
}
check(`the app expects the newest migration (${latest})`, EXPECTED_SCHEMA_VERSION === number(latest));
for (const snapshot of ["schema.sql", "migrations_combined.sql"]) {
  check(`${snapshot} ends on the newest schema_version()`, lastValue(readFileSync(join(SUPABASE, snapshot), "utf8")) === number(latest));
}
const grants = files.map((f) => readFileSync(join(SUPABASE, "migrations", f), "utf8")).join("\n");
check("schema_version() is revoked from public, anon and authenticated", /revoke execute on function public\.schema_version\(\) from public, anon, authenticated;/.test(grants));
check("the newest schema_version() pins its search_path", /function public\.schema_version\(\)\s+returns\s+integer\s+language\s+sql\s+immutable\s+set\s+search_path\s*=\s*public\s*,\s*pg_temp\s+as/i.test(readFileSync(join(SUPABASE, "migrations", latest), "utf8")));
check("schema_version() is granted to the service role only", /grant execute on function public\.schema_version\(\) to service_role;/.test(grants) && !/grant execute on function public\.schema_version\(\) to [^;]*(anon|authenticated)/.test(grants));
console.log(`schema version guard: ${passed} checks passed`);
