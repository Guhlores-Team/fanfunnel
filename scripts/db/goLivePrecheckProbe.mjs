// @ts-check
// Proof for scripts/golive/live-precheck.sql (the owner's read-only pre-check
// before go-live) and for what 0073 does with the data that pre-check finds.
// Run by schema-drift-check.mjs, which hands over a database built to 0038
// (LIVE's level) and one built to 0072 (TEST's level), both cloned from its
// own migration build, plus the fully migrated one.
//   * the script runs without error and without writing (a read-only
//     transaction) at 0038, at 0072 and at the newest level, as a role that
//     is not a superuser, and says ok on every row of a clean database;
//   * with one planted violation per check it says STOP on every check that
//     level can evaluate (a check whose column does not exist yet is skipped);
//   * its free-text rows are the DB-03 rules of 0073, one for one;
//   * M2: 0073 applies over a database at 0072 that holds an over-long legacy
//     row, leaves that one rule out (never NOT VALID), the row still updates
//     and a play on that fan commits; shortened and re-run, the rule is added;
//   * 0073 applies as a non-superuser and skips, with a warning, a function
//     owned by another role that it cannot alter.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { playFixtures } from "./lockOrderProbe.mjs";

const ROOT = join(import.meta.dirname, "../..");
const PRECHECK = join(ROOT, "scripts/golive/live-precheck.sql");
const MIGRATION = join(ROOT, "supabase/migrations/0073_batch7_hardening.sql");
const NOT_YET = "ok (not in this database yet)";
/** Checks each level cannot evaluate yet (the column is created by 0073). */
const SKIPPED = ["Text over the size limit: creator_applications.decision_reason (500 characters)"];

// One violation per check. Triggers and foreign keys are off (replica) and
// every CHECK is dropped first, so a row can be planted at any migration
// level; plant() fills the NOT NULL columns that have no default and ignores
// a column the level does not have yet.
const PLANT = `
set session_replication_role = replica;
do $$ declare r record; begin
  for r in select c.conrelid::regclass as tbl, c.conname from pg_constraint c where c.connamespace = 'public'::regnamespace and c.contype = 'c' loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;
alter table public.creator_applications drop constraint if exists creator_applications_profile_id_key;
drop index if exists public.orgs_owner_id_key;
create function pg_temp.plant(tbl text, vals jsonb) returns void language plpgsql as $f$
declare j jsonb; cols text;
begin
  select coalesce(jsonb_object_agg(a.attname,
           case when t.typcategory = 'A' then '[]'::jsonb
                when t.typname = 'uuid' then to_jsonb(gen_random_uuid()::text)
                when t.typcategory = 'N' then to_jsonb(1)
                when t.typcategory = 'B' then to_jsonb(false)
                when t.typcategory = 'D' then to_jsonb(now())
                when t.typname in ('json', 'jsonb') then '{}'::jsonb
                when t.typcategory = 'E' then to_jsonb((select e.enumlabel from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder limit 1))
                else to_jsonb('p' || md5(random()::text)) end), '{}'::jsonb)
    into j
    from pg_attribute a join pg_type t on t.oid = a.atttypid
   where a.attrelid = ('public.' || tbl)::regclass and a.attnum > 0 and not a.attisdropped and a.attnotnull and not a.atthasdef and a.attgenerated = '';
  j := j || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(vals) e
                       where exists (select 1 from pg_attribute a where a.attrelid = ('public.' || tbl)::regclass and a.attname = e.key and a.attnum > 0 and not a.attisdropped)), '{}'::jsonb);
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(j) k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', tbl, cols, cols, tbl) using j;
end $f$;
select pg_temp.plant('fans', jsonb_build_object('spins_remaining', -1, 'spins_granted_total', -1, 'rl_count', -1, 'notes', repeat('n', 2001),
  'tags', (select jsonb_agg('t' || g) from generate_series(1, 51) g), 'display_name', repeat('d', 81), 'handle', repeat('h', 81)));
select pg_temp.plant('fan_passes', '{"spins_remaining": -1, "spins_granted_total": -1}');
select pg_temp.plant('prizes', jsonb_build_object('stock', -1, 'cost_cents', -1, 'label', repeat('l', 121), 'description', repeat('d', 1001), 'color', repeat('c', 33), 'emoji', repeat('e', 33)));
select pg_temp.plant('wheels', jsonb_build_object('title', repeat('t', 121), 'subtitle', repeat('s', 201)));
select pg_temp.plant('wheel_templates', jsonb_build_object('name', repeat('n', 121), 'title', repeat('t', 121), 'subtitle', repeat('s', 201)));
select pg_temp.plant('campaigns', jsonb_build_object('name', repeat('n', 121)));
select pg_temp.plant('orgs', jsonb_build_object('owner_id', '00000000-0000-4000-8000-00000000aaaa', 'name', repeat('n', 121)));
select pg_temp.plant('orgs', jsonb_build_object('owner_id', '00000000-0000-4000-8000-00000000aaaa', 'name', 'second agency'));
select pg_temp.plant('wishlists', jsonb_build_object('prize_label', repeat('p', 121)));
select pg_temp.plant('dm_templates', jsonb_build_object('title', repeat('t', 121), 'body', repeat('b', 2001)));
select pg_temp.plant('prize_templates', jsonb_build_object('label', repeat('l', 121), 'description', repeat('d', 1001)));
select pg_temp.plant('campaign_packs', jsonb_build_object('label', repeat('l', 121)));
select pg_temp.plant('profiles', jsonb_build_object('chat_intro', repeat('i', 2001), 'chat_outro', repeat('o', 2001), 'creator_note', repeat('n', 2001)));
select pg_temp.plant('creator_applications', jsonb_build_object('profile_id', '00000000-0000-4000-8000-00000000bbbb', 'display_name', repeat('d', 121), 'socials', repeat('s', 601),
  'audience_size', repeat('a', 121), 'note', repeat('n', 1001), 'email', repeat('e', 321), 'decision_reason', repeat('r', 501)));
select pg_temp.plant('creator_applications', jsonb_build_object('profile_id', '00000000-0000-4000-8000-00000000bbbb'));
select pg_temp.plant('creator_reports', jsonb_build_object('status', 'escalated'));
create table public.zz_precheck_open (id integer);
create policy zz_precheck_true on public.wishlists for select using (true);
create function public.zz_precheck_foreign() returns integer language sql as 'select 1';
alter function public.zz_precheck_foreign() owner to ff_other_owner;
grant select on public.wishlists to public;
create function public.zz_precheck_definer() returns integer language sql security definer set search_path = public, pg_temp as 'select 1';
`;

/**
 * @param {{
 *   psql: (db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>,
 *   psqlAsync: (db: string, sql: string) => Promise<{ status: number | null, stdout: string, stderr: string }>,
 *   db38: string, db72: string, dbLatest: string,
 * }} opts
 * @returns {Promise<{ bad: string[], checks: number }>}
 */
export async function probeGoLivePrecheck({ psql, psqlAsync, db38, db72, dbLatest }) {
  const bad = [];
  let checks = 0;
  const check = (ok, label) => { checks++; if (!ok) bad.push(label); };
  const errorOf = (r) => (r.stderr || "").split("\n").find((l) => /ERROR|FATAL/.test(l)) ?? (r.stderr || "no error").trim().split("\n")[0];
  const must = (db, q) => { const r = psql(db, ["-c", q], { allowFail: true }); if (r.status !== 0) throw new Error(`${q.slice(0, 80)}: ${errorOf(r)}`); return (r.stdout || "").trim(); };
  const clone = (from, to) => { must("postgres", `drop database if exists ${to}`); must("postgres", `create database ${to} template ${from}`); return to; };
  const drop = (name) => psql("postgres", ["-c", `drop database if exists ${name}`], { allowFail: true });
  // The pre-check and one 0073 apply run as a role that is not a superuser and
  // owns nothing itself: a member of the owning role, as the hosted "postgres".
  must("postgres", `do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'ffprecheck') then create role ffprecheck nosuperuser in role postgres; end if;
    if not exists (select 1 from pg_roles where rolname = 'ff_other_owner') then create role ff_other_owner nosuperuser; end if; end $$;`);

  // ---- the file itself -------------------------------------------------------
  const file = readFileSync(PRECHECK, "utf8");
  const code = file.split("\n").filter((l) => !l.startsWith("--")).join("\n");
  const declared = [...code.matchAll(/^ {2}\((\d+), '((?:[^']|'')*)', array\[([^\]]*)\]::text\[\], '((?:[^']|'')*)',\n {6}'((?:[^']|'')*)'\)/gm)]
    .map((m) => ({ ord: Number(m[1]), name: m[2].replace(/''/g, "'"), needs: m[3], query: m[4].replace(/''/g, "'"), stop: m[5].replace(/''/g, "'") }));
  check(declared.length >= 45 && new Set(declared.map((c) => c.name)).size === declared.length && new Set(declared.map((c) => c.ord)).size === declared.length, `the pre-check declares its checks once each (${declared.length})`);
  check(declared.every((c) => /^select /.test(c.query) && !c.query.includes(";") && !/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|copy|call|lock|set)\b/i.test(c.query)), "every check is one SELECT");
  check(declared.every((c) => /^STOP: /.test(c.stop)), "every check has a STOP verdict in plain words");
  check(/^\s*with known\(names\) as \(/.test(code) && code.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((part) => part.trim()).length === 1, "the pre-check is a single statement (the SQL editor shows one grid)");
  // DB-03: one row per free-text rule of 0073, with the rule's own expression.
  const migration = readFileSync(MIGRATION, "utf8");
  const rulesAt = migration.indexOf("-- ── DB-03 / ATK N-A");
  const rules = [...migration.slice(rulesAt, migration.indexOf(") as t(tbl, con, expr) loop", rulesAt)).matchAll(/\('([a-z_]+)', '([a-z_]+)', '((?:[^']|'')*)'\)/g)].map((m) => ({ tbl: m[1], con: m[2], expr: m[3].replace(/''/g, "'") }));
  const textRows = declared.filter((c) => /^Text over the size limit|tags/.test(c.name));
  check(rules.length === 30 && textRows.length === rules.length, `the pre-check has one row per DB-03 rule of 0073 (${textRows.length} rows, ${rules.length} rules)`);
  for (const rule of rules) {
    const want = rule.con === "fans_tags_shape_check" ? "from public.fans where coalesce(array_length(tags, 1), 0) > 50 or exists (select 1 from unnest(tags) t where char_length(t) > 64)" : `from public.${rule.tbl} where not (${rule.expr})`;
    if (!declared.some((c) => c.query.endsWith(want))) { checks++; bad.push(`the pre-check has no row for the DB-03 rule ${rule.con} (${want})`); }
  }
  checks++;

  // ---- running it ------------------------------------------------------------
  /** @returns {{ status: number | null, rows: { name: string, n: number, verdict: string }[], error: string }} */
  const run = (db) => {
    const r = psql(db, ["-c", "set role ffprecheck; set default_transaction_read_only = on;", "-f", PRECHECK], { allowFail: true });
    const rows = (r.stdout || "").split("\n").filter((l) => l.split("|").length === 3).map((l) => { const [name, n, verdict] = l.split("|"); return { name, n: Number(n), verdict }; });
    return { status: r.status, rows, error: errorOf(r) };
  };
  const levels = [{ db: db38, label: "0038 (LIVE)", skipped: SKIPPED }, { db: db72, label: "0072 (TEST)", skipped: SKIPPED }, { db: dbLatest, label: "the newest level", skipped: [] }];
  const temp = [];
  try {
    for (const level of levels) {
      // Run on a clone so the other probes' leftovers in the newest database do not count, and nothing here touches it.
      const clean = clone(level.db, `ffpre_${levels.indexOf(level)}c`); temp.push(clean);
      if (level.db === dbLatest) must(clean, `set session_replication_role = replica; do $$ declare r record; begin for r in select c.oid::regclass as t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' loop execute format('truncate %s cascade', r.t); end loop; end $$;`);
      const a = run(clean);
      check(a.status === 0 && a.rows.length === declared.length, `at ${level.label} the pre-check runs without error in a read-only transaction and returns one row per check (${a.rows.length}/${declared.length}; ${a.error})`);
      check(a.rows.every((row) => row.verdict === "ok" || row.verdict === NOT_YET) && a.rows.every((row) => row.n === 0), `at ${level.label} a clean database is ok on every row (${a.rows.filter((row) => !/^ok/.test(row.verdict)).map((row) => row.name).join("; ") || "-"})`);
      const skipped = a.rows.filter((row) => row.verdict === NOT_YET).map((row) => row.name);
      check(JSON.stringify(skipped) === JSON.stringify(level.skipped), `at ${level.label} only the checks on columns 0073 creates are skipped (${skipped.join("; ") || "none"})`);
      const planted = clone(clean, `ffpre_${levels.indexOf(level)}p`); temp.push(planted);
      const p = psql(planted, ["-c", PLANT], { allowFail: true });
      if (p.status !== 0) { check(false, `at ${level.label} the violations could be planted (${errorOf(p)})`); continue; }
      const b = run(planted);
      const missed = b.rows.filter((row) => !skipped.includes(row.name) && !(/^STOP: /.test(row.verdict) && row.n >= 1)).map((row) => `${row.name}=${row.n}`);
      check(b.status === 0 && b.rows.length === declared.length && missed.length === 0, `at ${level.label} every check says STOP for its planted violation (${missed.join("; ") || b.error})`);
      check(b.rows.filter((row) => skipped.includes(row.name)).every((row) => row.verdict === NOT_YET), `at ${level.label} a skipped check stays skipped`);
    }

    // ---- M2: 0073 over a database at 0072 with over-long legacy rows -----------
    const legacy = clone(db72, "ffpre_m2"); temp.push(legacy);
    const fx = playFixtures(legacy, psqlAsync);
    const creator = await fx.addCreator(), wheel = await fx.addWheel(creator), who = await fx.addFan(creator, wheel.id);
    must(legacy, `update public.fans set notes = repeat('n', 2500) where id = '${who.fan}'; update public.prizes set description = repeat('d', 1500) where id = '${wheel.prizes.A}';`);
    const before = run(legacy);
    const stops = before.rows.filter((row) => /^STOP/.test(row.verdict)).map((row) => `${row.name}=${row.n}`);
    check(JSON.stringify(stops) === JSON.stringify(["Text over the size limit: fans.notes (2000 characters)=1", "Text over the size limit: prizes.description (1000 characters)=1"]), `M2: the pre-check names the two over-long legacy rows and nothing else (${stops.join("; ")})`);
    const applied = psql(legacy, ["-f", MIGRATION], { allowFail: true });
    const warnings = (applied.stderr || "").split("\n").filter((l) => /WARNING/.test(l)).join("\n");
    check(applied.status === 0 && must(legacy, "select public.schema_version()") === "73", `M2: 0073 applies over the over-long rows (${errorOf(applied)})`);
    check(/0073 \(DB-03\): 1 row\(s\) in public\.fans break fans_notes_len_check/.test(warnings) && /0073 \(DB-03\): 1 row\(s\) in public\.prizes break prizes_description_len_check/.test(warnings)
      && /free-text size rules NOT in force[^\n]*: fans_notes_len_check, prizes_description_len_check$/m.test(warnings), `M2: a WARNING names each rule and its count, and the closing check lists the rules not in force (${warnings.slice(0, 300)})`);
    const state = () => must(legacy, `select count(*) filter (where conname in ('fans_notes_len_check', 'prizes_description_len_check')) || ',' || count(*) filter (where not convalidated) || ',' || count(*) filter (where conname ~ '_len_check$|_shape_check$' and convalidated) from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c'`);
    check(state() === "0,0,28", `M2: the two rules are absent, the other 28 are validated, none is NOT VALID (${state()})`);
    check(must(legacy, `update public.fans set display_name = 'Legacy fan', tags = array['vip'] where id = '${who.fan}' returning char_length(notes)`).split("\n")[0] === "2500", "M2: the over-long row still updates");
    const attempt = await fx.prep(who), played = await psqlAsync(legacy, fx.commitSql(who, attempt));
    const ledger = must(legacy, `select p.spins_remaining || ',' || (select count(*) from public.spins where fan_id = '${who.fan}') from public.fan_passes p where p.id = '${who.pass}'`);
    check(/"spin"/.test(played.stdout || "") && ledger === "9,1", `M2: a play on that fan commits (${ledger}; ${(played.stderr || played.stdout || "").trim().slice(0, 160)})`);
    must(legacy, `update public.fans set notes = 'short' where id = '${who.fan}'; update public.prizes set description = 'short' where wheel_id = '${wheel.id}';`);
    const again = psql(legacy, ["-f", MIGRATION], { allowFail: true });
    check(again.status === 0 && state() === "2,0,30" && /every free-text size rule is in force/.test(again.stderr || ""), `M2: shortened and re-run, the two rules are added and validated (${state()}; ${errorOf(again)})`);
    const after = run(legacy);
    check(after.status === 0 && after.rows.length === declared.length && after.rows.every((row) => row.verdict === "ok"), `M2: the pre-check is ok on every row afterwards (${after.rows.filter((row) => row.verdict !== "ok").map((row) => row.name).join("; ") || after.error})`);

    // ---- 0073 as a non-superuser, with a function it does not own --------------
    const foreign = clone(db72, "ffpre_owner"); temp.push(foreign);
    must(foreign, `create function public.zz_foreign_owner() returns integer language sql set search_path = public as 'select 1'; alter function public.zz_foreign_owner() owner to ff_other_owner;`);
    const found = run(foreign).rows.find((row) => row.name === "Tables or functions that belong to another database role");
    check(found?.n === 1 && /^STOP/.test(found.verdict), `the pre-check finds a function owned by another role before the update (${found?.n} ${found?.verdict})`);
    const asMember = psql(foreign, ["-c", "set role ffprecheck;", "-f", MIGRATION], { allowFail: true });
    check(asMember.status === 0 && must(foreign, "select public.schema_version()") === "73", `0073 applies as a role that is not a superuser, with a function it cannot alter in the schema (${errorOf(asMember)})`);
    check(/WARNING: +0073 \(DB-15\): zz_foreign_owner\(\) is owned by another role and keeps search_path=public/.test(asMember.stderr || "")
      && /WARNING: +0073: functions owned by another role without a pinned search_path ending in pg_temp[^\n]*zz_foreign_owner\(\)/.test(asMember.stderr || ""), "the function owned by another role is skipped with a warning in the loop and named again by the closing check");
    check(must(foreign, `select proconfig::text from pg_proc where oid = 'public.zz_foreign_owner()'::regprocedure`) === "{search_path=public}"
      && must(foreign, `select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proconfig = array['search_path=public'] and p.proname <> 'zz_foreign_owner'`) === "0", "it is left as it was, and every function the migration role owns is pinned to public, pg_temp");
  } catch (e) {
    check(false, `go-live pre-check probe: ${String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 240)}`);
  } finally {
    for (const name of temp) drop(name);
  }
  return { bad, checks };
}
