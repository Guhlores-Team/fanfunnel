import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "./legal";

// T1 (0072): the database gates play on the fan having accepted the current
// Terms version, read from public.legal_terms_version(). If it and
// LEGAL.version differ, the page records one version and the database demands
// another, and no fan can spin. Bump both in the same change.

const SUPABASE = join(import.meta.dirname, "../../supabase");
const files = readdirSync(join(SUPABASE, "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const DEF = /create\s+or\s+replace\s+function\s+public\.legal_terms_version\(\)[\s\S]*?\$\$\s*select\s+'([^']+)'(?:::text)?\s*\$\$\s*;/gi;
const lastValue = (sql: string) => [...sql.matchAll(DEF)].map((m) => m[1]).at(-1);
let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };

const migrations = files.map((f) => readFileSync(join(SUPABASE, "migrations", f), "utf8")).join("\n");
const sqlVersion = lastValue(migrations);
check("a migration defines public.legal_terms_version()", !!sqlVersion);
check(`legal_terms_version() (${sqlVersion}) equals LEGAL.version (${LEGAL.version})`, sqlVersion === LEGAL.version);
for (const snapshot of ["schema.sql", "migrations_combined.sql"]) {
  check(`${snapshot} ends on the same legal_terms_version()`, lastValue(readFileSync(join(SUPABASE, snapshot), "utf8")) === LEGAL.version);
}
// The effective spin functions read the function, never a literal date.
for (const name of ["commit_spin_attempt", "prepare_spin_attempt"]) {
  const body = [...migrations.matchAll(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\([\\s\\S]*?\\$\\$;`, "gi"))].at(-1)?.[0] ?? "";
  check(`${name} is defined`, !!body);
  check(`${name} compares the accepted version with legal_terms_version()`, /acked_terms_version is distinct from public\.legal_terms_version\(\)/.test(body));
  check(`${name} holds no literal Terms version`, !/acked_terms_version is distinct from '/.test(body));
}
// The e2e economic fixtures acknowledge as a fan would; they must accept the
// same version or every fixture play answers needs_ack.
const fixtures = readFileSync(join(import.meta.dirname, "../../e2e/economic-fixtures.mjs"), "utf8");
check("e2e FIXTURE_TERMS_VERSION equals LEGAL.version", /FIXTURE_TERMS_VERSION = "([^"]+)"/.exec(fixtures)?.[1] === LEGAL.version);
console.log(`legal terms version guard: ${passed} checks passed`);
