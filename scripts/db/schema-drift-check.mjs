// @ts-check
// Builds the FanFunnel database four ways on a throwaway local Postgres and
// diffs the resulting catalogs. All four must be identical, otherwise one of the
// hand-maintained SQL snapshots has drifted from the migrations (DEBT-7).
//
//   A  base section of the original schema.sql (git rev; default 6700699 = the
//      first commit whose schema.sql loads on an empty database; the section
//      before its first folded "(migration 00NN)" block) + migrations/0001..N
//      -> the closest reproduction of how prod was built: the reference.
//   B  supabase/schema.sql alone                  -> fresh-project path
//   B2 schema.sql twice                          -> schema.sql must be re-runnable
//   C  supabase/schema.sql + migrations_combined.sql -> documented "paste both" path
//   C2 C + migrations_combined.sql again          -> the combined file must be re-runnable
//
// Needs Postgres 16 binaries (initdb/pg_ctl/psql) on PATH, in $PG_BIN, or
// under /usr/lib/postgresql/*/bin. No TCP port is opened (unix socket only),
// and the data dir is deleted afterwards. When run as root (containers), the
// server is started as the `postgres` OS user because Postgres refuses root.
//
//   node scripts/db/schema-drift-check.mjs [--keep] [--base-rev <git-rev>] [--base <file>]
//
// Exit code 0 = all builds load and all catalogs match; 1 otherwise.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const SUPABASE = join(ROOT, "supabase");
const STUB = join(import.meta.dirname, "supabase-stub.sql");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const KEEP = args.includes("--keep");
const BASE_REV = flag("--base-rev") ?? "6700699";
const BASE_FILE = flag("--base");

// ---------------------------------------------------------------- postgres ---
function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const cfg = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (cfg.status === 0 && cfg.stdout.trim()) return cfg.stdout.trim();
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .map(Number)
      .filter((v) => !Number.isNaN(v))
      .sort((a, b) => b - a);
    if (versions.length) return join(base, String(versions[0]), "bin");
  }
  throw new Error("Postgres binaries not found; set PG_BIN=/path/to/pg/bin");
}
const PG_BIN = findPgBin();

// Postgres refuses to run as root. In that case drop to the `postgres` OS user.
let runAs = {};
if (typeof process.getuid === "function" && process.getuid() === 0) {
  const uid = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
  const gid = spawnSync("id", ["-g", "postgres"], { encoding: "utf8" });
  if (uid.status !== 0 || gid.status !== 0) {
    throw new Error("running as root and no `postgres` OS user exists to start the server as");
  }
  runAs = { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

const WORK = mkdtempSync(join(tmpdir(), "ffdrift-"));
if (runAs.uid !== undefined) chownSync(WORK, runAs.uid, runAs.gid);
const DATA = join(WORK, "data");
const PORT = process.env.FFDRIFT_PORT ?? "54199";

function pg(cmd, cmdArgs) {
  const r = spawnSync(join(PG_BIN, cmd), cmdArgs, { encoding: "utf8", cwd: WORK, ...runAs });
  if (r.status !== 0) {
    console.error(`${cmd} ${cmdArgs.join(" ")} failed:\n${r.stdout}${r.stderr}`);
    cleanup();
    process.exit(1);
  }
  return r;
}
function cleanup() {
  spawnSync(join(PG_BIN, "pg_ctl"), ["-D", DATA, "-m", "immediate", "stop"], { cwd: WORK, ...runAs });
  if (KEEP) console.log(`kept cluster at ${WORK} (socket dir, port ${PORT})`);
  else rmSync(WORK, { recursive: true, force: true });
}

pg("initdb", ["-D", DATA, "-A", "trust", "-U", "postgres", "--no-sync"]);
pg("pg_ctl", [
  "-D", DATA, "-w", "-l", join(WORK, "pg.log"),
  "-o", `-p ${PORT} -k ${WORK} -c listen_addresses= -c fsync=off`,
  "start",
]);

// ------------------------------------------------------------------- psql ---
function psql(db, extra, { allowFail = false } = {}) {
  const r = spawnSync(
    join(PG_BIN, "psql"),
    ["-h", WORK, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAt", "-X", ...extra],
    { encoding: "utf8" },
  );
  if (r.status !== 0 && !allowFail) {
    const err = (r.stderr || "").split("\n").filter((l) => /ERROR/.test(l)).join("\n");
    throw new Error(`psql on ${db} failed: ${extra.join(" ").slice(0, 80)}\n${err}`);
  }
  return r;
}
const sql = (db, q) => psql(db, ["-c", q]).stdout.trim();

let failures = 0;
function loadFile(db, label, file) {
  const r = psql(db, ["-f", file], { allowFail: true });
  if (r.status !== 0) {
    failures++;
    const err = (r.stderr || "").split("\n").filter((l) => /ERROR/.test(l)).join("\n");
    console.log(`FAIL  ${db}: ${label} did not load cleanly\n      ${err.replace(/\n/g, "\n      ")}`);
    return false;
  }
  return true;
}
function newDb(name) {
  sql("postgres", `drop database if exists ${name}`);
  sql("postgres", `create database ${name}`);
  loadFile(name, "stub", STUB);
}

// ------------------------------------------------------------- catalog dump ---
// One line per object. Function bodies are compared after stripping `--`
// comments and collapsing whitespace, so a re-flowed copy of the same function
// does not count as drift (the sqlSync unit test uses the same normalization).
// Column ordinal position is deliberately not compared: schema.sql folds some
// migration columns into the base CREATE TABLE, and nothing in the app or in
// PostgREST depends on ordinal positions.
const CATALOG_SQL = `
with fn as (
  select p.oid, n.nspname, p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '--[^\\n]*', ' ', 'g'), '\\s+', ' ', 'g') as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','storage')
)
select line from (
  select 'extension|' || extname as line from pg_extension where extname <> 'plpgsql'
  union all
  select 'enum|' || n.nspname || '.' || t.typname || '|' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
   where n.nspname = 'public' group by n.nspname, t.typname
  union all
  select 'table|' || n.nspname || '.' || c.relname || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity || '|kind=' || c.relkind::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v','m','p')
  union all
  select 'view|' || n.nspname || '.' || c.relname || '|' || regexp_replace(pg_get_viewdef(c.oid, true), '\\s+', ' ', 'g')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v','m')
  union all
  select 'column|' || n.nspname || '.' || c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
         || '|notnull=' || a.attnotnull || '|default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
         || '|identity=' || a.attidentity::text || '|generated=' || a.attgenerated::text
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind in ('r','v','m','p') and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint|' || n.nspname || '.' || c.relname || '|' || con.conname || '|' || pg_get_constraintdef(con.oid, true) || '|validated=' || con.convalidated
    from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
  union all
  select 'index|' || n.nspname || '.' || c.relname || '|' || i.relname || '|' || regexp_replace(pg_get_indexdef(i.oid), '\\s+', ' ', 'g')
    from pg_index x join pg_class c on c.oid = x.indrelid join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
  union all
  select 'sequence|' || n.nspname || '.' || c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'S'
  union all
  select 'function|' || nspname || '.' || proname || '(' || args || ')|' || md5(def) from fn
  union all
  select 'trigger|' || n.nspname || '.' || c.relname || '|' || t.tgname || '|' || regexp_replace(pg_get_triggerdef(t.oid, true), '\\s+', ' ', 'g')
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public','storage') and not t.tgisinternal
  union all
  select 'policy|' || schemaname || '.' || tablename || '|' || policyname || '|' || permissive || '|' || cmd
         || '|roles=' || array_to_string(roles, ',')
         || '|using=' || coalesce(regexp_replace(qual, '\\s+', ' ', 'g'), '')
         || '|check=' || coalesce(regexp_replace(with_check, '\\s+', ' ', 'g'), '')
    from pg_policies where schemaname in ('public','storage')
  union all
  select 'grant|' || n.nspname || '.' || c.relname || '|' || case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end || '|'
         || string_agg(g.privilege_type || case when g.is_grantable then '*' else '' end, ',' order by g.privilege_type)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) g
   where n.nspname = 'public' and c.relkind in ('r','v','m','p','S')
   group by n.nspname, c.relname, g.grantee
  union all
  select 'grant|' || fn.nspname || '.' || fn.proname || '(' || fn.args || ')|' || case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end || '|'
         || string_agg(g.privilege_type, ',' order by g.privilege_type)
    from fn join pg_proc p on p.oid = fn.oid, aclexplode(p.proacl) g
   group by fn.nspname, fn.proname, fn.args, g.grantee
  union all
  select 'grant|schema ' || n.nspname || '|' || case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end || '|'
         || string_agg(g.privilege_type, ',' order by g.privilege_type)
    from pg_namespace n, aclexplode(n.nspacl) g
   where n.nspname = 'public' group by n.nspname, g.grantee
  union all
  select 'comment|schema ' || n.nspname || '|' || d.description
    from pg_namespace n join pg_description d on d.objoid = n.oid and d.classoid = 'pg_namespace'::regclass
   where n.nspname = 'public'
  union all
  select 'comment|' || n.nspname || '.' || c.relname || case when d.objsubid > 0 then '.' || a.attname else '' end || '|' || d.description
    from pg_description d join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
   where n.nspname = 'public'
  union all
  select 'comment|' || fn.nspname || '.' || fn.proname || '(' || fn.args || ')|' || d.description
    from fn join pg_description d on d.objoid = fn.oid and d.classoid = 'pg_proc'::regclass
  union all
  select 'default-acl|' || coalesce(n.nspname, '-') || '|' || d.defaclobjtype::text || '|' || case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end || '|'
         || string_agg(g.privilege_type, ',' order by g.privilege_type)
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) g
   group by n.nspname, d.defaclobjtype, g.grantee
) s order by line;
`;
const catalog = (db) => new Set(psql(db, ["-c", CATALOG_SQL]).stdout.split("\n").filter(Boolean));

function diff(labelA, a, labelB, b) {
  const onlyA = [...a].filter((l) => !b.has(l));
  const onlyB = [...b].filter((l) => !a.has(l));
  if (!onlyA.length && !onlyB.length) {
    console.log(`PASS  ${labelB} == ${labelA} (${a.size} catalog entries)`);
    return;
  }
  failures++;
  console.log(`FAIL  ${labelB} != ${labelA}: ${onlyA.length} missing from ${labelB}, ${onlyB.length} extra in ${labelB}`);
  for (const l of onlyA) console.log(`  - ${l}`);
  for (const l of onlyB) console.log(`  + ${l}`);
}

// ----------------------------------------------------------------- builds ---
try {
  const migrations = readdirSync(join(SUPABASE, "migrations"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const schema = join(SUPABASE, "schema.sql");
  const combined = join(SUPABASE, "migrations_combined.sql");

  let base = BASE_FILE;
  if (!base) {
    const show = spawnSync("git", ["show", `${BASE_REV}:supabase/schema.sql`], { cwd: ROOT, encoding: "utf8" });
    if (show.status !== 0) throw new Error(`git show ${BASE_REV}:supabase/schema.sql failed:\n${show.stderr}`);
    // Only the base section counts: the historical schema.sql also folded in
    // copies of the early migrations (headed "... (migration 00NN)"), which the
    // real migrations then apply on top.
    const lines = show.stdout.split("\n");
    let cut = lines.findIndex((l) => /^-- .*\(migration 0\d{3}\)/.test(l));
    if (cut < 0) throw new Error(`no "(migration 00NN)" section marker found in schema.sql@${BASE_REV}`);
    while (cut > 0 && /^-- =+$/.test(lines[cut - 1])) cut--;
    base = join(WORK, "base-schema.sql");
    writeFileSync(base, lines.slice(0, cut).join("\n") + "\n");
  }

  console.log(`A  = base section of schema.sql@${BASE_FILE ? BASE_FILE : BASE_REV} + ${migrations.length} migrations (${migrations[0]} .. ${migrations.at(-1)})`);
  newDb("ffa");
  loadFile("ffa", "base schema", base);
  for (const m of migrations) if (!loadFile("ffa", m, join(SUPABASE, "migrations", m))) break;

  console.log("B  = schema.sql");
  newDb("ffb");
  loadFile("ffb", "schema.sql", schema);

  console.log("B2 = schema.sql x2");
  newDb("ffb2");
  loadFile("ffb2", "schema.sql", schema) && loadFile("ffb2", "schema.sql (2nd run)", schema);

  console.log("C  = schema.sql + migrations_combined.sql");
  newDb("ffc");
  loadFile("ffc", "schema.sql", schema) && loadFile("ffc", "migrations_combined.sql", combined);

  console.log("C2 = schema.sql + migrations_combined.sql x2");
  newDb("ffc2");
  loadFile("ffc2", "schema.sql", schema) &&
    loadFile("ffc2", "migrations_combined.sql", combined) &&
    loadFile("ffc2", "migrations_combined.sql (2nd run)", combined);

  const A = catalog("ffa");
  diff("A", A, "B", catalog("ffb"));
  diff("A", A, "B2", catalog("ffb2"));
  diff("A", A, "C", catalog("ffc"));
  diff("A", A, "C2", catalog("ffc2"));
} catch (e) {
  failures++;
  console.error(e instanceof Error ? e.message : e);
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} problem(s): the SQL snapshots have drifted from the migrations.` : "\nALL PASS: schema.sql, migrations_combined.sql and migrations/ build the same database.");
process.exit(failures ? 1 : 0);
