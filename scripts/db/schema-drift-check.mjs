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
// Then, on A, B and C, a runtime grant probe (0044): anon calls to the
// signed-in-only RPCs are refused, authenticated setter calls still persist,
// and the RLS helper functions stay callable by anon; and the agency/org
// isolation probe (orgIsolationProbe.mjs, 0052) acting as owners, seats and
// non-members.
// Plus the fan_checkins probe (0050): only the service role writes visits.
// And the app_errors probe (0053): admin-read/resolve only, server-write only.
// And the instant-rewards probe (0057): secrets server-only, and 20 concurrent
// spins on a 5-code prize hand out exactly 5 distinct codes.
// And the theming probe (0058, themeProbe.mjs): own-row theme writes from an
// allow-list only; creator_media owner-only, server-only inserts, capped at 12.
//
// Needs Postgres 16 binaries (initdb/pg_ctl/psql) on PATH, in $PG_BIN, or
// under /usr/lib/postgresql/*/bin. No TCP port is opened (unix socket only),
// and the data dir is deleted afterwards. When run as root (containers), the
// server is started as the `postgres` OS user because Postgres refuses root.
//
//   node scripts/db/schema-drift-check.mjs [--keep] [--base-rev <git-rev>] [--base <file>]
//
// Exit code 0 = all builds load, all catalogs match and the probe passes; 1 otherwise.

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeFocusLedger } from "./focusLedgerProbe.mjs";
import {probeRewardViews} from "./rewardViewsProbe.mjs";
import { ORG_PROBE_SQL, checkOrgProbe } from "./orgIsolationProbe.mjs";
import { APPROVAL_PROBE_SQL, checkApprovalProbe } from "./approvalProbe.mjs";
import { probeTheme } from "./themeProbe.mjs";
import { probeStorageWork, probeStorageSecurityRaces } from "./storageWorkProbe.mjs";
import { probeCryptoNamespace } from "./cryptoNamespaceProbe.mjs";

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
// Supabase installs pgcrypto in extensions; also retain the vanilla public layout.
const CRYPTO_SCHEMA = flag("--crypto-schema") ?? "extensions";
if (!["public", "extensions"].includes(CRYPTO_SCHEMA)) throw new Error("Unsupported crypto schema fixture");
const PSQL_ENV = { ...process.env, PGOPTIONS: "-c search_path=public,extensions,pg_temp" };

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
    { encoding: "utf8", env: PSQL_ENV },
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
  sql(name, `create schema extensions; create extension pgcrypto with schema ${CRYPTO_SCHEMA}; grant usage on schema extensions to public;`);
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

// ------------------------------------------------- runtime grant probe ---
// 0044: the signed-in-only RPCs must refuse anon and still work for
// authenticated, on every build path. The RLS helper functions must stay
// callable by anon, or anon reads that evaluate those policies would error.
const SIGNED_IN_ONLY = [
  "set_onboarding_dismissed(boolean)",
  "set_leaderboard_enabled(boolean)",
  "set_chat_settings(text, text)",
  "set_display_name(text)",
  "set_notification_prefs(boolean, boolean, boolean)",
  "set_public_profile(text, text, text)",
  "set_creator_note(text, text)",
  "set_notifications_seen()",
  "set_pwa_icon_mode(text)",
  "set_creator_theme(jsonb)",
  "admin_account_stats()",
  "admin_reserve_account_deletion(uuid)",
  "org_account_stats(uuid)",
  "org_create(text)",
  "org_invite_creator(uuid, text)",
  "org_invite_respond(uuid, boolean)",
  "org_invite_revoke(uuid)",
  "org_remove_creator(uuid, uuid)",
  "org_add_member(uuid, text, public.org_role)",
  "org_remove_member(uuid)",
  "org_scope_creator(uuid, uuid, boolean)",
];
const RLS_HELPERS = [
  "is_admin()", "can_act_for(uuid, text)", "current_user_active()", "_owns_org(uuid)",
  "_is_org_member(uuid)", "_owns_org_seat(uuid)",
];
const PROBE_UID = "00000000-0000-4000-8000-000000000044";

function probeGrants(db) {
  const bad = [];
  const priv = (role, sig) => sql(db, `select has_function_privilege('${role}', 'public.${sig}', 'execute')`) === "t";
  for (const sig of SIGNED_IN_ONLY) {
    if (priv("anon", sig)) bad.push(`anon can EXECUTE ${sig}`);
    if (!priv("authenticated", sig)) bad.push(`authenticated lost EXECUTE on ${sig}`);
  }
  //0059 retires the former signed-in import entrypoint. Neither the PUBLIC
  // ACL nor any API role may reach it outside the durable service gateway.
  const publicImport=sql(db, `select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname='public' and p.proname='import_fans' and a.grantee=0 and a.privilege_type='EXECUTE')`);
  if(publicImport!=="f")bad.push("PUBLIC retained EXECUTE on legacy import_fans");
  for(const role of ["anon","authenticated","service_role"]) {
    if(priv(role,"import_fans(jsonb)"))bad.push(`${role} retained EXECUTE on legacy import_fans`);
    const retired=psql(db,["-c",`begin;set local role ${role};select public.import_fans('[]'::jsonb);rollback;`],{allowFail:true});
    if(!/permission denied for function import_fans\b/.test(retired.stderr||""))bad.push(`${role} reached retired import_fans`);
  }
  for (const sig of RLS_HELPERS) if (!priv("anon", sig)) bad.push(`anon lost EXECUTE on RLS helper ${sig}`);

  // A real call as anon must fail with "permission denied for function".
  for (const sig of SIGNED_IN_ONLY) {
    const name = sig.slice(0, sig.indexOf("("));
    const types = sig.slice(sig.indexOf("(") + 1, -1).split(",").map((t) => t.trim()).filter(Boolean);
    const call = `public.${name}(${types.map((t) => `null::${t}`).join(", ")})`;
    const r = psql(db, ["-c", `begin; set local role anon; select ${call}; rollback;`], { allowFail: true });
    if (!new RegExp(`permission denied for function ${name}\\b`).test(r.stderr || "")) {
      bad.push(`anon call ${call} was not refused (${(r.stderr || "no error").trim().split("\n")[0]})`);
    }
  }

  // A real call as an authenticated creator still writes that creator's row.
  const r = psql(db, ["-c", `
    begin;
    insert into auth.users (id, email) values ('${PROBE_UID}', 'probe-0044@example.test');
    update public.profiles set approval_status = 'approved' where id = '${PROBE_UID}';
    set local role authenticated;
    select set_config('request.jwt.claim.sub', '${PROBE_UID}', true);
    select public.set_display_name('Probe 0044');
    select public.set_onboarding_dismissed(true);
    select public.set_leaderboard_enabled(true);
    select public.set_chat_settings('hi', 'bye');
    select public.set_notification_prefs(false, false, false);
    reset role;
    select display_name || '|' || onboarding_dismissed || '|' || leaderboard_enabled || '|' || chat_intro || '|' || chat_outro
           || '|' || notify_new_spin || notify_low_balance || notify_messages
      from public.profiles where id = '${PROBE_UID}';
    rollback;`], { allowFail: true });
  const got = (r.stdout || "").split("\n").filter(Boolean).at(-1);
  if (r.status !== 0 || got !== "Probe 0044|true|true|hi|bye|falsefalsefalse") {
    bad.push(`authenticated setter calls did not persist (got ${got ?? "nothing"}; ${(r.stderr || "").trim().split("\n")[0]})`);
  }

  // 0046 (RM-4): set_pwa_icon_mode writes ONLY the caller's own active row.
  // Creator A sets 'avatar'; creator B (and B's default) must be untouched; an
  // invalid value is refused; a suspended caller changes nothing; and a direct
  // UPDATE of the column by A is not even granted (profiles_update is admin-only).
  const A_UID = "00000000-0000-4000-8000-0000000046a0";
  const B_UID = "00000000-0000-4000-8000-0000000046b0";
  const asUser = (uid, stmt) =>
    `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${stmt} reset role;`;
  const pwa = psql(db, ["-c", `
    begin;
    insert into auth.users (id, email) values ('${A_UID}', 'probe-0046a@example.test'), ('${B_UID}', 'probe-0046b@example.test');
    update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A_UID}', '${B_UID}');
    ${asUser(A_UID, "select public.set_pwa_icon_mode('avatar');")}
    select 'after-a:' || (select pwa_icon_mode from public.profiles where id = '${A_UID}') || ',' || (select pwa_icon_mode from public.profiles where id = '${B_UID}');
    update public.profiles set is_active = false where id = '${B_UID}';
    ${asUser(B_UID, "select public.set_pwa_icon_mode('avatar');")}
    select 'suspended-b:' || (select pwa_icon_mode from public.profiles where id = '${B_UID}');
    rollback;`], { allowFail: true });
  const pwaOut = (pwa.stdout || "").split("\n").map((l) => l.trim());
  if (pwa.status !== 0 || !pwaOut.includes("after-a:avatar,neutral") || !pwaOut.includes("suspended-b:neutral")) {
    bad.push(`set_pwa_icon_mode is not own-row only (got ${pwaOut.filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${(pwa.stderr || "").trim().split("\n")[0]})`);
  }
  const pwaBad = psql(db, ["-c", `begin; insert into auth.users (id, email) values ('${A_UID}', 'probe-0046a@example.test'); update public.profiles set is_active = true, approval_status = 'approved' where id = '${A_UID}'; ${asUser(A_UID, "select public.set_pwa_icon_mode('selfie');")} rollback;`], { allowFail: true });
  if (!/invalid pwa_icon_mode/.test(pwaBad.stderr || "")) {
    bad.push(`set_pwa_icon_mode accepted an invalid value (${(pwaBad.stderr || "no error").trim().split("\n")[0]})`);
  }
  const pwaDirect = psql(db, ["-c", `begin; insert into auth.users (id, email) values ('${A_UID}', 'probe-0046a@example.test'), ('${B_UID}', 'probe-0046b@example.test'); set local role authenticated; select set_config('request.jwt.claim.sub', '${A_UID}', true); update public.profiles set pwa_icon_mode = 'avatar' where id = '${B_UID}'; reset role; select 'direct-b:' || pwa_icon_mode from public.profiles where id = '${B_UID}'; rollback;`], { allowFail: true });
  if (pwaDirect.status === 0 && !(pwaDirect.stdout || "").includes("direct-b:neutral")) {
    bad.push(`a creator's direct UPDATE changed another creator's pwa_icon_mode (${(pwaDirect.stdout || "").trim()})`);
  }

  bad.push(...probeBreaks(db, asUser));
  bad.push(...probeOutreach(db));
  // 0055: record_terms_acceptance is server-only. anon and authenticated can't
  // execute it; service_role writes exactly the row it names, with now(); and a
  // creator can't write the terms columns directly, for themselves or another.
  const TERMS_SIG = "record_terms_acceptance(uuid, text)";
  if (priv("anon", TERMS_SIG)) bad.push(`anon can EXECUTE ${TERMS_SIG}`);
  if (priv("authenticated", TERMS_SIG)) bad.push(`authenticated can EXECUTE ${TERMS_SIG}`);
  if (!priv("service_role", TERMS_SIG)) bad.push(`service_role lost EXECUTE on ${TERMS_SIG}`);
  const T_A = "00000000-0000-4000-8000-0000000055a0";
  const T_B = "00000000-0000-4000-8000-0000000055b0";
  const seedTerms = `insert into auth.users (id, email) values ('${T_A}', 'probe-0055a@example.test'), ('${T_B}', 'probe-0055b@example.test');`;
  for (const role of ["anon", "authenticated"]) {
    const r = psql(db, ["-c", `begin; ${seedTerms} set local role ${role}; select set_config('request.jwt.claim.sub', '${T_A}', true); select public.record_terms_acceptance('${T_B}', '2026-10-27'); rollback;`], { allowFail: true });
    if (!/permission denied for function record_terms_acceptance\b/.test(r.stderr || "")) {
      bad.push(`${role} call to record_terms_acceptance was not refused (${(r.stderr || "no error").trim().split("\n")[0]})`);
    }
  }
  const terms = psql(db, ["-c", `
    begin;
    ${seedTerms}
    set local role service_role;
    select public.record_terms_acceptance('${T_A}', '2026-10-27');
    reset role;
    select 'svc:' || coalesce(terms_version, '-') || ',' || (terms_accepted_at is not null) || '|' || coalesce((select terms_version from public.profiles where id = '${T_B}'), '-')
      from public.profiles where id = '${T_A}';
    rollback;`], { allowFail: true });
  const termsOut = (terms.stdout || "").split("\n").map((l) => l.trim());
  if (terms.status !== 0 || !termsOut.includes("svc:2026-10-27,true|-")) {
    bad.push(`record_terms_acceptance did not write exactly the named row (got ${termsOut.filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${(terms.stderr || "").trim().split("\n")[0]})`);
  }
  // A creator's direct UPDATE of the columns (own row or another's) must be
  // refused outright or change nothing (profiles_update is admin-only).
  const termsDirect = psql(db, ["-c", `begin; ${seedTerms} set local role authenticated; select set_config('request.jwt.claim.sub', '${T_A}', true); update public.profiles set terms_version = '2099-01-01', terms_accepted_at = '2000-01-01' where id in ('${T_A}', '${T_B}'); reset role; select 'direct:' || coalesce((select terms_version from public.profiles where id = '${T_A}'), '-') || ',' || coalesce((select terms_version from public.profiles where id = '${T_B}'), '-'); rollback;`], { allowFail: true });
  if (termsDirect.status === 0 && !(termsDirect.stdout || "").includes("direct:-,-")) {
    bad.push(`a creator's direct UPDATE changed terms_version (${(termsDirect.stdout || "").trim()})`);
  }
  const termsBad = psql(db, ["-c", `begin; ${seedTerms} set local role service_role; select public.record_terms_acceptance('${T_A}', 'latest'); rollback;`], { allowFail: true });
  if (!/invalid terms acceptance/.test(termsBad.stderr || "")) {
    bad.push(`record_terms_acceptance accepted a malformed version (${(termsBad.stderr || "no error").trim().split("\n")[0]})`);
  }
  bad.push(...probeTheme(db, psql).map((b) => `0058 theming: ${b}`));

  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: signed-in-only RPC grants / RM-6 break guard`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: anon refused on ${SIGNED_IN_ONLY.length} signed-in-only RPCs; legacy import denied to PUBLIC/all API roles; authenticated setters persist; set_pwa_icon_mode is own-row only; record_terms_acceptance is service-only; RLS helpers still anon-callable; RM-6 breaks only lengthen, block spins and stay fan-only; fan_outreach is tenant-isolated and append-only; creator theme/media are owner-scoped and allowlisted`);
  }
}

// 0049 (RM-6): a fan's break. Negative tests on a real Postgres:
//   * claim_spin refuses a fan on a break, and spins again once it has ended;
//   * fan_take_break only lengthens, and a token only reaches its own fan;
//   * nobody (service role included) can shorten a break in force;
//   * a creator's session can't set or clear break_until, even on its own fan;
//   * fan_take_break is server-only; fan_play_reminders is unreadable and
//     unwritable for a creator.
function probeBreaks(db, asUser) {
  const bad = [];
  const A = "00000000-0000-4000-8000-0000000049a0";
  const B = "00000000-0000-4000-8000-0000000049b0";
  const FA = "00000000-0000-4000-8000-0000000049fa";
  const FB = "00000000-0000-4000-8000-0000000049fb";
  const FC = "00000000-0000-4000-8000-0000000049fc";
  const seed = `
    set local fanfunnel.economic_write='on'; -- DB-owner fixture
    insert into auth.users (id, email) values ('${A}', 'probe-0049a@example.test'), ('${B}', 'probe-0049b@example.test');
    update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${B}');
    insert into public.wheels (id, creator_id, title) values
      ('00000000-0000-4000-8000-0000000049aa', '${A}', 'a'), ('00000000-0000-4000-8000-0000000049bb', '${B}', 'b');
    insert into public.fans (id, creator_id, display_name) values ('${FA}', '${A}', 'fa'), ('${FB}', '${B}', 'fb'), ('${FC}', '${A}', 'fc');
    insert into public.fan_passes (token, creator_id, wheel_id, fan_id, spins_remaining) values
      ('probe-0049-a', '${A}', '00000000-0000-4000-8000-0000000049aa', '${FA}', 3),
      ('probe-0049-b', '${B}', '00000000-0000-4000-8000-0000000049bb', '${FB}', 3),
      ('probe-0049-c', '${A}', '00000000-0000-4000-8000-0000000049aa', '${FC}', 3);
    update public.fans set acked_at=now(),acked_terms_version='2026-10-27' where id in ('${FA}','${FB}','${FC}');
    update public.fans set break_until = now() - interval '1 hour' where id = '${FC}';
    -- Supabase grants table privileges to anon/authenticated by default and
    -- leaves the rest to RLS; the stub does not, so model that here.
    grant select, insert, update, delete on public.fans, public.fan_play_reminders to anon, authenticated;`;
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n")[0];

  const r = psql(db, ["-c", `
    begin;
    ${seed}
    select 'take:' || (public.fan_take_break('probe-0049-a', now() + interval '1 day') = now() + interval '1 day');
    select 'shorter:' || (public.fan_take_break('probe-0049-a', now() + interval '1 hour') = now() + interval '1 day');
    select 'other-fan:' || coalesce((select break_until::text from public.fans where id = '${FB}'), 'none');
    select 'claim-on-break:' || (public.prepare_spin_attempt(gen_random_uuid(),'probe-0049-a',repeat('a',64))->>'error');
    select 'claim-other:' || (public.prepare_spin_attempt(gen_random_uuid(),'probe-0049-b',repeat('b',64))->>'status');
    select 'claim-ended:' || (public.prepare_spin_attempt(gen_random_uuid(),'probe-0049-c',repeat('c',64))->>'status');
    select 'restart:' || (public.fan_take_break('probe-0049-c', now() + interval '7 days') = now() + interval '7 days');
    select 'unknown:' || coalesce(public.fan_take_break('probe-0049-nope', now() + interval '1 day')::text, 'null');
    rollback;`], { allowFail: true });
  const want = ["take:true", "shorter:true", "other-fan:none", "claim-on-break:on_break", "claim-other:ready", "claim-ended:ready", "restart:true", "unknown:null"];
  const got = out(r);
  const missing = want.filter((w) => !got.includes(w));
  if (r.status !== 0 || missing.length) {
    bad.push(`break lifecycle wrong (missing ${missing.join(", ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" ")}; ${err(r)})`);
  }

  const onBreak = `${seed} select public.fan_take_break('probe-0049-a', now() + interval '1 day');`;
  const shorten = psql(db, ["-c", `begin; ${onBreak} update public.fans set break_until = now() where id = '${FA}'; rollback;`], { allowFail: true });
  if (!/a break cannot be shortened/.test(shorten.stderr || "")) bad.push(`the service role shortened a break (${err(shorten)})`);
  const lift = psql(db, ["-c", `begin; ${onBreak} update public.fans set break_until = null where id = '${FA}'; rollback;`], { allowFail: true });
  if (!/a break cannot be shortened/.test(lift.stderr || "")) bad.push(`the service role lifted a break (${err(lift)})`);
  for (const [label, stmt] of [
    ["clear its fan's break", `update public.fans set break_until = null where id = '${FA}';`],
    ["set a break on its fan", `update public.fans set break_until = now() + interval '30 days' where id = '${FC}';`],
  ]) {
    const c = psql(db, ["-c", `begin; ${onBreak} ${asUser(A, stmt)} rollback;`], { allowFail: true });
    if (!/break_until is set by the fan only/.test(c.stderr || "")) bad.push(`a creator session could ${label} (${err(c)})`);
  }

  const priv = (role) => sql(db, `select has_function_privilege('${role}', 'public.fan_take_break(text, timestamptz)', 'execute')`) === "t";
  if (priv("anon")) bad.push("anon can EXECUTE fan_take_break");
  if (priv("authenticated")) bad.push("authenticated can EXECUTE fan_take_break");
  if (!priv("service_role")) bad.push("service_role cannot EXECUTE fan_take_break");

  const rem = psql(db, ["-c", `
    begin;
    ${seed}
    insert into public.fan_play_reminders (fan_id, daily) values ('${FA}', 50);
    set local role authenticated;
    select set_config('request.jwt.claim.sub', '${A}', true);
    select 'creator-reads:' || count(*) from public.fan_play_reminders;
    reset role;
    rollback;`], { allowFail: true });
  if (!out(rem).includes("creator-reads:0")) bad.push(`a creator can read fan_play_reminders (${out(rem).filter((l) => /:/.test(l)).join(" ")}; ${err(rem)})`);
  const remWrite = psql(db, ["-c", `begin; ${seed} ${asUser(A, `insert into public.fan_play_reminders (fan_id, daily) values ('${FA}', 20);`)} rollback;`], { allowFail: true });
  if (!/row-level security|permission denied/.test(remWrite.stderr || "")) bad.push(`a creator could write fan_play_reminders (${err(remWrite)})`);
  return bad;
}

// 0050 (RM-3): fan_checkins is written ONLY by the service role. Supabase's
// default table grants are emulated (granted inside the transaction), so this
// proves RLS alone stops a creator or anon from writing a visit, and that a
// creator reads only their own fans' visits ('view' survives a suspension by
// design, as on fans; another creator's rows never show).
const CK_A = "00000000-0000-4000-8000-0000000050a0";
const CK_B = "00000000-0000-4000-8000-0000000050b0";
const CK_FAN_A = "00000000-0000-4000-8000-0000000050fa";
const CK_FAN_B = "00000000-0000-4000-8000-0000000050fb";
const CK_SEED = `
  insert into auth.users (id, email) values ('${CK_A}', 'probe-0050a@example.test'), ('${CK_B}', 'probe-0050b@example.test');
  update public.profiles set is_active = true, approval_status = 'approved' where id in ('${CK_A}', '${CK_B}');
  insert into public.fans (id, creator_id, display_name) values ('${CK_FAN_A}', '${CK_A}', 'A fan'), ('${CK_FAN_B}', '${CK_B}', 'B fan');
  insert into public.fan_checkins (fan_id, creator_id, day) values
    ('${CK_FAN_A}', '${CK_A}', current_date), ('${CK_FAN_B}', '${CK_B}', current_date), ('${CK_FAN_B}', '${CK_B}', current_date - 1);
  grant select, insert, update, delete on public.fan_checkins to anon, authenticated;`;
const ckAs = (uid, stmt) =>
  uid
    ? `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${stmt} reset role;`
    : `set local role anon; select set_config('request.jwt.claim.sub', '', true); ${stmt} reset role;`;

function probeCheckins(db) {
  const bad = [];
  const run = (stmts) => psql(db, ["-c", `begin; ${CK_SEED} ${stmts} rollback;`], { allowFail: true });
  const reads = run(`
    ${ckAs(CK_A, "select 'a-sees:' || count(*) from public.fan_checkins;")}
    ${ckAs(CK_A, "select 'a-sees-b:' || count(*) from public.fan_checkins where creator_id = '" + CK_B + "';")}
    ${ckAs(null, "select 'anon-sees:' || count(*) from public.fan_checkins;")}
    ${ckAs(CK_A, "update public.fan_checkins set day = day - 30 where creator_id = '" + CK_B + "';")}
    ${ckAs(CK_A, "delete from public.fan_checkins where creator_id = '" + CK_B + "';")}
    select 'b-rows:' || count(*) from public.fan_checkins where creator_id = '${CK_B}' and day >= current_date - 1;
    update public.profiles set is_active = false where id = '${CK_A}';
    ${ckAs(CK_A, "select 'suspended-a-sees-b:' || count(*) from public.fan_checkins where creator_id = '" + CK_B + "';")}`);
  const out = (reads.stdout || "").split("\n").map((l) => l.trim());
  for (const want of ["a-sees:1", "a-sees-b:0", "anon-sees:0", "b-rows:2", "suspended-a-sees-b:0"]) {
    if (!out.includes(want)) bad.push(`expected ${want} (got ${out.filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${(reads.stderr || "").trim().split("\n")[0]})`);
  }
  for (const [who, uid] of [["creator A", CK_A], ["anon", null]]) {
    const ins = run(ckAs(uid, `insert into public.fan_checkins (fan_id, creator_id, day) values ('${CK_FAN_A}', '${CK_A}', current_date + 1);`));
    if (!/row-level security|permission denied/.test(ins.stderr || "")) {
      bad.push(`${who} could INSERT a check-in (${(ins.stderr || "no error").trim().split("\n")[0]})`);
    }
  }
  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: fan_checkins (0050)`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: fan_checkins is select-only for its creator; creator and anon INSERT refused; cross-tenant rows untouched`);
  }
}

// 0051 (RM-5): the win-back outreach log. Creator A can log and read outreach
// for A's own fan only: never with B's creator_id, never for B's fan or with
// B's template, never reading B's rows, never updating or deleting (no such
// policy), and not at all once suspended. Anon has no table privilege.
// Supabase grants table privileges to authenticated by default; the stub does
// not, so the probe grants them inside its own (rolled-back) transaction.
function probeOutreach(db) {
  const bad = [];
  const A = "00000000-0000-4000-8000-0000000051a0";
  const B = "00000000-0000-4000-8000-0000000051b0";
  const FA = "00000000-0000-4000-8000-0000000051fa";
  const FB = "00000000-0000-4000-8000-0000000051fb";
  const TB = "00000000-0000-4000-8000-0000000051eb";
  const asUser = (uid, stmt) =>
    `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${stmt} reset role;`;
  const setup = `
    begin;
    grant select, insert, update, delete on public.fan_outreach, public.fans, public.dm_templates to authenticated;
    insert into auth.users (id, email) values ('${A}', 'probe-0051a@example.test'), ('${B}', 'probe-0051b@example.test');
    update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${B}');
    insert into public.fans (id, creator_id, display_name) values ('${FA}', '${A}', 'A fan'), ('${FB}', '${B}', 'B fan');
    insert into public.dm_templates (id, creator_id, title, body) values ('${TB}', '${B}', 'B', 'hi');
    insert into public.fan_outreach (creator_id, fan_id, contacted_at) values ('${B}', '${FB}', now());`;
  const run = (body) => psql(db, ["-c", `${setup} ${body} rollback;`], { allowFail: true });
  const refused = (r) => r.status !== 0 && /row-level security|permission denied/.test(r.stderr || "");

  const own = run(`
    ${asUser(A, `insert into public.fan_outreach (creator_id, fan_id, contacted_at) values ('${A}', '${FA}', now());`)}
    ${asUser(A, `insert into public.fan_outreach (creator_id, fan_id, snoozed_until) values ('${A}', '${FA}', now() + interval '30 days');`)}
    ${asUser(A, `select 'own-read:' || count(*) from public.fan_outreach;`)}
    ${asUser(A, `with u as (update public.fan_outreach set snoozed_until = null returning 1) select 'own-update:' || count(*) from u;`)}
    ${asUser(A, `with d as (delete from public.fan_outreach returning 1) select 'own-delete:' || count(*) from d;`)}
    select 'b-rows:' || count(*) from public.fan_outreach where creator_id = '${B}';`);
  const out = (own.stdout || "").split("\n").map((l) => l.trim());
  if (own.status !== 0) bad.push(`creator A could not log outreach for A's own fan (${(own.stderr || "").trim().split("\n")[0]})`);
  else {
    if (!out.includes("own-read:2")) bad.push(`creator A should read exactly its own 2 outreach rows, not B's (got ${out.find((l) => l.startsWith("own-read:"))})`);
    if (!out.includes("own-update:0")) bad.push("creator A could UPDATE an outreach row (log must be append-only)");
    if (!out.includes("own-delete:0")) bad.push("creator A could DELETE an outreach row (log must be append-only)");
    if (!out.includes("b-rows:1")) bad.push("creator B's outreach row changed while A acted");
  }
  if (!refused(run(asUser(A, `insert into public.fan_outreach (creator_id, fan_id, contacted_at) values ('${B}', '${FB}', now());`))))
    bad.push("creator A could log outreach under creator B's id");
  if (!refused(run(asUser(A, `insert into public.fan_outreach (creator_id, fan_id, contacted_at) values ('${A}', '${FB}', now());`))))
    bad.push("creator A could log outreach for creator B's fan");
  if (!refused(run(asUser(A, `insert into public.fan_outreach (creator_id, fan_id, template_id, contacted_at) values ('${A}', '${FA}', '${TB}', now());`))))
    bad.push("creator A could attach creator B's DM template to an outreach row");
  const empty = run(asUser(A, `insert into public.fan_outreach (creator_id, fan_id) values ('${A}', '${FA}');`));
  if (!(empty.status !== 0 && /fan_outreach_has_action/.test(empty.stderr || "")))
    bad.push("an outreach row with neither contacted_at nor snoozed_until was accepted");
  const suspended = run(`
    update public.profiles set is_active = false where id = '${A}';
    insert into public.fan_outreach (creator_id, fan_id, contacted_at) values ('${A}', '${FA}', now());
    ${asUser(A, `select 'suspended-read:' || count(*) from public.fan_outreach;`)}`);
  if (!(suspended.stdout || "").includes("suspended-read:0")) bad.push(`a suspended creator can still read its outreach log (${(suspended.stdout || suspended.stderr || "").trim().split("\n").pop()})`);
  if (!refused(run(`update public.profiles set is_active = false where id = '${A}'; ${asUser(A, `insert into public.fan_outreach (creator_id, fan_id, contacted_at) values ('${A}', '${FA}', now());`)}`)))
    bad.push("a suspended creator can still log outreach");
  const anon = psql(db, ["-c", "begin; set local role anon; select count(*) from public.fan_outreach; rollback;"], { allowFail: true });
  if (!/permission denied for table fan_outreach/.test(anon.stderr || "")) bad.push("anon is not refused on fan_outreach");
  return bad;
}

// ------------------------------------------------- org isolation probe ---
// 0052 / audit A2: agency seats and org membership never cross tenants.
function probeOrgIsolation(db) {
  const r = psql(db, ["-c", ORG_PROBE_SQL], { allowFail: true });
  const bad = r.status === 0 ? checkOrgProbe(r.stdout) : [`probe did not run: ${(r.stderr || "").trim().split("\n")[0]}`];
  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: agency/org isolation`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: agency/org isolation (seats see only their org's / scoped creators; non-members cannot join an org, seat, scope or invite; suspended owners, seats and invitees are refused)`);
  }
}

// ------------------------------------------- app_errors probe (0053) ---
// Error monitoring is admin-read, server-write. On a real Postgres: anon has no
// access at all; a signed-in creator reads 0 rows, cannot insert, cannot resolve
// and cannot call either RPC; an ACTIVE admin reads and resolves but cannot edit
// any other column; the service role upserts by fingerprint, reopens a resolved
// error, prunes to the row cap and is throttled by the alert budget.
const ERR_FP = "0123456789abcdef0123456789abcdef";
const ADMIN_UID = "00000000-0000-4000-8000-0000000053a0";
const CREATOR_UID = "00000000-0000-4000-8000-0000000053c0";

function probeAppErrors(db) {
  const bad = [];
  const seed = `
    insert into auth.users (id, email) values ('${ADMIN_UID}', 'probe-0053a@example.test'), ('${CREATOR_UID}', 'probe-0053c@example.test');
    update public.profiles set is_active = true, approval_status = 'approved' where id in ('${ADMIN_UID}', '${CREATOR_UID}');
    update public.profiles set role = 'admin' where id = '${ADMIN_UID}';
    set local role service_role;
    select public.record_app_error('${ERR_FP}', 'production', 'client', 'probe boom');
    reset role;`;
  const as = (uid, stmt, aal = uid === ADMIN_UID ? "aal2" : "aal1") =>
    `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ` +
    `select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated","aal":"${aal}"}', true); ${stmt}; reset role;`;
  const run = (body) => psql(db, ["-c", `begin; ${seed} ${body} rollback;`], { allowFail: true });
  const lastLine = (r) => (r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  const firstErr = (r) => (r.stderr || "no error").trim().split("\n")[0];

  const denied = (label, body, re = /permission denied/) => {
    const r = run(body);
    if (!re.test(r.stderr || "")) bad.push(`${label} was not refused (${r.status === 0 ? "succeeded" : firstErr(r)})`);
  };
  denied("anon SELECT app_errors", "set local role anon; select count(*) from public.app_errors;");
  denied("anon INSERT app_errors", `set local role anon; insert into public.app_errors (fingerprint, environment, source, message) values ('${ERR_FP}', 'preview', 'client', 'x');`);
  denied("anon SELECT app_error_alerts", "set local role anon; select count(*) from public.app_error_alerts;");
  denied("anon record_app_error()", `set local role anon; select public.record_app_error('${ERR_FP}', 'production', 'client', 'x');`, /permission denied for function record_app_error/);
  denied("anon claim_app_error_alert()", "set local role anon; select public.claim_app_error_alert(10);", /permission denied for function claim_app_error_alert/);
  denied("creator INSERT app_errors", as(CREATOR_UID, `insert into public.app_errors (fingerprint, environment, source, message) values ('${ERR_FP}', 'preview', 'client', 'x')`));
  denied("creator DELETE app_errors", as(CREATOR_UID, "delete from public.app_errors"));
  denied("creator record_app_error()", as(CREATOR_UID, `select public.record_app_error('${ERR_FP}', 'production', 'client', 'x')`), /permission denied for function record_app_error/);
  denied("creator claim_app_error_alert()", as(CREATOR_UID, "select public.claim_app_error_alert(10)"), /permission denied for function claim_app_error_alert/);
  denied("admin UPDATE of app_errors.count (resolve-only grant)", as(ADMIN_UID, "update public.app_errors set count = 99"));
  denied("admin INSERT app_errors", as(ADMIN_UID, `insert into public.app_errors (fingerprint, environment, source, message) values ('${ERR_FP}', 'preview', 'client', 'x')`));

  const creator = run(`
    ${as(CREATOR_UID, "select 'creator-sees:' || count(*) from public.app_errors")}
    ${as(CREATOR_UID, "update public.app_errors set resolved = true")}
    select 'after-creator:' || bool_or(resolved) from public.app_errors;`);
  const cOut = (creator.stdout || "").split("\n").map((l) => l.trim());
  if (creator.status !== 0 || !cOut.includes("creator-sees:0") || !cOut.includes("after-creator:false")) {
    bad.push(`a creator could read or resolve app_errors (got ${cOut.filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${firstErr(creator)})`);
  }

  const suspended = run(`
    update public.profiles set is_active = false where id = '${ADMIN_UID}';
    ${as(ADMIN_UID, "select 'suspended-sees:' || count(*) from public.app_errors")}`);
  if (lastLine(suspended) !== "suspended-sees:0") bad.push(`a suspended admin can read app_errors (${lastLine(suspended) ?? firstErr(suspended)})`);

  const passwordOnlyAdmin = run(`
    ${as(ADMIN_UID, "select 'aal1-sees:' || count(*) from public.app_errors", "aal1")}
    ${as(ADMIN_UID, "update public.app_errors set resolved = true, resolved_at = now()", "aal1")}
    select 'after-aal1:' || bool_or(resolved) from public.app_errors;`);
  const lowAssuranceOutput = (passwordOnlyAdmin.stdout || "").split("\n").map((l) => l.trim());
  if (passwordOnlyAdmin.status !== 0 || !lowAssuranceOutput.includes("aal1-sees:0") || !lowAssuranceOutput.includes("after-aal1:false")) {
    bad.push(`a password-only admin could read or resolve app_errors (${firstErr(passwordOnlyAdmin)})`);
  }

  const admin = run(`
    ${as(ADMIN_UID, "select 'admin-sees:' || count(*) from public.app_errors")}
    ${as(ADMIN_UID, "update public.app_errors set resolved = true, resolved_at = now()")}
    select 'after-admin:' || bool_and(resolved) from public.app_errors;`);
  const aOut = (admin.stdout || "").split("\n").map((l) => l.trim());
  if (admin.status !== 0 || !aOut.includes("admin-sees:1") || !aOut.includes("after-admin:true")) {
    bad.push(`an active admin could not read + resolve (got ${aOut.filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${firstErr(admin)})`);
  }

  const svc = run(`
    set local role service_role;
    select 'repeat:' || (r->>'is_new') || ',' || (r->>'reopened') || ',' || (r->>'count') from (select public.record_app_error('${ERR_FP}', 'production', 'client', 'probe boom') r) s;
    reset role;
    update public.app_errors set resolved = true;
    set local role service_role;
    select 'reopen:' || (r->>'is_new') || ',' || (r->>'reopened') || ',' || (r->>'count') from (select public.record_app_error('${ERR_FP}', 'production', 'client', 'probe boom') r) s;
    select 'other-env:' || (r->>'is_new') from (select public.record_app_error('${ERR_FP}', 'preview', 'client', 'probe boom') r) s;
    reset role;
    select set_config('probe.prod', (select id::text from public.app_errors where environment = 'production'), true) is not null;
    select set_config('probe.prev', (select id::text from public.app_errors where environment = 'preview'), true) is not null;
    set local role service_role;
    select 'claim1:' || (public.claim_app_error_alert(2, current_setting('probe.prod')::uuid)->>'send');
    select 'claim2:' || (public.claim_app_error_alert(2, current_setting('probe.prod')::uuid)->>'send');
    select 'claim3:' || (public.claim_app_error_alert(2, current_setting('probe.prev')::uuid)->>'send');
    select 'digest-throttled:' || (public.claim_app_error_alert(2)->>'send');
    reset role;
    select 'pending:' || count(*) from public.app_errors where alert_pending;
    delete from public.app_error_alerts;
    set local role service_role;
    select 'digest:' || (r->>'send') || ',' || (r->>'pending') from (select public.claim_app_error_alert(2) r) s;
    select 'prune:' || (r->>'is_new') from (select public.record_app_error('fedcba9876543210fedcba9876543210', 'production', 'server', 'other', null, null, null, 1) r) s;
    reset role;
    select 'rows:' || count(*) from public.app_errors;`);
  const sOut = (svc.stdout || "").split("\n").map((l) => l.trim());
  const want = [
    "repeat:false,false,2",
    "reopen:false,true,3",
    "other-env:true",
    "claim1:true",
    "claim2:true",
    "claim3:false",
    "digest-throttled:false",
    "pending:1",
    "digest:true,1",
    "prune:true",
    "rows:1",
  ];
  const missing = want.filter((w) => !sOut.includes(w));
  if (svc.status !== 0 || missing.length) {
    bad.push(`service-role upsert/throttle/prune misbehaved (missing ${missing.join(" ")}; got ${sOut.filter((l) => /:/.test(l)).join(" ")}; ${firstErr(svc)})`);
  }

  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: app_errors access + behaviour`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: app_errors is admin-read/resolve only, server-write only; upsert, reopen, throttle and prune behave`);
  }
}

// ------------------------------------------- 0054 privacy & safety probe ---
// The audit log is admin+aal2 read-only and server-written; creator notices are
// own-account only; tombstones and the two server-only functions are out of
// reach of anon/authenticated; is_admin() needs aal2; the self-close guard
// keeps the last admin; deleting a fan anonymizes (keeps) its spins; and the
// retention job deletes only what is past its period.
const PS = {
  A: "00000000-0000-4000-8000-0000000054a0",
  B: "00000000-0000-4000-8000-0000000054b0",
  ADM: "00000000-0000-4000-8000-0000000054d0",
  ADM2: "00000000-0000-4000-8000-0000000054d2",
  WHEEL: "00000000-0000-4000-8000-0000000054e0",
  PRIZE: "00000000-0000-4000-8000-0000000054f0",
  FAN: "00000000-0000-4000-8000-000000005401",
  PASS: "00000000-0000-4000-8000-000000005402",
  SPIN: "00000000-0000-4000-8000-000000005403",
  RED: "00000000-0000-4000-8000-000000005404",
  ORG: "00000000-0000-4000-8000-000000005405",
};
const PS_SETUP = `
  set local fanfunnel.economic_write='on'; -- DB-owner historical fixture only
  insert into auth.users (id, email) values
    ('${PS.A}', 'probe-0054a@example.test'), ('${PS.B}', 'probe-0054b@example.test'),
    ('${PS.ADM}', 'probe-0054adm@example.test'), ('${PS.ADM2}', 'probe-0054adm2@example.test');
  update public.profiles set is_active = true, approval_status = 'approved' where id in ('${PS.A}', '${PS.B}', '${PS.ADM}', '${PS.ADM2}');
  update public.profiles set role = 'admin' where id = '${PS.ADM}';
  insert into public.wheels (id, creator_id, title) values ('${PS.WHEEL}', '${PS.A}', 'probe');
  insert into public.prizes (id, wheel_id, label, rarity, weight) values ('${PS.PRIZE}', '${PS.WHEEL}', 'p', 'common', 10);
  insert into public.fans (id, creator_id, display_name) values ('${PS.FAN}', '${PS.A}', 'probe fan');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values ('${PS.PASS}', 'probe-0054-token', '${PS.A}', '${PS.WHEEL}', '${PS.FAN}');
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity)
    values ('${PS.SPIN}', '${PS.PASS}', '${PS.A}', '${PS.WHEEL}', '${PS.FAN}', '${PS.PRIZE}', 'p', 'common');
  insert into public.redemptions (id, creator_id, spin_id) values ('${PS.RED}', '${PS.A}', '${PS.SPIN}');
  insert into public.admin_audit_log (actor_id, action, target_type, target_id) values ('${PS.ADM}', 'probe.entry', 'profile', '${PS.A}');
  insert into public.creator_notices (creator_id, kind) values ('${PS.A}', 'fan_deleted_data'), ('${PS.B}', 'fan_deleted_data');
  insert into public.link_tombstones (token_hash, reason) values (repeat('a', 64), 'creator_closed');
`;
const asJwt = (uid, aal) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ` +
  `select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated","aal":"${aal}"}', true);`;

function probePrivacy(db) {
  const bad = [];
  const lines = (r) => (r.stdout || "").split("\n").map((l) => l.trim()).filter((l) => /^[\w-]+:/.test(l));
  const expectLines = (label, body, want) => {
    const r = psql(db, ["-c", `begin; ${PS_SETUP} ${body} rollback;`], { allowFail: true });
    const got = lines(r);
    for (const w of want) if (!got.includes(w)) bad.push(`${label}: expected "${w}" (got ${got.join(" ") || "nothing"}; ${(r.stderr || "").trim().split("\n")[0]})`);
  };
  const expectError = (label, body, re) => {
    const r = psql(db, ["-c", `begin; ${PS_SETUP} ${body} rollback;`], { allowFail: true });
    if (!re.test(r.stderr || "")) bad.push(`${label}: was not refused (${(r.stderr || "no error").trim().split("\n")[0]})`);
  };

  // Reads: only an aal2 admin sees the log; aal1 is not an admin; notices are own-account.
  expectLines("reads", `
    ${asJwt(PS.ADM, "aal1")} select 'adm1-isadmin:' || public.is_admin(); select 'adm1-audit:' || count(*) from public.admin_audit_log; reset role;
    ${asJwt(PS.ADM, "aal2")} select 'adm2-isadmin:' || public.is_admin(); select 'adm2-audit:' || count(*) from public.admin_audit_log; reset role;
    ${asJwt(PS.A, "aal2")} select 'a-isadmin:' || public.is_admin(); select 'a-audit:' || count(*) from public.admin_audit_log; select 'a-notices:' || count(*) from public.creator_notices; reset role;
    ${asJwt(PS.B, "aal1")} select 'b-notices:' || count(*) from public.creator_notices where creator_id = '${PS.A}'; reset role;
    ${asJwt(PS.ADM, "aal1")} select 'adm1-reserve:' || public.admin_reserve_account_deletion('${PS.B}'); reset role;
  `, ["adm1-isadmin:false", "adm1-audit:0", "adm2-isadmin:true", "adm2-audit:1", "a-isadmin:false", "a-audit:0", "a-notices:1", "b-notices:0", "adm1-reserve:forbidden"]);

  // Writes and server-only functions are refused to anon and authenticated.
  const denied = /permission denied/;
  expectError("creator inserts an audit entry", `${asJwt(PS.A, "aal2")} insert into public.admin_audit_log (action) values ('x.forged');`, denied);
  expectError("aal2 admin inserts an audit entry", `${asJwt(PS.ADM, "aal2")} insert into public.admin_audit_log (action) values ('x.forged');`, denied);
  expectError("aal2 admin deletes audit entries", `${asJwt(PS.ADM, "aal2")} delete from public.admin_audit_log;`, denied);
  expectError("anon reads the audit log", `set local role anon; select count(*) from public.admin_audit_log;`, denied);
  expectError("creator inserts a notice", `${asJwt(PS.A, "aal2")} insert into public.creator_notices (creator_id, kind) values ('${PS.A}', 'fan_deleted_data');`, denied);
  expectError("creator reads tombstones", `${asJwt(PS.A, "aal2")} select count(*) from public.link_tombstones;`, denied);
  expectError("anon reads tombstones", `set local role anon; select count(*) from public.link_tombstones;`, denied);
  for (const [who, role] of [["anon", "set local role anon;"], ["authenticated", asJwt(PS.ADM, "aal2")]]) {
    expectError(`${who} runs reserve_self_account_deletion`, `${role} select public.reserve_self_account_deletion('${PS.ADM}');`, /permission denied for function reserve_self_account_deletion/);
    expectError(`${who} runs run_retention_cleanup`, `${role} select public.run_retention_cleanup(365, 90, 365, 90, 90);`, /permission denied for function run_retention_cleanup/);
  }
  expectError("an audit entry is rewritten (even by the owner)", `update public.admin_audit_log set action = 'x.rewritten';`, /append-only/);

  // Server paths (service role): last-admin guard, fan delete anonymizes, retention.
  expectLines("service role", `
    set local role service_role;
    select 'self-last:' || public.reserve_self_account_deletion('${PS.ADM}');
    reset role;
    update public.profiles set role = 'admin' where id = '${PS.ADM2}';
    set local role service_role;
    select 'self-two:' || public.reserve_self_account_deletion('${PS.ADM}');
    select 'self-creator:' || public.reserve_self_account_deletion('${PS.A}');
    reset role;
    select 'adm-role:' || role from public.profiles where id = '${PS.ADM}';
    delete from public.fans where id = '${PS.FAN}';
    select 'spin-kept:' || coalesce(fan_id::text, 'null') || ',' || coalesce(fan_pass_id::text, 'null') from public.spins where id = '${PS.SPIN}';
    select 'redemption-kept:' || count(*) from public.redemptions where id = '${PS.RED}';
    insert into public.admin_audit_log (action, created_at) values ('probe.old', now() - interval '400 days');
    insert into public.creator_notices (creator_id, kind, created_at) values ('${PS.A}', 'fan_deleted_data', now() - interval '100 days');
    insert into public.link_tombstones (token_hash, reason, created_at) values (repeat('b', 64), 'fan_deleted', now() - interval '400 days');
    insert into public.orgs (id, name, owner_id) values ('${PS.ORG}', 'probe org', '${PS.B}');
    insert into public.org_invites (org_id, email, status, created_at) values
      ('${PS.ORG}', 'old-declined@example.test', 'declined', now() - interval '100 days'),
      ('${PS.ORG}', 'old-revoked@example.test', 'revoked', now() - interval '100 days'),
      ('${PS.ORG}', 'old-pending@example.test', 'pending', now() - interval '100 days'),
      ('${PS.ORG}', 'new-declined@example.test', 'declined', now() - interval '5 days');
    insert into public.app_errors (fingerprint, environment, source, message, first_seen, resolved, resolved_at) values
      (repeat('c', 32), 'preview', 'server', 'old resolved probe', now() - interval '130 days', true, now() - interval '100 days'),
      (repeat('d', 32), 'preview', 'server', 'recent resolved probe', now() - interval '130 days', true, now() - interval '5 days'),
      (repeat('e', 32), 'preview', 'server', 'old unresolved probe', now() - interval '130 days', false, null);
    insert into public.push_log (user_id, item_id, tag, sent_at) values
      ('${PS.A}', 'old-a', 'old-a', now() - interval '36 days'),
      ('${PS.A}', 'recent-a', 'recent-a', now() - interval '5 days'),
      ('${PS.B}', 'old-inactive-b', 'old-inactive-b', now() - interval '36 days');
    update public.profiles set is_active = false where id = '${PS.B}';
    set local role service_role;
    select 'retention:' || public.run_retention_cleanup(365, 90, 365, 90, 90)::text;
    reset role;
    select 'left:' || (select count(*) from public.admin_audit_log) || ',' || (select count(*) from public.creator_notices) || ',' || (select count(*) from public.link_tombstones);
    select 'invites-left:' || string_agg(email, ',' order by email) from public.org_invites where org_id = '${PS.ORG}';
    select 'errors-left:' || string_agg(fingerprint, ',' order by fingerprint) from public.app_errors;
    select 'push-left:' || string_agg(item_id, ',' order by item_id) from public.push_log;
  `, [
    "self-last:last_admin", "self-two:ok", "self-creator:ok", "adm-role:creator",
    "spin-kept:null,null", "redemption-kept:1",
    `retention:{"push_log": 2, "app_errors": 1, "org_invites": 2, "admin_audit_log": 1, "creator_notices": 1, "link_tombstones": 1}`,
    "left:1,2,1",
    "invites-left:new-declined@example.test,old-pending@example.test",
    `errors-left:${"d".repeat(32)},${"e".repeat(32)}`,
    "push-left:recent-a",
  ]);
  expectError("retention with a 0-day period", `set local role service_role; select public.run_retention_cleanup(0, 90, 365, 90, 90);`, /at least 1 day/);

  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: 0054 privacy & safety probe`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: 0054 audit log admin+aal2 read-only, notices own-account, tombstones + server-only fns locked, last-admin self-close guard, fan delete keeps anonymized spins, retention by period (closed agency invites too)`);
  }
}

// ------------------------------------------------------ web push probe ---
// 0056: push_subscriptions is own-devices-only and push_log is service-only.
// As creator A: A sees, updates (show_details only) and deletes ONLY its own
// devices; A can't register a device for B, rewrite a device's owner or its
// delivery bookkeeping, or write push_log; anon can't read or subscribe; a
// suspended A sees nothing.
function probePush(db) {
  const bad = [];
  const A = "00000000-0000-4000-8000-0000000056a0";
  const B = "00000000-0000-4000-8000-0000000056b0";
  const EP = (x) => `'https://fcm.googleapis.com/fcm/send/probe-${x}'`;
  const seed = `
    insert into auth.users (id, email) values ('${A}', 'probe-0056a@example.test'), ('${B}', 'probe-0056b@example.test');
    update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${B}');
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${B}', ${EP("b")}, 'k', 'a');
    insert into public.push_log (user_id, item_id, tag) values ('${B}', 'win:x@1', 'win:x');`;
  const asA = `set local role authenticated; select set_config('request.jwt.claim.sub', '${A}', true);`;
  const r = psql(db, ["-c", `
    begin; ${seed}
    ${asA}
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${A}', ${EP("a")}, 'k', 'a');
    select 'sees:' || count(*) from public.push_subscriptions;
    select 'sees-b:' || count(*) from public.push_subscriptions where user_id = '${B}';
    select 'log-b:' || count(*) from public.push_log;
    with u as (update public.push_subscriptions set show_details = true where user_id = '${B}' returning 1) select 'upd-b:' || count(*) from u;
    with u as (update public.push_subscriptions set show_details = true where user_id = '${A}' returning 1) select 'upd-own:' || count(*) from u;
    with d as (delete from public.push_subscriptions where user_id = '${B}' returning 1) select 'del-b:' || count(*) from d;
    reset role;
    select 'b-left:' || count(*) from public.push_subscriptions where user_id = '${B}';
    update public.profiles set is_active = false where id = '${A}';
    ${asA}
    select 'suspended-sees:' || count(*) from public.push_subscriptions;
    reset role;
    rollback;`], { allowFail: true });
  const out = (r.stdout || "").split("\n").map((l) => l.trim());
  const want = ["sees:1", "sees-b:0", "log-b:0", "upd-b:0", "upd-own:1", "del-b:0", "b-left:1", "suspended-sees:0"];
  const missing = want.filter((w) => !out.includes(w));
  if (r.status !== 0 || missing.length) {
    bad.push(`isolation (missing ${missing.join(" ") || "-"}; got ${out.filter((l) => /:/.test(l)).join(" ")}; ${(r.stderr || "").trim().split("\n")[0]})`);
  }

  const refused = [
    ["A registers a device for B", `${asA} insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${B}', ${EP("x")}, 'k', 'a');`, /row-level security/],
    ["A moves its device to B", `${asA} insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${A}', ${EP("a")}, 'k', 'a'); update public.push_subscriptions set user_id = '${B}';`, /permission denied/],
    ["A forges delivery bookkeeping", `${asA} update public.push_subscriptions set failures = 0, last_success_at = now();`, /permission denied/],
    ["A writes push_log", `${asA} insert into public.push_log (user_id, item_id, tag) values ('${A}', 'k', 't');`, /permission denied/],
    ["anon subscribes", `set local role anon; insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${A}', ${EP("anon")}, 'k', 'a');`, /permission denied/],
    ["anon lists devices", `set local role anon; select count(*) from public.push_subscriptions;`, /permission denied/],
  ];
  for (const [label, stmt, re] of refused) {
    const x = psql(db, ["-c", `begin; ${seed} ${stmt} rollback;`], { allowFail: true });
    if (x.status === 0 || !re.test(x.stderr || "")) bad.push(`${label} was not refused (${(x.stderr || "no error").trim().split("\n")[0]})`);
  }

  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: web push RLS (0056)`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: push_subscriptions own-devices only (A can't read/update/delete/register for B, can't touch bookkeeping); push_log service-only; anon refused`);
  }
}

function probeApproval(db) {
  const r = psql(db, ["-c", APPROVAL_PROBE_SQL], { allowFail: true });
  const bad = checkApprovalProbe(r.stdout ?? "");
  if (r.status !== 0 || bad.length) {
    failures++;
    console.log(`FAIL  ${db}: creator approval authorization (0056)`);
    if (r.status !== 0) console.log((r.stderr ?? "").trim());
    for (const message of bad) console.log(`  - ${message}`);
  } else {
    console.log(`PASS  ${db}: approval gates own writes, imports, push and agency access; approved creators, legacy admins, MFA and role scopes retain their permissions`);
  }
}

async function probeCreatorStorage(db) {
  const bad = [
    ...probeTheme(db, psql).map((message) => `theming: ${message}`),
    ...probeStorageWork(db, psql).map((message) => `storage: ${message}`),
    ...(await probeStorageSecurityRaces(db, psql, psqlAsync)).map((message) => `security races: ${message}`),
  ];
  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: creator theme/media and durable storage (0058)`);
    for (const message of bad) console.log(`  - ${message}`);
  } else {
    console.log(`PASS  ${db}: theme/media ownership, durable storage RLS, quiescence, retry and idempotency`);
  }
}

// ------------------------------------------ instant rewards probe (0057) ---
// #26: reward secrets are server-only and a code is never handed out twice.
// On a real Postgres:
//   * anon has no access; a creator reads only its own metadata columns (never
//     cipher/iv), can't write a reward row even with Supabase's default table
//     grants (no write policy), and can't execute any reward function;
//   * the service role can't attach codes to another creator's prize;
//   * a code-list prize's stock is its unused-code count, even after a direct
//     UPDATE; a spin insert on a code prize without a reserved code fails;
//   * a delivered code is never released back, an unrecorded one is;
//   * concurrency: 20 parallel spins on a 5-code prize, each in its own
//     session, give exactly 5 winners 5 distinct codes; the other 15 find it
//     sold out, stock ends at 0, and no spin row exists without its code.
const RW_A = "00000000-0000-4000-8000-0000000057a0";
const RW_B = "00000000-0000-4000-8000-0000000057b0";
const RW_WA = "00000000-0000-4000-8000-0000000057aa";
const RW_WB = "00000000-0000-4000-8000-0000000057bb";
const RW_PA = "00000000-0000-4000-8000-0000000057a1";
const RW_PB = "00000000-0000-4000-8000-0000000057b1";
const RW_PC = "00000000-0000-4000-8000-0000000057c1";
const RW_FAN = "00000000-0000-4000-8000-0000000057fa";
const RW_PASS = "00000000-0000-4000-8000-0000000057f0";
const rwCodes = (n, tag) =>
  `'${JSON.stringify(Array.from({ length: n }, (_, i) => ({ cipher: `c-${tag}-${i}`, iv: `iv-${i}`, key_version: 1, hint: `${tag}${i}`.slice(-4), fingerprint: createHash("sha256").update(`${tag}:${i}`).digest("hex") })))}'::jsonb`;
const RW_SEED = `
  set local fanfunnel.economic_write='on'; -- DB-owner historical engine fixture only
  insert into auth.users (id, email) values ('${RW_A}', 'probe-0057a@example.test'), ('${RW_B}', 'probe-0057b@example.test');
  update public.profiles set is_active = true, approval_status='approved' where id in ('${RW_A}', '${RW_B}');
  insert into public.wheels (id, creator_id, title) values ('${RW_WA}', '${RW_A}', 'a'), ('${RW_WB}', '${RW_B}', 'b');
  insert into public.prizes (id, wheel_id, label, weight) values
    ('${RW_PA}', '${RW_WA}', 'A code prize', 10), ('${RW_PB}', '${RW_WB}', 'B link prize', 10), ('${RW_PC}', '${RW_WA}', 'A race prize', 10);
  insert into public.fans (id, creator_id, display_name) values ('${RW_FAN}', '${RW_A}', 'fan');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id, spins_remaining) values
    ('${RW_PASS}', 'probe-0057', '${RW_A}', '${RW_WA}', '${RW_FAN}', 100);
  select public.add_reward_codes('${RW_PA}', '${RW_A}', ${rwCodes(3, "A")});
  select public.set_prize_delivery('${RW_PB}', '${RW_B}', 'link', 'cipher-b', 'iv-b', 1::smallint);`;
const rwSpin = (id, prize) =>
  `insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label)
   values ('${id}', '${RW_PASS}', '${RW_A}', '${RW_WA}', '${RW_FAN}', '${prize}', 'probe');`;

function psqlAsync(db, sqlText) {
  return new Promise((resolve) => {
    const p = spawn(
      join(PG_BIN, "psql"),
      ["-h", WORK, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-qAt", "-X", "-c", sqlText],
      { stdio: ["ignore", "pipe", "pipe"], env: PSQL_ENV },
    );
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function probeInstantRewards(db) {
  const bad = [];
  const as = (uid, stmt) =>
    uid
      ? `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${stmt} reset role;`
      : `set local role anon; select set_config('request.jwt.claim.sub', '', true); ${stmt} reset role;`;
  const run = (body) => psql(db, ["-c", `begin; ${RW_SEED} ${body} rollback;`], { allowFail: true });
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const firstErr = (r) => (r.stderr || "no error").trim().split("\n")[0];
  const refused = (label, body, re = /permission denied|row-level security/) => {
    const r = run(body);
    if (!re.test(r.stderr || "")) bad.push(`${label} was not refused (${r.status === 0 ? "succeeded" : firstErr(r)})`);
  };

  // --- access ------------------------------------------------------------------
  refused("anon SELECT prize_reward_codes", as(null, "select count(*) from public.prize_reward_codes;"));
  refused("anon SELECT spin_rewards", as(null, "select count(*) from public.spin_rewards;"));
  refused("creator reading cipher on prize_reward_codes", as(RW_A, "select cipher from public.prize_reward_codes;"));
  refused("creator reading cipher on prize_rewards", as(RW_B, "select cipher from public.prize_rewards;"));
  refused("creator reading cipher on spin_rewards", as(RW_A, "select iv from public.spin_rewards;"));
  for (const [fn, call] of [
    ["reserve_reward_code", `public.reserve_reward_code('${RW_PA}', gen_random_uuid())`],
    ["release_reward_code", "public.release_reward_code(gen_random_uuid())"],
    ["add_reward_codes", `public.add_reward_codes('${RW_PA}', '${RW_A}', ${rwCodes(1, "X")})`],
    ["set_prize_delivery", `public.set_prize_delivery('${RW_PA}', '${RW_A}', 'manual')`],
    ["record_reward_view", "public.record_reward_view(gen_random_uuid())"],
    ["record_fan_reward_view", "public.record_fan_reward_view(gen_random_uuid(), 'invalid-token')"],
    ["finalize_reward_spin", "public.finalize_reward_spin('{}'::jsonb, '{}'::jsonb)"],
    ["save_wheel_prizes", `public.save_wheel_prizes('${RW_WA}', '${RW_A}', '[]'::jsonb)`],
  ]) {
    refused(`creator ${fn}()`, as(RW_A, `select ${call};`), new RegExp(`permission denied for function ${fn}`));
    refused(`anon ${fn}()`, as(null, `select ${call};`), new RegExp(`permission denied for function ${fn}`));
  }
  const reads = run(`
    ${as(RW_A, "select 'a-codes:' || count(*) || ',' || string_agg(hint, '' order by hint) from public.prize_reward_codes;")}
    ${as(RW_A, "select 'a-sees-b-link:' || count(*) from public.prize_rewards;")}
    ${as(RW_B, "select 'b-link:' || count(*) || ',' || min(kind) from public.prize_rewards;")}
    ${as(RW_B, "select 'b-sees-a-codes:' || count(*) from public.prize_reward_codes;")}
    update public.profiles set is_active = false where id = '${RW_A}';
    ${as(RW_A, "select 'suspended-a-codes:' || count(*) from public.prize_reward_codes;")}`);
  for (const want of ["a-codes:3,A0A1A2", "a-sees-b-link:0", "b-link:1,link", "b-sees-a-codes:0", "suspended-a-codes:0"]) {
    if (!out(reads).includes(want)) bad.push(`expected ${want} (got ${out(reads).filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${firstErr(reads)})`);
  }
  // Supabase grants table privileges by default; even with them, no write policy = no write.
  const grantAll = "grant select, insert, update, delete on public.prize_rewards, public.prize_reward_codes, public.spin_rewards, public.prizes, public.wheels to anon, authenticated;";
  refused("creator INSERT of a code (default grants)", `${grantAll} ${as(RW_A, `insert into public.prize_reward_codes (prize_id, creator_id, cipher, iv) values ('${RW_PA}', '${RW_A}', 'x', 'y');`)}`);
  refused("creator INSERT of a link onto B's prize (default grants)", `${grantAll} ${as(RW_A, `insert into public.prize_rewards (prize_id, creator_id, kind, cipher, iv) values ('${RW_PB}', '${RW_A}', 'link', 'x', 'y');`)}`);
  const writes = run(`${grantAll}
    ${as(RW_A, "with u as (update public.prize_reward_codes set spin_id = gen_random_uuid(), assigned_at = now() returning 1) select 'a-update-codes:' || count(*) from u;")}
    ${as(RW_A, "with d as (delete from public.prize_reward_codes returning 1) select 'a-delete-codes:' || count(*) from d;")}
    ${as(RW_B, "with u as (update public.prize_rewards set cipher = 'swapped' returning 1) select 'b-update-link:' || count(*) from u;")}
    ${as(RW_A, `update public.prizes set stock = 99 where id = '${RW_PA}';`)}
    select 'stock-after-edit:' || stock from public.prizes where id = '${RW_PA}';
    select 'codes-intact:' || count(*) from public.prize_reward_codes where spin_id is null;`);
  for (const want of ["a-update-codes:0", "a-delete-codes:0", "b-update-link:0", "stock-after-edit:3", "codes-intact:3"]) {
    if (!out(writes).includes(want)) bad.push(`expected ${want} (got ${out(writes).filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${firstErr(writes)})`);
  }

  // --- service-role behaviour --------------------------------------------------
  const cross = run(`set local role service_role; select public.add_reward_codes('${RW_PB}', '${RW_A}', ${rwCodes(1, "X")});`);
  if (!/prize not found/.test(cross.stderr || "")) bad.push(`codes were attached to another creator's prize (${firstErr(cross)})`);
  const crossLink = run(`set local role service_role; select public.set_prize_delivery('${RW_PB}', '${RW_A}', 'text', 'x', 'y');`);
  if (!/prize not found/.test(crossLink.stderr || "")) bad.push(`a reward was set on another creator's prize (${firstErr(crossLink)})`);
  const noCode = run(rwSpin("00000000-0000-4000-8000-000000005701", RW_PA));
  if (!/no reward code reserved/.test(noCode.stderr || "")) bad.push(`a code prize was awarded without a reserved code (${firstErr(noCode)})`);
  const S1 = "00000000-0000-4000-8000-000000005711";
  const S2 = "00000000-0000-4000-8000-000000005712";
  const flow = run(`
    select 'reserved:' || count(*) from public.reserve_reward_code('${RW_PA}', '${S1}');
    select 'stock-1:' || stock from public.prizes where id = '${RW_PA}';
    ${rwSpin(S1, RW_PA)}
    select public.record_fan_reward_views(array['${S1}'::uuid],'probe-0057');
    select 'delivered:' || kind || ',' || (code_id is not null) || ',' || (cipher like 'c-A-%') || ',' || views from public.spin_rewards where spin_id = '${S1}';
    select 'release-delivered:' || public.release_reward_code('${S1}');
    select 'reserved-2:' || count(*) from public.reserve_reward_code('${RW_PA}', '${S2}');
    select 'release-unrecorded:' || public.release_reward_code('${S2}');
    select 'views:' || public.record_reward_view('${S1}');
    select 'stock-end:' || stock from public.prizes where id = '${RW_PA}';
    select 'assigned:' || count(*) from public.prize_reward_codes where spin_id is not null;`);
  for (const want of [
    "reserved:1",
    "stock-1:2",
    "delivered:code,true,true,1",
    "release-delivered:false",
    "reserved-2:1",
    "release-unrecorded:true",
    "views:2",
    "stock-end:2",
    "assigned:1",
  ]) {
    if (!out(flow).includes(want)) bad.push(`reward flow: expected ${want} (got ${out(flow).filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${firstErr(flow)})`);
  }
  const twice = run(`select public.reserve_reward_code('${RW_PA}', '${S1}'); select public.reserve_reward_code('${RW_PA}', '${S1}');`);
  if (!/duplicate key|unique/.test(twice.stderr || "")) bad.push(`one spin could reserve two codes (${firstErr(twice)})`);
  const manual = run(`
    set local role service_role;
    select public.set_prize_delivery('${RW_PA}', '${RW_A}', 'manual');
    reset role;
    select 'manual:' || delivery || ',' || stock || ',' || (select count(*) from public.prize_reward_codes) from public.prizes where id = '${RW_PA}';`);
  if (!out(manual).includes("manual:manual,3,0")) bad.push(`leaving a code list should keep stock 3 and drop unused codes (got ${out(manual).filter((l) => /:/.test(l)).join(" ")}; ${firstErr(manual)})`);

  const duplicatePaste = run(`
    select 'duplicates-added:' || public.add_reward_codes('${RW_PA}', '${RW_A}', ${rwCodes(3, "A")});
    select 'duplicate-stock:' || stock from public.prizes where id = '${RW_PA}';`);
  for (const want of ["duplicates-added:0", "duplicate-stock:3"]) if (!out(duplicatePaste).includes(want)) bad.push(`cross-paste dedup expected ${want}`);
  const atomicId = "00000000-0000-4000-8000-000000005719";
  const atomicBody = JSON.stringify({id: atomicId, fan_pass_id: RW_PASS, creator_id: RW_A, wheel_id: RW_WA, fan_id: RW_FAN, prize_id: RW_PA, prize_label: "atomic", prize_rarity: "common"});
  const atomicFlow = run(`
    do $$ declare c public.prize_reward_codes%rowtype; expected jsonb; receipt jsonb; again jsonb; begin
      select * into c from public.prize_reward_codes where prize_id = '${RW_PA}' and spin_id is null order by created_at, id limit 1;
      expected := jsonb_build_object('delivery','codes','codeId',c.id,'cipher',c.cipher,'iv',c.iv,'keyVersion',c.key_version);
      begin
        perform public.finalize_reward_spin(jsonb_set('${atomicBody}'::jsonb, '{prize_label}', 'null'::jsonb), expected);
        raise exception 'expected spin insert failure';
      exception when not_null_violation then null; end;
      if (select stock from public.prizes where id='${RW_PA}') <> 3 then raise exception 'failed finalization leaked stock'; end if;
      if exists(select 1 from public.prize_reward_codes where spin_id='${atomicId}') then raise exception 'failed finalization stranded a code'; end if;
      receipt := public.finalize_reward_spin('${atomicBody}'::jsonb, expected);
      again := public.finalize_reward_spin('${atomicBody}'::jsonb, expected);
      if receipt->>'shareId' is distinct from again->>'shareId' then raise exception 'retry changed receipt'; end if;
      if (select count(*) from public.redemptions where spin_id='${atomicId}') <> 1 then raise exception 'queue insert not atomic'; end if;
      begin update public.redemptions set status='pending' where spin_id='${atomicId}'; raise exception 'reopened auto win'; exception when check_violation then null; end;
      begin update public.redemptions set due_at=now() where spin_id='${atomicId}'; raise exception 'scheduled auto win'; exception when check_violation then null; end;
    end $$;
    select 'atomic-stock:' || stock from public.prizes where id='${RW_PA}';
    insert into public.fans(id,creator_id,display_name) values('00000000-0000-4000-8000-0000000057fb','${RW_A}','another fan');
    insert into public.fan_passes(token,creator_id,wheel_id,fan_id) values('probe-other-fan','${RW_A}','${RW_WA}','00000000-0000-4000-8000-0000000057fb');
    select 'wrong-fan-view:' || (public.record_fan_reward_view('${atomicId}','probe-other-fan') is null);
    select public.record_fan_reward_views(array['${atomicId}'::uuid],'probe-0057');
    select 'own-fan-view:' || public.record_fan_reward_view('${atomicId}','probe-0057');
    select public.scrub_fan_reward_values('${RW_FAN}');
    select 'erased-view:' || (public.record_fan_reward_view('${atomicId}','probe-0057') is null);
    select 'erased-receipt:' || count(*) from public.spin_rewards where spin_id='${atomicId}' and cipher is null and iv is null and erased_at is not null and kind='code' and views=2;
    select 'consumed-tombstone:' || count(*) from public.prize_reward_codes where spin_id='${atomicId}' and cipher is null and iv is null and hint is null and erased_at is not null and fingerprint is not null;
    select 'erased-release:' || public.release_reward_code('${atomicId}');
    select 'erased-reupload:' || public.add_reward_codes('${RW_PA}', '${RW_A}', ${rwCodes(3, "A")});
    select 'after-erasure-stock:' || stock from public.prizes where id='${RW_PA}';
    select 'after-erasure-spins:' || count(*) from public.spins where id='${atomicId}';
    select 'after-erasure-queue:' || count(*) from public.redemptions where spin_id='${atomicId}' and status='fulfilled';`);
  if (atomicFlow.status !== 0 || !out(atomicFlow).includes('atomic-stock:2')) bad.push(`atomic finalization/rollback/status guard: ${firstErr(atomicFlow)}`);
  for(const wanted of ["wrong-fan-view:true","own-fan-view:2","erased-view:true","erased-receipt:1","consumed-tombstone:1","erased-release:false","erased-reupload:0","after-erasure-stock:2","after-erasure-spins:1","after-erasure-queue:1"]) {
    if(!out(atomicFlow).includes(wanted)) bad.push(`reward erasure expected ${wanted}`);
  }


  const replacement = [
    {id:RW_PA,label:"retained code",rarity:"common",weight:2,stock:99,delivery:"manual"},
    {id:RW_PC,label:"retained plain",rarity:"common",weight:1,stock:null},
  ];
  const saved = run(`
    select public.save_wheel_prizes('${RW_WA}','${RW_A}','${JSON.stringify(replacement)}'::jsonb);
    select 'saved-code:' || delivery || ',' || stock from public.prizes where id='${RW_PA}';
    select 'saved-secrets:' || count(*) from public.prize_reward_codes where prize_id='${RW_PA}';
    select public.save_wheel_prizes('${RW_WA}','${RW_A}', '[{"id":"${RW_PB}","label":"new owned","rarity":"common","weight":1},{"label":"other","rarity":"common","weight":1}]'::jsonb);
    select 'foreign-prize:' || label from public.prizes where id='${RW_PB}';
    select 'own-prize-count:' || count(*) from public.prizes where wheel_id='${RW_WA}';`);
  for(const wanted of ["saved-code:codes,3","saved-secrets:3","foreign-prize:B link prize","own-prize-count:2"]) if(!out(saved).includes(wanted)) bad.push(`transactional save expected ${wanted}`);
  const failedSave = run(`do $$ begin
    begin
      perform public.save_wheel_prizes('${RW_WA}','${RW_A}', '[{"label":"valid before error","rarity":"common","weight":1},{"label":null,"rarity":"common","weight":1}]'::jsonb);
      raise exception 'expected replacement failure';
    exception when not_null_violation then null; end;
    if(select count(*) from public.prize_reward_codes where prize_id='${RW_PA}')<>3 then raise exception 'failed save erased codes';end if;
    if(select count(*) from public.prizes where wheel_id='${RW_WA}')<>2 then raise exception 'failed save changed prize set';end if;
    if(select label from public.prizes where id='${RW_PA}')<>'A code prize' then raise exception 'failed save changed original prize';end if;
  end $$;`);
  if(failedSave.status!==0) bad.push(`transactional save rollback: ${firstErr(failedSave)}`);
  const foreignSave=run(`select public.save_wheel_prizes('${RW_WB}','${RW_A}','${JSON.stringify(replacement)}'::jsonb);`);
  if(!/wheel not found/.test(foreignSave.stderr||"")) bad.push("service save accepted forged wheel owner");

  // --- concurrency: 20 sessions race for 5 codes ---------------------------------
  const seeded = psql(db, ["-c", `begin; ${RW_SEED} select public.add_reward_codes('${RW_PC}', '${RW_A}', ${rwCodes(5, "R")}); commit;`], { allowFail: true });
  if (seeded.status !== 0) {
    bad.push(`concurrency seed failed (${firstErr(seeded)})`);
  } else {
    const raceOne = async () => {
      const spin = { id: randomUUID(), fan_pass_id: RW_PASS, creator_id: RW_A, wheel_id: RW_WA,
        fan_id: RW_FAN, prize_id: RW_PC, prize_label: "race", prize_rarity: "common" };
      for (let attempt = 0; attempt < 20; attempt++) {
        // Separate sessions/statements model the actual pre-read -> RPC HTTP boundary.
        const candidate = await psqlAsync(db, `select row_to_json(c) from
          (select id, cipher, iv, key_version from public.prize_reward_codes where prize_id = '${RW_PC}' and spin_id is null order by created_at, id limit 1) c;`);
        if (candidate.status !== 0) return `error:${firstErr(candidate)}`;
        if (!candidate.stdout.trim()) return "sold-out";
        const c = JSON.parse(candidate.stdout.trim());
        const expected = { delivery: "codes", codeId: c.id, cipher: c.cipher, iv: c.iv, keyVersion: c.key_version };
        const result = await psqlAsync(db, `set fanfunnel.economic_write='on'; select public.finalize_reward_spin('${JSON.stringify(spin)}'::jsonb, '${JSON.stringify(expected)}'::jsonb);`);
        if (result.status !== 0) return `error:${firstErr(result)}`;
        const receipt = JSON.parse(result.stdout.trim());
        if (receipt.status === "retry") continue;
        if (receipt.status === "sold_out") return "sold-out";
        if (receipt.status !== "recorded") return `error:${receipt.status}`;
        // A second independent request after commit returns the same immutable receipt.
        const replay = await psqlAsync(db, `set fanfunnel.economic_write='on'; select public.finalize_reward_spin('${JSON.stringify(spin)}'::jsonb, '${JSON.stringify(expected)}'::jsonb);`);
        if (replay.status !== 0 || JSON.parse(replay.stdout.trim()).shareId !== receipt.shareId) return "error:non-idempotent";
        return `won:${c.id}`;
      }
      return "error:contention";
    };
    const lines = await Promise.all(Array.from({ length: 20 }, raceOne));
    const won = lines.filter((l) => l.startsWith("won:"));
    const errors = lines.filter((l) => l.startsWith("error:"));
    const state = sql(db, `
      select (select stock from public.prizes where id = '${RW_PC}') || ',' ||
             (select count(*) from public.prize_reward_codes where prize_id = '${RW_PC}' and spin_id is not null) || ',' ||
             (select count(distinct spin_id) from public.prize_reward_codes where prize_id = '${RW_PC}') || ',' ||
             (select count(*) from public.spins where prize_id = '${RW_PC}') || ',' ||
             (select count(distinct r.code_id) from public.spin_rewards r join public.spins s on s.id = r.spin_id where s.prize_id = '${RW_PC}')`);
    if (errors.length) bad.push(`race sessions errored: ${errors.slice(0, 3).join(" | ")}`);
    if (won.length !== 5 || new Set(won).size !== 5) bad.push(`race: expected 5 winners with 5 distinct codes, got ${won.length} (${new Set(won).size} distinct)`);
    if (lines.filter((l) => l === "sold-out").length !== 15) bad.push(`race: expected 15 sold-out spins, got ${lines.filter((l) => l === "sold-out").length}`);
    if (state !== "0,5,5,5,5") bad.push(`race: expected stock,assigned,distinct spins,spin rows,distinct delivered codes = 0,5,5,5,5 (got ${state})`);
  }
  psql(db, ["-c", `delete from auth.users where id in ('${RW_A}', '${RW_B}');`], { allowFail: true });

  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: instant rewards (0057)`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: private0057 engine regression: secrets server-only, creator metadata-only and tenant-isolated, code stock locked, no award without a code; 20 racing spins on 5 codes -> 5 distinct codes, 15 sold out`);
  }
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
  console.log(`Crypto fixture: pgcrypto in ${CRYPTO_SCHEMA}; API roles cannot CREATE in public/extensions`);
  newDb("ffa");
  loadFile("ffa", "base schema", base);
  for (const m of migrations) if (!loadFile("ffa", m, join(SUPABASE, "migrations", m))) break;

  console.log("B  = schema.sql");
  newDb("ffb");
  loadFile("ffb", "schema.sql", schema);

  console.log("B2 = schema.sql x2");
  newDb("ffb2");
  if (loadFile("ffb2", "schema.sql", schema)) loadFile("ffb2", "schema.sql (2nd run)", schema);

  console.log("C  = schema.sql + migrations_combined.sql");
  newDb("ffc");
  if (loadFile("ffc", "schema.sql", schema)) loadFile("ffc", "migrations_combined.sql", combined);

  console.log("C2 = schema.sql + migrations_combined.sql x2");
  newDb("ffc2");
  if (loadFile("ffc2", "schema.sql", schema) && loadFile("ffc2", "migrations_combined.sql", combined)) {
    loadFile("ffc2", "migrations_combined.sql (2nd run)", combined);
  }

  const A = catalog("ffa");
  diff("A", A, "B", catalog("ffb"));
  diff("A", A, "B2", catalog("ffb2"));
  diff("A", A, "C", catalog("ffc"));
  diff("A", A, "C2", catalog("ffc2"));

  for (const db of ["ffa", "ffb", "ffc"]) {
    probeGrants(db);
    probeOrgIsolation(db);
    probeCheckins(db);
    probeAppErrors(db);
    probePrivacy(db);
    probePush(db);
    probeApproval(db);
    await probeInstantRewards(db);
    await probeCreatorStorage(db);
    await probeFocusLedger(async (q) => {
      const r=await psqlAsync(db,q);
      if(r.status!==0)throw new Error(r.stderr||"focus SQL failed");
      return r.stdout;
    });
    await probeRewardViews(async(q)=>{const r=await psqlAsync(db,q);if(r.status!==0)throw Error(r.stderr||"reward view SQL failed");return r.stdout;});
    const cryptoFailures = probeCryptoNamespace(db, psql, CRYPTO_SCHEMA);
    if (cryptoFailures.length) throw new Error(cryptoFailures.join("; "));
  }
} catch (e) {
  failures++;
  console.error(e instanceof Error ? e.message : e);
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} problem(s): the SQL snapshots have drifted from the migrations, or the grant probe failed.` : "\nALL PASS: schema.sql, migrations_combined.sql and migrations/ build the same database.");
process.exit(failures ? 1 : 0);
