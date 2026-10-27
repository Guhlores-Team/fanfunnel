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
//
// Needs Postgres 16 binaries (initdb/pg_ctl/psql) on PATH, in $PG_BIN, or
// under /usr/lib/postgresql/*/bin. No TCP port is opened (unix socket only),
// and the data dir is deleted afterwards. When run as root (containers), the
// server is started as the `postgres` OS user because Postgres refuses root.
//
//   node scripts/db/schema-drift-check.mjs [--keep] [--base-rev <git-rev>] [--base <file>]
//
// Exit code 0 = all builds load, all catalogs match and the probe passes; 1 otherwise.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORG_PROBE_SQL, checkOrgProbe } from "./orgIsolationProbe.mjs";

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
  "import_fans(jsonb)",
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
    update public.profiles set is_active = true where id in ('${A_UID}', '${B_UID}');
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
  const pwaBad = psql(db, ["-c", `begin; insert into auth.users (id, email) values ('${A_UID}', 'probe-0046a@example.test'); update public.profiles set is_active = true where id = '${A_UID}'; ${asUser(A_UID, "select public.set_pwa_icon_mode('selfie');")} rollback;`], { allowFail: true });
  if (!/invalid pwa_icon_mode/.test(pwaBad.stderr || "")) {
    bad.push(`set_pwa_icon_mode accepted an invalid value (${(pwaBad.stderr || "no error").trim().split("\n")[0]})`);
  }
  const pwaDirect = psql(db, ["-c", `begin; insert into auth.users (id, email) values ('${A_UID}', 'probe-0046a@example.test'), ('${B_UID}', 'probe-0046b@example.test'); set local role authenticated; select set_config('request.jwt.claim.sub', '${A_UID}', true); update public.profiles set pwa_icon_mode = 'avatar' where id = '${B_UID}'; reset role; select 'direct-b:' || pwa_icon_mode from public.profiles where id = '${B_UID}'; rollback;`], { allowFail: true });
  if (pwaDirect.status === 0 && !(pwaDirect.stdout || "").includes("direct-b:neutral")) {
    bad.push(`a creator's direct UPDATE changed another creator's pwa_icon_mode (${(pwaDirect.stdout || "").trim()})`);
  }

  bad.push(...probeBreaks(db, asUser));
  bad.push(...probeOutreach(db));

  if (bad.length) {
    failures++;
    console.log(`FAIL  ${db}: signed-in-only RPC grants / RM-6 break guard`);
    for (const b of bad) console.log(`  - ${b}`);
  } else {
    console.log(`PASS  ${db}: anon refused on ${SIGNED_IN_ONLY.length} signed-in-only RPCs; authenticated setters persist; set_pwa_icon_mode is own-row only; RLS helpers still anon-callable; RM-6 breaks only lengthen, block spins and stay fan-only; fan_outreach is tenant-isolated and append-only`);
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
    insert into auth.users (id, email) values ('${A}', 'probe-0049a@example.test'), ('${B}', 'probe-0049b@example.test');
    update public.profiles set is_active = true where id in ('${A}', '${B}');
    insert into public.wheels (id, creator_id, title) values
      ('00000000-0000-4000-8000-0000000049aa', '${A}', 'a'), ('00000000-0000-4000-8000-0000000049bb', '${B}', 'b');
    insert into public.fans (id, creator_id, display_name) values ('${FA}', '${A}', 'fa'), ('${FB}', '${B}', 'fb'), ('${FC}', '${A}', 'fc');
    insert into public.fan_passes (token, creator_id, wheel_id, fan_id, spins_remaining) values
      ('probe-0049-a', '${A}', '00000000-0000-4000-8000-0000000049aa', '${FA}', 3),
      ('probe-0049-b', '${B}', '00000000-0000-4000-8000-0000000049bb', '${FB}', 3),
      ('probe-0049-c', '${A}', '00000000-0000-4000-8000-0000000049aa', '${FC}', 3);
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
    select 'claim-on-break:' || coalesce(public.claim_spin('probe-0049-a')::text, 'refused');
    select 'claim-other:' || coalesce(public.claim_spin('probe-0049-b')::text, 'refused');
    select 'claim-ended:' || coalesce(public.claim_spin('probe-0049-c')::text, 'refused');
    select 'restart:' || (public.fan_take_break('probe-0049-c', now() + interval '7 days') = now() + interval '7 days');
    select 'unknown:' || coalesce(public.fan_take_break('probe-0049-nope', now() + interval '1 day')::text, 'null');
    rollback;`], { allowFail: true });
  const want = ["take:true", "shorter:true", "other-fan:none", "claim-on-break:refused", "claim-other:2", "claim-ended:2", "restart:true", "unknown:null"];
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
  update public.profiles set is_active = true where id in ('${CK_A}', '${CK_B}');
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
    update public.profiles set is_active = true where id in ('${A}', '${B}');
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

  for (const db of ["ffa", "ffb", "ffc"]) {
    probeGrants(db);
    probeOrgIsolation(db);
    probeCheckins(db);
  }
} catch (e) {
  failures++;
  console.error(e instanceof Error ? e.message : e);
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} problem(s): the SQL snapshots have drifted from the migrations, or the grant probe failed.` : "\nALL PASS: schema.sql, migrations_combined.sql and migrations/ build the same database.");
process.exit(failures ? 1 : 0);
