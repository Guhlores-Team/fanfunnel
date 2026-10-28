// Real disposable PostgreSQL16. Never connects to a hosted database.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { correctionSQL } from "../db/repair-test-crypto-0059.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PG = process.env.PG_BIN;
assert.ok(PG, "PG_BIN must select PostgreSQL16");
const WORK = mkdtempSync(join(tmpdir(), "ffcrypto-proof-"));
const DATA = join(WORK, "data"), PORT = "54312";
const ENV = { ...process.env, PGOPTIONS: "-c search_path=public,extensions,pg_temp" };
const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/db/crypto-namespace-0059-manifest.json"), "utf8"));
const signatures = manifest.functions.map(row => row.signature);
const quoted = signatures.map(signature => `'${signature}'`).join(",");
const selected = `oid in (select to_regprocedure(v) from unnest(array[${quoted}]) v)`;
const resetPaths = signatures.map(signature => `alter function ${signature} set search_path to public;`).join("\n");
const metadata = `select jsonb_object_agg(oid::text,to_jsonb(p)-'proconfig') from pg_proc p where ${selected};`;
const configs = `select count(*) from pg_proc where ${selected} and proconfig=array['search_path=public'];`;
const target = signatures.at(-1);
let checks = 0, started = false;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
function command(binary, args) {
  return spawnSync(join(PG, binary), args, { encoding: "utf8", env: ENV, timeout: 60_000 });
}
function sql(db, query, allowedFailure = false) {
  const result = command("psql", ["-h", WORK, "-p", PORT, "-U", "postgres", "-d", db, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query]);
  if (!allowedFailure) assert.equal(result.status, 0, result.stderr);
  return result;
}
function readback(db) { return JSON.parse(sql(db, correctionSQL(true)).stdout.trim()); }
function refusal(db, prepare, restore, reason) {
  sql(db, resetPaths + prepare);
  const before = sql(db, `select jsonb_object_agg(oid::text,to_jsonb(p)) from pg_proc p where ${selected};`).stdout;
  const result = sql(db, correctionSQL(), true);
  check(result.status !== 0 && result.stderr.includes(reason), `exact ${reason} refusal`);
  check(sql(db, `select jsonb_object_agg(oid::text,to_jsonb(p)) from pg_proc p where ${selected};`).stdout === before, "refusal changes no function metadata/config/ACL");
  sql(db, restore);
}
function asyncSQL(db, query) {
  return new Promise(resolvePromise => {
    const child = spawn(join(PG, "psql"), ["-h", WORK, "-p", PORT, "-U", "postgres", "-d", db, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
    child.on("close", status => resolvePromise({ status, stdout, stderr }));
  });
}
try {
  const init = command("initdb", ["-D", DATA, "-A", "trust", "-U", "fixture_bootstrap", "--no-sync"]);
  assert.equal(init.status, 0, init.stderr);
  const start = command("pg_ctl", ["-D", DATA, "-w", "-l", join(WORK, "pg.log"), "-o", `-p ${PORT} -k ${WORK} -c listen_addresses= -c fsync=off`, "start"]);
  assert.equal(start.status, 0, start.stderr); started = true;
  const roles = command("psql", ["-h", WORK, "-p", PORT, "-U", "fixture_bootstrap", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
    "create role postgres login nosuperuser createdb createrole noinherit;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant anon,authenticated,service_role to postgres;"]);
  assert.equal(roles.status, 0, roles.stderr);
  const migration = readFileSync(join(ROOT, "supabase/migrations/0059_focus_attempt_ledger.sql"), "utf8");
  const schema = readFileSync(join(ROOT, "supabase/schema.sql"), "utf8");
  const offset = schema.indexOf(migration);
  assert.ok(offset >= 0 && schema.indexOf(migration, offset + 1) < 0, "exact0059 schema prefix required");
  const prefix = join(WORK, "0059-prefix.sql"); writeFileSync(prefix, schema.slice(0, offset + migration.length));
  for (const mode of ["public", "extensions"]) {
    const db = `crypto_${mode}`;
    sql("postgres", `create database ${db};`);
    sql(db, `create schema extensions; create extension pgcrypto with schema ${mode}; grant usage on schema extensions to public;`);
    for (const file of [join(ROOT, "scripts/db/supabase-stub.sql"), prefix]) {
      const loaded = command("psql", ["-h", WORK, "-p", PORT, "-U", "postgres", "-d", db, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", file]);
      assert.equal(loaded.status, 0, loaded.stderr);
    }
    sql(db, "create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('0059');" + resetPaths);
  }
  // Every schema/function above was created by the NOSUPERUSER function owner.
  for (const mode of ["public", "extensions"]) {
    const db = `crypto_${mode}`;
    check(sql(db, "select rolsuper from pg_roles where rolname=current_user;").stdout.trim() === "f", "actual NOSUPERUSER owner");
    check(sql(db, "select has_table_privilege(current_user,'pg_proc','UPDATE');").stdout.trim() === "f", "no catalog UPDATE grant");
    const call = "select public.create_pass_grant(null,null,null,null,null,1,0,0,null,null,null,1,null);";
    const old = sql(db, "set role service_role;" + call, true);
    check(mode === "extensions" ? old.status !== 0 && /function digest\(text, unknown\) does not exist/.test(old.stderr) : old.status !== 0 && old.stderr.includes("invalid creator intent"), "old path causal control matches namespace");
    for (const role of ["anon", "authenticated"]) {
      const denied = sql(db, `set role ${role};` + call, true);
      check(denied.status !== 0 && denied.stderr.includes("permission denied for function"), "API role still denied before correction");
    }
    const before = sql(db, metadata).stdout;
    const prior = readback(db);
    check(prior.oldConfigs === 15 && prior.targetConfigs === 0 && prior.definitions === 15 && prior.namespaceSafe && prior.primitiveCount === 3 && prior.shadowCount === 0, "read-only preflight actual catalog");
    sql(db, correctionSQL());
    check(sql(db, metadata).stdout === before, "all bodies/OIDs/ACLs/owners/attributes byte-equivalent");
    const current = readback(db);
    check(current.targetConfigs === 15 && current.oldConfigs === 0 && current.definitions === 15, "fresh independent target readback");
    const boundary = sql(db, "set role service_role;" + call, true);
    check(boundary.status !== 0 && boundary.stderr.includes("invalid creator intent") && !boundary.stderr.includes("does not exist"), "service reaches original invalid-intent fence after hashing; no data write");
    const locations = `select jsonb_agg(ctid::text order by oid) from pg_proc where ${selected};`;
    const stable = sql(db, locations).stdout; sql(db, correctionSQL());
    check(sql(db, locations).stdout === stable, "idempotent second pass performs no catalog updates");
    for (const role of ["anon", "authenticated"]) {
      const denied = sql(db, `set role ${role};` + call, true);
      check(denied.status !== 0 && denied.stderr.includes("permission denied for function"), "API role still denied after correction");
    }
    for (const schemaName of ["public", "extensions"]) for (const role of ["anon", "authenticated", "service_role"]) {
      const denied = sql(db, `begin;set local role ${role};create function ${schemaName}.crypto_fixture_shadow() returns integer language sql as 'select 1';rollback;`, true);
      check(denied.status !== 0 && denied.stderr.includes("permission denied for schema"), "actual API-role schema CREATE refusal");
    }
    refusal(db, `alter function ${target} set search_path to pg_catalog;`, resetPaths, "CRYPTO_REPAIR_DEFINITION_REFUSED");
    refusal(db, `alter function ${target} security invoker;`, `alter function ${target} security definer;`, "CRYPTO_REPAIR_DEFINITION_REFUSED");
    refusal(db, `grant execute on function ${target} to anon;`, `revoke execute on function ${target} from anon;`, "CRYPTO_REPAIR_DEFINITION_REFUSED");
    refusal(db, "grant create on schema extensions to authenticated;", "revoke create on schema extensions from authenticated;", "CRYPTO_REPAIR_NAMESPACE_REFUSED");
    refusal(db, "insert into supabase_migrations.schema_migrations values('0060');", "delete from supabase_migrations.schema_migrations where version='0060';", "CRYPTO_REPAIR_HISTORY_REFUSED");
    const shadow = mode === "extensions" ? "public" : "extensions";
    refusal(db, `create function ${shadow}.digest(text,text,text default 'fixture') returns bytea language sql as 'select decode(''00'',''hex'')';`, `drop function ${shadow}.digest(text,text,text);`, "CRYPTO_REPAIR_SHADOW_REFUSED");
    sql(db, resetPaths);
    const definition = sql(db, `select pg_get_functiondef('${target}'::regprocedure);`).stdout.trim();
    const changed = definition.replace("AS $function$", "AS $function$\n-- benign concurrency fixture");
    check(changed !== definition, "actual function body fixture prepared");
    refusal(db, changed, definition, "CRYPTO_REPAIR_DEFINITION_REFUSED");
    sql(db, resetPaths);
    // The only injected command is a local test barrier; production has no pause.
    const marker = "  for item in select value from jsonb_array_elements(expected) order by value->>'signature' loop";
    const original = correctionSQL(), first = original.indexOf(marker), second = original.indexOf(marker, first + marker.length);
    check(first >= 0 && second > first, "real second-loop boundary located");
    const racedQuery = original.slice(0, second) + "  perform pg_sleep(0.7);\n" + original.slice(second);
    const racing = asyncSQL(db, `set application_name='crypto_namespace_race';${racedQuery}`);
    let barrier = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (sql(db, "select count(*) from pg_stat_activity where application_name='crypto_namespace_race' and wait_event='PgSleep';").stdout.trim() === "1") { barrier = true; break; }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    check(barrier, "real inter-session DDL barrier observed");
    sql(db, changed); const raced = await racing;
    const observed = readback(db);
    check(raced.status !== 0 || observed.definitions !== 15, "concurrent changed body never receives verified readback");
    check(sql(db, `select position('benign concurrency fixture' in prosrc)>0 from pg_proc where oid='${target}'::regprocedure;`).stdout.trim() === "t", "correction never overwrites concurrent body");
    if (raced.status !== 0) check(sql(db, configs).stdout.trim() === "15", "rejected concurrent correction rolls back all target configs");
    sql(db, definition + ";\n" + resetPaths);
    console.log(`PASS crypto namespace ${mode}: NOSUPERUSER config-only repair, exact metadata/ACLs, idempotency, schema/crypto-shadow/body/config/ACL/history negatives and concurrent body protection`);
  }
  console.log(`crypto namespace fixture: ${checks} checks passed; no hosted traffic, real credentials or data`);
} finally {
  if (started) command("pg_ctl", ["-D", DATA, "-m", "immediate", "stop"]);
  rmSync(WORK, { recursive: true, force: true });
}
