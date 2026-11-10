// @ts-check
// 0073 batch-7 hardening probe. Run by schema-drift-check.mjs on every build
// path against a throwaway local Postgres, acting as real `anon`,
// `authenticated` and `service_role` sessions through the live grants,
// policies and triggers. Every check runs in its own transaction that is
// rolled back. One check per finding of the batch-7 audits (database DB-*,
// concurrency CC-*, attacker ATK-*, server RS-01, agency walk WG-*, trust
// TS-*, ops OPS*, performance PA-03); the staged concurrency cases (CC-01,
// CC-03, CC-07 and CC-02's commit) live in lockOrderProbe.mjs.
// Against the 0072 schema the catalog, privilege and behaviour checks fail.

const id = (n) => `00000000-0000-4000-8000-0000000073${n}`;
const A = id("a1"), A2 = id("a2"), B = id("b1"), OW = id("c1"), MG = id("c2"), CH = id("c3"), FU = id("c4"), AD = id("c5"), X = id("c6"), OW2 = id("c7");
const ORG = id("e1"), SEAT_OW = id("e2"), SEAT_MG = id("e3"), SEAT_CH = id("e4"), SEAT_FU = id("e5");
const WA = id("f1"), PA1 = id("f2"), PA2 = id("f3"), FA = id("d1"), PASS_A = id("81"), SPIN_A = id("71"), RED_A = id("61"), MSG_A = id("51"), GRANT_A = id("41"), ATT_A = id("31"), REPORT_A = id("21"), CAMP_A = id("11");
const TOKEN_A = "probe-0073-a";
const HEX = "a".repeat(64);
const DIAG = "public.run_reward_ledger_invariants()";

// 0073 adds no signed-in SECURITY DEFINER function (the replayed 0072 closing
// check admits none): the three dashboard summaries are service-only behind a
// route's can_act_for check, the two Terms-notice RPCs are SECURITY INVOKER.
/** DB-14: legacy shells dropped by 0073 (regprocedure spellings). */
export const DROPPED_0073 = [
  "import_fans(jsonb)", "credit_pass_spins(uuid,integer)", "claim_spin(text)", "rollback_claimed_spin(text,uuid)",
  "cancel_fan_focus(uuid,uuid,uuid,uuid)", "reconcile_creator_request(uuid,uuid,uuid,text,boolean,boolean)",
  "edit_pass_grant(uuid,uuid,uuid,jsonb,uuid)", "grant_focus_pack(uuid,uuid,uuid,uuid,uuid,uuid,uuid)", "import_fans_durable(uuid,uuid,text,jsonb,uuid)",
  "save_wheel_prizes(uuid,uuid,jsonb)", "save_game_wheel(uuid,uuid,uuid,jsonb,jsonb,uuid)",
];
/** DB-14: shells kept on purpose (a drift probe or a fixture still calls them). */
export const KEPT_0073 = ["finalize_reward_spin(jsonb,jsonb)", "reserve_reward_code(uuid,uuid)", "release_reward_code(uuid)", "_spin_attempt_context(uuid)",
  "_creator_default_wheel(uuid,uuid)", "edit_pass_grant(uuid,uuid,integer,integer,integer,uuid,boolean,boolean,boolean)", "_creator_actor_grant_allowed(uuid,uuid)", "_game_actor_edit_allowed(uuid,uuid)", "cancel_fan_focus(uuid,uuid,uuid)"];

const SEED = `
  insert into auth.users (id, email, email_confirmed_at) values
    ('${A}', 'probe-0073-a@example.test', now()), ('${A2}', 'probe-0073-a2@example.test', now()), ('${B}', 'probe-0073-b@example.test', now()),
    ('${OW}', 'probe-0073-ow@example.test', now()), ('${MG}', 'probe-0073-mg@example.test', now()), ('${CH}', 'probe-0073-ch@example.test', now()),
    ('${FU}', 'probe-0073-fu@example.test', now()), ('${AD}', 'probe-0073-ad@example.test', now()), ('${X}', 'probe-0073-x@example.test', now()),
    ('${OW2}', 'probe-0073-ow2@example.test', now());
  update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${A2}', '${B}', '${OW}', '${MG}', '${CH}', '${FU}', '${AD}', '${OW2}');
  update public.profiles set role = 'admin' where id = '${AD}';
  insert into public.orgs (id, name, owner_id) values ('${ORG}', 'probe 0073 org', '${OW}');
  insert into public.org_members (id, org_id, profile_id, role) values
    ('${SEAT_OW}', '${ORG}', '${OW}', 'owner'), ('${SEAT_MG}', '${ORG}', '${MG}', 'manager'), ('${SEAT_CH}', '${ORG}', '${CH}', 'chatter'), ('${SEAT_FU}', '${ORG}', '${FU}', 'fulfiller');
  insert into public.org_member_creators (member_id, creator_id) values ('${SEAT_CH}', '${A}'), ('${SEAT_FU}', '${A}');
  update public.profiles set org_id = '${ORG}' where id in ('${A}', '${A2}');
  insert into public.wheels (id, creator_id, title, is_active) values ('${WA}', '${A}', 'probe 0073', true);
  insert into public.prizes (id, wheel_id, label, rarity, weight, sort_order) values ('${PA1}', '${WA}', 'one', 'common', 10, 0), ('${PA2}', '${WA}', 'two', 'common', 10, 1);
  insert into public.campaigns (id, creator_id, name) values ('${CAMP_A}', '${A}', 'launch');
  insert into public.fans (id, creator_id, display_name, acked_at, acked_terms_version) values ('${FA}', '${A}', 'Fan A', now(), public.legal_terms_version());
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id, campaign_id) values ('${PASS_A}', '${TOKEN_A}', '${A}', '${WA}', '${FA}', '${CAMP_A}');
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity, campaign_id)
    values ('${SPIN_A}', '${PASS_A}', '${A}', '${WA}', '${FA}', '${PA1}', 'one', 'common', '${CAMP_A}');
  insert into public.grants (id, creator_id, fan_id, campaign_id, spins, amount_cents, fan_pass_id) values ('${GRANT_A}', '${A}', '${FA}', '${CAMP_A}', 5, 1500, '${PASS_A}');
  update public.fan_passes set spins_remaining = 5, spins_granted_total = 5 where id = '${PASS_A}';
  update public.fans set spins_remaining = 5, spins_granted_total = 5 where id = '${FA}';
  set local fanfunnel.economic_write = 'off';
  insert into public.redemptions (id, creator_id, spin_id, notes, due_at) values ('${RED_A}', '${A}', '${SPIN_A}', 'ship to the home address', now() + interval '3 days');
  insert into public.messages (id, creator_id, fan_id, sender, body) values ('${MSG_A}', '${A}', '${FA}', 'fan', 'hello');
  insert into public.spin_attempts (id, creator_id, fan_id, fan_pass_id, token_hash, request_hash, state, context, created_at)
    values ('${ATT_A}', '${A}', '${FA}', '${PASS_A}', '${HEX}', '${HEX}', 'pending', '{"seed":"x"}', now() - interval '2 days');
  insert into public.creator_reports (id, creator_id, fan_id, token, reason) values ('${REPORT_A}', '${A}', '${FA}', '${TOKEN_A}', 'spam');`;
const claims = (uid, aal = "aal1") =>
  `select set_config('request.jwt.claim.sub', '${uid}', true); select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated","aal":"${aal}"}', true);`;
const clear = `reset role; select set_config('request.jwt.claim.sub', '', true); select set_config('request.jwt.claims', '', true);`;
const as = (uid, stmt, aal = "aal1") => `set local role authenticated; ${claims(uid, aal)} ${stmt} ${clear}`;
const service = (stmt) => `set local role service_role; ${stmt} reset role;`;
// A real actor context minted the way the app does it (stub auth session,
// authenticated RPC), kept in a temp table for the service call that follows.
const mint = (actor, creator, scope) => `insert into auth.sessions (id, user_id) values ('${id("99")}', '${actor}');
  set local role authenticated; select set_config('request.jwt.claim.sub', '${actor}', true);
  select set_config('request.jwt.claims', '{"sub":"${actor}","role":"authenticated","session_id":"${id("99")}","aal":"aal1","exp":${Math.floor(Date.now() / 1000) + 3600}}', true);
  create temp table ctx as select public.issue_creator_actor_context('${creator}', '${scope}') as id; grant select on ctx to public; ${clear}`;
// Counted for the seeded creator only: other probes leave committed rows behind.
const counts = (uid, aal) => as(uid, `select 'messages:' || count(*) from public.messages where creator_id = '${A}'; select 'redemptions:' || count(*) from public.redemptions where creator_id = '${A}';
  select 'grants:' || count(*) from public.grants where creator_id = '${A}'; select 'attempts:' || count(*) from public.spin_attempts where creator_id = '${A}';`, aal);
const want = (m, r, g, a) => [`messages:${m}`, `redemptions:${r}`, `grants:${g}`, `attempts:${a}`];

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {{ bad: string[], checks: number }}
 */
export function probeBatch7(db, psql) {
  const bad = [];
  let checks = 0;
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const q = (sql) => (psql(db, ["-c", sql], { allowFail: true }).stdout || "").trim();
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const expect = (label, body, want) => {
    checks++;
    const r = run(body);
    const got = out(r);
    const missing = want.filter((w) => !got.includes(w));
    if (r.status !== 0 || missing.length) bad.push(`${label} (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ").slice(0, 300)}; ${r.status !== 0 ? err(r) : "ok"})`);
  };
  const refused = (label, body, pattern) => {
    checks++;
    const r = run(body);
    if (!pattern.test(r.stderr || "")) bad.push(`${label} was not refused (${err(r)}; out ${out(r).filter(Boolean).join(" ").slice(0, 200)})`);
  };
  const same = (label, got, want) => {
    checks++;
    if (got !== want) bad.push(`${label}: expected ${want}, got ${got}`);
  };

  // ── catalog ───────────────────────────────────────────────────────────────
  same("schema_version() is 73", q("select public.schema_version()"), "73");
  same("legal_terms_version() is the batch-7 version (TS-01)", q("select public.legal_terms_version()"), "2026-11-11");
  same("DB-07: the seven ledger CHECKs exist and are validated", q(`select count(*) from pg_constraint where convalidated and conname in ('fan_passes_spins_granted_total_check','fans_spins_granted_total_check','fans_rl_count_check','prizes_stock_check','prizes_cost_cents_check','fan_passes_spins_remaining_check','fans_spins_remaining_check')`), "7");
  same("DB-03: the thirty free-text CHECKs exist and are validated on a clean database", q(`select count(*) from pg_constraint where convalidated and contype = 'c' and conname ~ '_len_check$|_shape_check$' and conrelid::regclass::text in ('fans','prizes','wheels','wheel_templates','campaigns','orgs','wishlists','dm_templates','prize_templates','campaign_packs','profiles','creator_applications')`), "30");
  same("DB-01: every creator-owned table carries zz_creator_immutable", q(`select (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'zz_creator_immutable' and c.relnamespace = 'public'::regnamespace) = (select count(*) from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'creator_id' and not a.attisdropped where c.relnamespace = 'public'::regnamespace and c.relkind = 'r')`), "t");
  same("DB-15: no public function pins search_path to public alone", q(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proconfig::text = '{search_path=public}'`), "0");
  for (const sig of DROPPED_0073) same(`DB-14: ${sig} is gone`, q(`select to_regprocedure('public.${sig}') is null`), "t");
  for (const sig of KEPT_0073) same(`DB-14: ${sig} is kept`, q(`select to_regprocedure('public.${sig}') is not null`), "t");
  same("PA-03: the six composite indexes exist", q(`select count(*) from pg_indexes where schemaname = 'public' and indexname in ('spins_creator_id_id_idx','grants_creator_id_id_idx','fan_passes_creator_id_id_idx','fans_creator_created_idx','spins_creator_created_idx','grants_creator_created_idx')`), "6");
  same("new columns exist (PR-13 expires_at, WG-07 actor_id, DB-02 decision_reason)", q(`select count(*) from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (('fan_passes','expires_at'),('messages','actor_id'),('redemptions','actor_id'),('creator_applications','decision_reason'))`), "4");
  same("ATK N-C: one access request per account", q(`select count(*) from pg_constraint where conname = 'creator_applications_profile_id_key' and contype = 'u'`), "1");
  same("TS-05/TS-06: the two new tables have RLS and a policy", q(`select count(*) from pg_class c where c.relname in ('legal_terms_notice','fan_consent_evidence') and c.relrowsecurity and exists (select 1 from pg_policy where polrelid = c.oid)`), "2");
  same("DB-05/09/16: the session role lost the direct writes", q(`select has_table_privilege('authenticated','public.prizes','UPDATE') or has_table_privilege('authenticated','public.prizes','DELETE') or has_table_privilege('authenticated','public.creator_reports','DELETE') or has_table_privilege('authenticated','public.creator_applications','DELETE') or has_table_privilege('authenticated','public.profiles','INSERT') or has_table_privilege('authenticated','public.profiles','DELETE') or has_table_privilege('authenticated','public.spins','INSERT') or has_table_privilege('authenticated','public.spins','UPDATE') or has_table_privilege('authenticated','public.spins','DELETE')`), "f");
  same("the service role keeps the prize and ledger writes", q(`select has_table_privilege('service_role','public.prizes','UPDATE') and has_table_privilege('service_role','public.spins','INSERT') and has_table_privilege('service_role','public.creator_applications','DELETE')`), "t");
  same("the dashboard summaries and record_fan_ack are service only", q(`select bool_and(has_function_privilege('service_role', s, 'EXECUTE') and not has_function_privilege('authenticated', s, 'EXECUTE') and not has_function_privilege('anon', s, 'EXECUTE')) from unnest(array['public.creator_obligations(uuid)','public.creator_fan_summaries(uuid,text,timestamptz,uuid,integer)','public.creator_analytics_summary(uuid,integer)','public.record_fan_ack(text,text,text)']) s`), "t");
  same("the Terms-notice RPCs are signed-in SECURITY INVOKER functions", q(`select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE') and not p.prosecdef) from pg_proc p where p.oid in ('public.legal_terms_upcoming()'::regprocedure, 'public.set_legal_terms_notice(text,date)'::regprocedure)`), "t");
  same("no signed-in SECURITY DEFINER function was added (the 0072 closing check replays)", q(`select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname in ('creator_obligations','creator_fan_summaries','creator_analytics_summary','legal_terms_upcoming','set_legal_terms_notice','record_fan_ack')`), "0");
  for (const fn of ["set_redemption_state", "archive_wheel", "delete_wheel", "delete_campaign"]) {
    same(`CC-03: ${fn} re-checks authority after its last lock`, q(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '${fn}' and prosrc like '%0073 (CC-03)%'`), "1");
  }
  same("CC-07: _lock_wheel_lifecycle pre-locks the fans' links", q(`select (prosrc like '%from public.fan_passes where fan_id in%for update nowait%')::text from pg_proc where pronamespace = 'public'::regnamespace and proname = '_lock_wheel_lifecycle'`), "true");
  same("CC-01: reset_creator_content deletes the fans itself under its pre-locks", q(`select (prosrc like '%delete from public.fans where creator_id = p_creator;%')::text from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reset_creator_content'`), "true");

  // ── DB-01: creator_id is immutable ────────────────────────────────────────
  refused("DB-01: a manager seat cannot move a fan to another creator of its agency", as(MG, `update public.fans set creator_id = '${A2}' where id = '${FA}';`), /creator_id is immutable/);
  refused("DB-01: a manager seat cannot move a campaign", as(MG, `update public.campaigns set creator_id = '${A2}' where id = '${CAMP_A}';`), /creator_id is immutable/);
  refused("DB-01: the service role cannot move a fan either", service(`update public.fans set creator_id = '${A2}' where id = '${FA}';`), /creator_id is immutable/);
  expect("DB-01: an account deletion still detaches its safety reports (SET NULL after the profile is gone)",
    `delete from public.spin_attempts where creator_id = '${A}'; delete from auth.users where id = '${A}'; select 'report:' || coalesce(creator_id::text, 'null') from public.creator_reports where id = '${REPORT_A}';`, ["report:null"]);

  // ── DB-05 / DB-09 / DB-16: direct writes the session role lost ───────────
  refused("DB-05: a creator session cannot UPDATE a prize directly", as(A, `update public.prizes set label = 'x' where id = '${PA1}';`), /permission denied for table prizes/);
  refused("DB-05: a creator session cannot DELETE a prize directly", as(A, `delete from public.prizes where id = '${PA1}';`), /permission denied for table prizes/);
  refused("DB-09: a creator session cannot DELETE a safety report", as(A, `delete from public.creator_reports where id = '${REPORT_A}';`), /permission denied for table creator_reports/);
  refused("DB-16: a creator session cannot INSERT a profile", as(A, `insert into public.profiles (id) values ('${id("00")}');`), /permission denied for table profiles/);
  refused("DB-16: a creator session cannot UPDATE a spin", as(A, `update public.spins set prize_label = 'x' where id = '${SPIN_A}';`), /permission denied for table spins/);
  expect("DB-05: the editors still write prizes for the service role", service(`update public.prizes set label = 'uno' where id = '${PA1}'; select 'label:' || label from public.prizes where id = '${PA1}';`), ["label:uno"]);

  // ── ATK-05: the four read policies follow the seat's job ──────────────────
  expect("ATK-05: a chat seat reads the chat and nothing else", counts(CH), want(1, 0, 0, 0));
  expect("ATK-05: a fulfil seat reads the queue and nothing else", counts(FU), want(0, 1, 0, 0));
  expect("ATK-05: a manager seat reads all four", counts(MG), want(1, 1, 1, 1));
  expect("ATK-05: the agency owner reads all four", counts(OW), want(1, 1, 1, 1));
  expect("ATK-05: the creator reads its own rows", counts(A), want(1, 1, 1, 1));
  expect("ATK-05: a suspended creator still reads its own rows (read-only dashboard)", `update public.profiles set is_active = false where id = '${A}'; ${counts(A)}`, want(1, 1, 1, 1));
  expect("ATK-05: another tenant reads nothing", counts(B), want(0, 0, 0, 0));
  expect("ATK-05: an admin without MFA reads nothing", counts(AD), want(0, 0, 0, 0));
  expect("ATK-05: an admin with MFA reads all four", counts(AD, "aal2"), want(1, 1, 1, 1));

  // ── DB-02 / ATK N-C: an access request is pinned to its applicant ────────
  expect("DB-02: a session insert is pinned to the signed-in applicant with status pending",
    as(X, `insert into public.creator_applications (profile_id, email, status, created_at, decided_at, decision_reason, note) values ('${B}', 'spoof@example.test', 'approved', now() - interval '10 days', now(), 'self-approved', 'hi');
      select 'app:' || profile_id || ',' || email || ',' || status || ',' || (created_at > now() - interval '1 minute')::text || ',' || coalesce(decided_at::text, 'null') || ',' || coalesce(decision_reason, 'null') from public.creator_applications where profile_id = '${X}';`),
    [`app:${X},probe-0073-x@example.test,pending,true,null,null`]);
  refused("ATK N-C: a second request by the same account is refused", as(X, `insert into public.creator_applications (profile_id, note) values ('${X}', 'one'); insert into public.creator_applications (profile_id, note) values ('${X}', 'two');`), /creator_applications_profile_id_key/);
  refused("DB-02: an applicant cannot delete its request", as(X, `insert into public.creator_applications (profile_id, note) values ('${X}', 'one'); delete from public.creator_applications where profile_id = '${X}';`), /permission denied for table creator_applications/);
  refused("DB-03: an over-long note is refused", as(X, `insert into public.creator_applications (profile_id, note) values ('${X}', repeat('x', 1001));`), /creator_applications_note_len_check/);
  expect("DB-02: the service role (admin decision path) keeps its own values", service(`insert into public.creator_applications (profile_id, email, status, decided_at, decision_reason) values ('${A2}', 'kept@example.test', 'rejected', now(), 'no socials');
    select 'svc:' || email || ',' || status || ',' || decision_reason from public.creator_applications where profile_id = '${A2}';`), ["svc:kept@example.test,rejected,no socials"]);

  // ── DB-03 / ATK N-A: free text is bounded ────────────────────────────────
  refused("DB-03: set_chat_settings refuses 2001 characters", as(A, `select public.set_chat_settings(repeat('x', 2001), 'bye');`), /invalid chat settings/);
  refused("DB-03: set_chat_settings refuses control characters", as(A, `select public.set_chat_settings('hi' || chr(7), 'bye');`), /invalid chat settings/);
  expect("DB-03: set_chat_settings keeps 2000 characters", as(A, `select public.set_chat_settings(repeat('x', 2000), E'line one\\nline two'); select 'intro:' || char_length(chat_intro) || ',' || char_length(chat_outro) from public.profiles where id = '${A}';`), ["intro:2000,17"]);
  refused("DB-03: set_creator_note refuses 2001 characters", as(A, `select public.set_creator_note(repeat('x', 2001), null);`), /invalid creator note/);
  refused("DB-03: a direct fan note over 2000 characters is refused", as(MG, `update public.fans set notes = repeat('x', 2001) where id = '${FA}';`), /fans_notes_len_check/);
  refused("DB-03: more than 50 tags are refused", as(MG, `update public.fans set tags = (select array_agg('t' || g) from generate_series(1, 51) g) where id = '${FA}';`), /fans_tags_shape_check/);
  refused("DB-03: a 121-character campaign name is refused even for the service role", service(`insert into public.campaigns (creator_id, name) values ('${A}', repeat('x', 121));`), /campaigns_name_len_check/);
  refused("DB-03: a 2001-character DM template body is refused", as(A, `insert into public.dm_templates (creator_id, title, body) values ('${A}', 't', repeat('x', 2001));`), /dm_templates_body_len_check|permission denied/);

  // ── TS-03: reserved names and slugs ───────────────────────────────────────
  refused("TS-03: a display name impersonating the product is refused", as(A, `select public.set_display_name('FanFunnel Support');`), /reserved display name/);
  refused("TS-03: a display name with a staff word is refused", as(A, `select public.set_display_name('Official Moderator');`), /reserved display name/);
  refused("TS-03: 'admin' is refused as a display name", as(A, `select public.set_display_name('admin');`), /reserved display name/);
  expect("TS-03: an ordinary display name is kept", as(A, `select public.set_display_name('Alice Adminton'); select 'name:' || display_name from public.profiles where id = '${A}';`), ["name:Alice Adminton"]);
  refused("TS-03: a reserved slug is refused", as(A, `select public.set_public_profile('support', null, null);`), /reserved slug/);
  refused("TS-03: a product-name slug is refused", as(A, `select public.set_public_profile('fan-funnel', null, null);`), /reserved slug/);
  expect("TS-03: an ordinary slug is kept", as(A, `select public.set_public_profile('alice', null, null); select 'slug:' || public_slug from public.profiles where id = '${A}';`), ["slug:alice"]);
  refused("TS-03: the profile guard refuses a reserved slug written directly", service(`update public.profiles set public_slug = 'admin' where id = '${A}';`), /reserved slug/);

  // ── DB-06: a deleted fan's links are tombstoned ───────────────────────────
  expect("DB-06: deleting a fan tombstones its link tokens", service(`delete from public.fans where id = '${FA}';
    select 'tomb:' || reason from public.link_tombstones where token_hash = encode(sha256(convert_to('${TOKEN_A}', 'UTF8')), 'hex');`), ["tomb:fan_deleted"]);

  // ── DB-04 / CC-08 / DB-08 / OPS-06: retention ─────────────────────────────
  {
    checks++;
    const r = run(`insert into public.spin_attempts (id, creator_id, fan_id, fan_pass_id, token_hash, request_hash, state, context, created_at)
        values ('${id("32")}', '${A}', '${FA}', '${PASS_A}', '${HEX}', '${HEX}', 'pending', '{"seed":"y"}', now() - interval '1 hour');
      ${service(`insert into public.creator_applications (profile_id, status, decided_at) values ('${A2}', 'rejected', now() - interval '91 days'), ('${B}', 'rejected', now() - interval '10 days'), ('${X}', 'pending', null);`)}
      ${service(`select public.run_retention_cleanup(365, 90, 180, 90, 90)::text;`)}
      select 'advisory:' || (count(*) > 0)::text from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();
      select 'stale:' || state || ',' || coalesce(error, 'null') || ',' || coalesce(context::text, 'null') || ',' || (finished_at is not null)::text from public.spin_attempts where id = '${ATT_A}';
      select 'fresh:' || state || ',' || coalesce(error, 'null') from public.spin_attempts where id = '${id("32")}';
      select 'apps:' || string_agg(profile_id::text, ',' order by profile_id) from public.creator_applications where profile_id in ('${A2}', '${B}', '${X}');`);
    const lines = out(r);
    const result = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}");
    const line = (p) => lines.find((l) => l.startsWith(p)) ?? "";
    const ok = r.status === 0 && result.stale_spin_attempts === 1 && result.declined_applications === 1 && JSON.stringify(result.declined_applicant_ids) === JSON.stringify([A2])
      && line("stale:") === "stale:declined,stale,null,true" && line("fresh:") === "fresh:pending,null" && line("apps:") === `apps:${[B, X].sort().join(",")}` && line("advisory:") === "advisory:true";
    if (!ok) bad.push(`retention (CC-08 stale attempts, DB-04 declined requests after 90 days, DB-08 advisory lock): ${JSON.stringify(result)} ${line("stale:")} ${line("fresh:")} ${line("apps:")} ${line("advisory:")} ${r.status !== 0 ? err(r) : ""}`);
  }
  expect("DB-08: creator_storage_prune takes the retention advisory lock", service(`select public.creator_storage_prune(30);`) + ` select 'advisory:' || (count(*) > 0)::text from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();`, ["advisory:true"]);

  // ── OPS3-05: the canary failure latch clears on a verified healthy run ───
  expect("OPS3-05: a healthy maintenance run with a healthy ledger clears the latch; a startup blip does not",
    `select public.record_system_health_check('startup', 'mismatch');
     select 'startup:' || ((public.record_system_health_check('startup', 'healthy')->>'canaryFailureAt') is not null)::text;
     select 'maint:' || ((public.record_system_health_check('maintenance', 'healthy', ${DIAG})->>'canaryFailureAt') is null)::text;
     select public.record_system_health_check('manual', 'mismatch');
     select 'maintplain:' || ((public.record_system_health_check('maintenance', 'healthy')->>'canaryFailureAt') is null)::text;
     select public.record_system_health_check('manual', 'mismatch');
     select 'violations:' || ((public.record_system_health_check('maintenance', 'healthy', jsonb_set(jsonb_set(${DIAG}, '{counts,fanCreditMismatch}', '1'), '{status}', '"violations"'))->>'canaryFailureAt') is not null)::text;
     select 'manual:' || ((public.record_system_health_check('manual', 'healthy')->>'canaryFailureAt') is null)::text;`,
    ["startup:true", "maint:true", "maintplain:true", "violations:true", "manual:true"]);

  // ── CC-01: the owner's reset deletes the fans itself ──────────────────────
  expect("CC-01: reset_creator_content removes fans, links, campaigns and games in one call",
    `${mint(A, A, "edit_wheel")} ${service(`select 'reset:' || public.reset_creator_content((select id from ctx), '${A}', '${A}');`)}
     select 'left:' || (select count(*) from public.fans where creator_id = '${A}') || ',' || (select count(*) from public.fan_passes where creator_id = '${A}') || ',' || (select count(*) from public.campaigns where creator_id = '${A}') || ',' || (select count(*) from public.wheels where creator_id = '${A}');`,
    ["reset:ok", "left:0,0,0,0"]);

  // ── CC-02 / RS-01 / PR-13: attempts, status reads and link expiry ─────────
  expect("RS-01: a status read with no attempt and no link is not_found; a paused link is unavailable; a live link is absent",
    service(`select 'none:' || (public.get_spin_attempt_status('${id("33")}', 'no-such-token', '${HEX}')->>'status');
      select 'live:' || (public.get_spin_attempt_status('${id("33")}', '${TOKEN_A}', '${HEX}')->>'status');
      update public.fan_passes set is_active = false where id = '${PASS_A}';
      select 'paused:' || (public.get_spin_attempt_status('${id("33")}', '${TOKEN_A}', '${HEX}')->>'status');`),
    ["none:not_found", "live:absent", "paused:unavailable"]);
  expect("CC-02: a prepared attempt whose link is paused before cancel/commit is declined as blocked and stays answered that way",
    service(`select 'prep:' || (public.prepare_spin_attempt('${id("34")}', '${TOKEN_A}', '${HEX}')->>'status');
      update public.fan_passes set is_active = false where id = '${PASS_A}';
      select 'cancel:' || (public.cancel_spin_attempt('${id("34")}', '${TOKEN_A}', '${HEX}', 'cancelled')->>'status') || ',' || (public.cancel_spin_attempt('${id("34")}', '${TOKEN_A}', '${HEX}', 'cancelled')->>'error');
      select 'row:' || state || ',' || error from public.spin_attempts where id = '${id("34")}';
      select 'status:' || (public.get_spin_attempt_status('${id("34")}', '${TOKEN_A}', '${HEX}')->>'status') || ',' || (public.get_spin_attempt_status('${id("34")}', '${TOKEN_A}', '${HEX}')->>'error');`),
    ["prep:ready", "cancel:declined,blocked", "row:declined,blocked", "status:declined,blocked"]);
  expect("PR-13: an expired link cannot prepare a play and reads as unavailable",
    service(`update public.fan_passes set expires_at = now() - interval '1 hour' where id = '${PASS_A}';
      select 'prep:' || (public.prepare_spin_attempt('${id("35")}', '${TOKEN_A}', '${HEX}')->>'status');
      select 'status:' || (public.get_spin_attempt_status('${id("36")}', '${TOKEN_A}', '${HEX}')->>'status');
      update public.fan_passes set expires_at = now() + interval '1 hour' where id = '${PASS_A}';
      select 'future:' || (public.prepare_spin_attempt('${id("37")}', '${TOKEN_A}', '${HEX}')->>'status');`),
    ["prep:unavailable", "status:unavailable", "future:ready"]);

  // ── CC-04: a seat's authority is held while its write runs ───────────────
  expect("CC-04: _creator_actor_allowed holds the seat row (key share) for the transaction",
    `${mint(MG, A, "grant")} select 'allowed:' || public._creator_actor_allowed((select id from ctx), '${MG}', '${A}', 'grant', 'grant')::text;
     select 'seatlock:' || (count(*) > 0)::text from pg_locks where relation = 'public.org_members'::regclass and pid = pg_backend_pid() and mode = 'RowShareLock';`,
    ["allowed:true", "seatlock:true"]);
  same("CC-04: _creator_actor_allowed takes the seat row for key share", q(`select (prosrc like '%for key share of m%')::text from pg_proc where pronamespace = 'public'::regnamespace and proname = '_creator_actor_allowed'`), "true");

  // ── CC-05: the service-side editors refuse a suspended creator ────────────
  const prizes = `'[{"id":"${PA1}","label":"one","rarity":"common","weight":10,"stock":null},{"id":"${PA2}","label":"two","rarity":"common","weight":10,"stock":null}]'::jsonb`;
  refused("CC-05: save_wheel_prizes refuses a suspended creator after its locks", `update public.profiles set is_active = false where id = '${A}'; ${service(`select public.save_wheel_prizes('${WA}', '${A}', ${prizes});`)}`, /creator_unavailable/);
  refused("CC-05: set_prize_delivery refuses a suspended creator", `update public.profiles set is_active = false where id = '${A}'; ${service(`select public.set_prize_delivery('${PA1}', '${A}', 'manual', null, null, null);`)}`, /creator_unavailable/);
  refused("CC-05: add_reward_codes refuses a suspended creator", `update public.profiles set is_active = false where id = '${A}'; ${service(`select public.add_reward_codes('${PA1}', '${A}', '["CODE-1"]');`)}`, /creator_unavailable/);

  // ── DB-11: the game version is compared under the lock ───────────────────
  refused("DB-11: save_wheel_prizes with a stale updated_at is game_changed", service(`select public.save_wheel_prizes('${WA}', '${A}', ${prizes}, now() - interval '1 hour');`), /game_changed/);
  expect("DB-11: save_wheel_prizes with the current updated_at saves; a stock-only edit keeps the version (and the fans' contexts), a label edit advances it",
    `update public.wheels set updated_at = now() - interval '1 minute' where id = '${WA}';
     ${service(`select public.save_wheel_prizes('${WA}', '${A}', ${prizes.replace('"stock":null},{"id"', '"stock":7},{"id"')}, (select updated_at from public.wheels where id = '${WA}'));`)}
     select 'stock-only:' || (updated_at < now() - interval '30 seconds')::text || ',' || (select stock from public.prizes where id = '${PA1}') from public.wheels where id = '${WA}';
     ${service(`select public.save_wheel_prizes('${WA}', '${A}', ${prizes.replace('"label":"one"', '"label":"uno"')}, (select updated_at from public.wheels where id = '${WA}'));`)}
     select 'stamped:' || (updated_at > now() - interval '10 seconds')::text from public.wheels where id = '${WA}';`, ["stock-only:true,7", "stamped:true"]);

  // ── DB-12: a bingo draft is saved unready and inactive ───────────────────
  expect("DB-12: save_game_wheel(p_ready => false) stores a draft without the readiness check",
    `update public.profiles set features = coalesce(features, '{}'::jsonb) || '{"bingo":true}'::jsonb where id = '${A}';
     insert into public.wheels (id, creator_id, title) values ('${id("f4")}', '${A}', 'draft');
     insert into public.prizes (id, wheel_id, label, rarity, weight, sort_order) values ('${id("f5")}', '${id("f4")}', 'one', 'common', 10, 0), ('${id("f6")}', '${id("f4")}', 'two', 'common', 10, 1);
     ${mint(A, A, "edit_wheel")} ${service(`select public.save_game_wheel((select id from ctx), '${id("f4")}', '${A}', '[{"id":"${id("f5")}","label":"one","rarity":"common","weight":10,"stock":null},{"id":"${id("f6")}","label":"two","rarity":"common","weight":10,"stock":null}]'::jsonb, '{"game_kind":"bingo","game_config":{"size":3,"linePrizeId":null}}'::jsonb, '${A}', false);`)}
     select 'draft:' || game_kind || ',' || game_ready::text || ',' || is_active::text || ',' || coalesce(active_from::text, 'null') from public.wheels where id = '${id("f4")}';`,
    ["draft:bingo,false,false,null"]);

  // ── DB-13 / DB-17 / DB-10 / PA-03: the dashboard read RPCs ───────────────
  expect("DB-13: creator_obligations counts the open prize, the fan owed, the credit and the live link",
    service(`select 'ob:' || (o->>'openPrizes') || ',' || (o->>'fansOwed') || ',' || (o->>'unplayedPaidSpins') || ',' || (o->>'unplayedSpins') || ',' || (o->>'fansWithCredit') || ',' || (o->>'liveFocus') || ',' || (o->>'heldChase') || ',' || (o->>'activeLinks') from public.creator_obligations('${A}') o;`),
    ["ob:1,1,5,5,1,0,0,1"]);
  refused("DB-13: a session cannot call creator_obligations directly (the route checks can_act_for and uses the service role)", as(A, `select public.creator_obligations('${A}');`), /permission denied for function creator_obligations/);
  expect("DB-17: my_seat_creators reports can_manage", as(CH, `select 'ch:' || can_chat::text || ',' || can_fulfil::text || ',' || can_manage::text from public.my_seat_creators();`) + as(MG, `select 'mg:' || can_chat::text || ',' || can_fulfil::text || ',' || can_manage::text from public.my_seat_creators() where creator_id = '${A}';`), ["ch:true,false,false", "mg:true,true,true"]);
  expect("DB-10: the redemption queue carries fan_id", as(A, `select 'queue:' || coalesce(fan_id::text, 'null') from public.creator_redemption_queue(null, null, null, null, 50, null);`), [`queue:${FA}`]);
  expect("PA-03: creator_fan_summaries summarises the fan in SQL (newest first, keyset, search, totals)",
    service(`select 'fan:' || fan_id || ',' || display_name || ',' || spins_remaining || ',' || total_spent_cents || ',' || grant_count || ',' || array_to_string(campaign_names, '+') || ',' || coalesce(last_win_label, 'null') || ',' || wins || ',' || links || ',' || active_links || ',' || self_excluded::text || ',' || total_fans from public.creator_fan_summaries('${A}');
      select 'search:' || count(*) from public.creator_fan_summaries('${A}', 'nomatch');
      select 'page:' || count(*) from public.creator_fan_summaries('${A}', null, (select created_at from public.fans where id = '${FA}'), '${FA}', 50);
      select 'nobody:' || count(*) from public.creator_fan_summaries(null);`),
    [`fan:${FA},Fan A,5,1500,1,launch,one,1,1,1,false,1`, "search:0", "page:0", "nobody:0"]);
  refused("PA-03: a session cannot call creator_fan_summaries directly", as(A, `select count(*) from public.creator_fan_summaries('${A}');`), /permission denied for function creator_fan_summaries/);
  expect("PA-03: creator_analytics_summary aggregates in SQL and answers null to another tenant",
    service(`select 'an:' || (s->>'days') || ',' || jsonb_array_length(s->'spinsByDay') || ',' || (s->'funnel'->>'fans') || ',' || (s->'funnel'->>'spun') || ',' || (s->'activeFans'->>'thisWeek') || ',' || (s->'profit'->>'revenueCents') || ',' || jsonb_array_length(s->'prizeRoi') || ',' || (s->'cohorts'->0->>'campaignName') || ',' || (s->'cohorts'->0->>'fans') from public.creator_analytics_summary('${A}', 30) s;
      select 'nobody:' || coalesce(public.creator_analytics_summary(null)::text, 'null');`),
    ["an:30,1,1,1,1,1500,1,launch,1", "nobody:null"]);
  refused("PA-03: a session cannot call creator_analytics_summary directly", as(A, `select public.creator_analytics_summary('${A}');`), /permission denied for function creator_analytics_summary/);

  // ── WG-02 / ATK-06: agencies ──────────────────────────────────────────────
  expect("WG-02: org_create seats its owner; the owner seat cannot be removed or left",
    as(OW2, `create temp table org as select public.org_create(repeat('x', 200)) as id;
      select 'seat:' || role || ',' || char_length((select name from public.orgs where id = (select id from org))) from public.org_members where org_id = (select id from org) and profile_id = '${OW2}';
      select 'remove:' || public.org_remove_member((select id from public.org_members where org_id = (select id from org) and profile_id = '${OW2}'));
      select 'leave:' || public.org_leave((select id from org));
      select 'still:' || count(*) from public.org_members where org_id = (select id from org) and profile_id = '${OW2}';`),
    ["seat:owner,120", "remove:owner_seat", "leave:owner_seat", "still:1"]);
  expect("ATK-06: an invite to an unknown address is indistinguishable from a known one",
    as(OW, `select 'unknown:' || public.org_invite_creator('${ORG}', 'nobody-0073@example.test'); select 'known:' || public.org_invite_creator('${ORG}', 'probe-0073-b@example.test');`),
    ["unknown:ok", "known:ok"]);

  // ── WG-07: who wrote the message / changed the status ─────────────────────
  expect("WG-07: messages carry the writing seat; fan messages carry none",
    as(CH, `insert into public.messages (creator_id, fan_id, sender, body) values ('${A}', '${FA}', 'creator', 'from the seat');`)
    + `select 'seatmsg:' || coalesce(actor_id::text, 'null') from public.messages where body = 'from the seat'; select 'fanmsg:' || coalesce(actor_id::text, 'null') from public.messages where id = '${MSG_A}';`
    + as(CH, `update public.messages set read_at = now() where id = '${MSG_A}';`) + `select 'read:' || coalesce(actor_id::text, 'null') from public.messages where id = '${MSG_A}';`,
    [`seatmsg:${CH}`, "fanmsg:null", "read:null"]);
  expect("WG-07: a redemption records the seat that changed its status, and keeps it on a note edit",
    as(FU, `select public.set_redemption_state('${RED_A}', '${A}', '{"status":"in_progress"}'::jsonb);`) + `select 'status:' || coalesce(actor_id::text, 'null') from public.redemptions where id = '${RED_A}';`
    + as(A, `select public.set_redemption_state('${RED_A}', '${A}', '{"notes":"left at the door"}'::jsonb);`) + `select 'note:' || coalesce(actor_id::text, 'null') from public.redemptions where id = '${RED_A}';`,
    [`status:${FU}`, `note:${FU}`]);
  expect("WG-07: a seat that lost its scope cannot change a redemption (CC-03 shape, sequential)",
    `delete from public.org_member_creators where member_id = '${SEAT_FU}';` + as(FU, `select 'lost:' || (public.set_redemption_state('${RED_A}', '${A}', '{"status":"fulfilled"}'::jsonb)->>'status');`), ["lost:forbidden"]);

  // ── TS-06: the upcoming-terms notice ──────────────────────────────────────
  expect("TS-06: the notice is empty by default, set by an admin with MFA, read by a signed-in creator",
    as(A, `select 'none:' || coalesce(public.legal_terms_upcoming()::text, 'null');`)
    + as(AD, `select 'set:' || (public.set_legal_terms_notice('2027-01-15', '2027-01-15')->>'version');`, "aal2")
    + as(A, `select 'read:' || (public.legal_terms_upcoming()->>'version') || ',' || (public.legal_terms_upcoming()->>'effectiveAt');`)
    + as(AD, `select 'clear:' || coalesce(public.set_legal_terms_notice(null, null)::text, 'null');`, "aal2"),
    ["none:null", "set:2027-01-15", "read:2027-01-15,2027-01-15", "clear:null"]);
  refused("TS-06: a creator cannot set the notice", as(A, `select public.set_legal_terms_notice('2027-01-15', '2027-01-15');`), /admin required/);
  refused("TS-06: an admin without MFA cannot set the notice", as(AD, `select public.set_legal_terms_notice('2027-01-15', '2027-01-15');`), /admin required/);
  refused("TS-06: a past effective date is refused", as(AD, `select public.set_legal_terms_notice('2020-01-01', '2020-01-01');`, "aal2"), /invalid terms notice/);
  refused("TS-06: anon cannot read the notice RPC", `set local role anon; select public.legal_terms_upcoming();`, /permission denied for function legal_terms_upcoming/);

  // ── TS-05: consent evidence ───────────────────────────────────────────────
  expect("TS-05: record_fan_ack stamps the fan and keeps hashed evidence the creator cannot read",
    service(`select 'ack:' || (public.record_fan_ack('${TOKEN_A}', '${HEX}', '${"b".repeat(64)}')->>'status') || ',' || (public.record_fan_ack('${TOKEN_A}', '${HEX}', null)->>'version');
      select 'evidence:' || terms_version || ',' || ack_count || ',' || coalesce(ua_hash, 'null') || ',' || (ip_hash = '${HEX}')::text from public.fan_consent_evidence where fan_id = '${FA}';
      select 'fan:' || acked_terms_version from public.fans where id = '${FA}';
      select 'unknown:' || (public.record_fan_ack('no-such-token')->>'status');`)
    + as(A, `select 'creator:' || count(*) from public.fan_consent_evidence;`) + as(AD, `select 'admin:' || count(*) from public.fan_consent_evidence;`, "aal2"),
    ["ack:ok,2026-11-11", "evidence:2026-11-11,2,null,true", "fan:2026-11-11", "unknown:not_found", "creator:0", "admin:1"]);
  refused("TS-05: a malformed hash is refused", service(`select public.record_fan_ack('${TOKEN_A}', 'not-a-hash', null);`), /invalid acknowledgement/);
  refused("TS-05: a creator session cannot call record_fan_ack", as(A, `select public.record_fan_ack('${TOKEN_A}');`), /permission denied for function record_fan_ack/);
  refused("TS-05: evidence cannot be moved to another creator", service(`select public.record_fan_ack('${TOKEN_A}'); update public.fan_consent_evidence set creator_id = '${B}' where fan_id = '${FA}';`), /creator_id is immutable/);

  return { bad, checks };
}
