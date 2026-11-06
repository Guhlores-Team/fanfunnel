// @ts-check
// 0071 security probe (security audit 3: H1, M1, M2, L1, L2, L7, I1). Run
// by schema-drift-check.mjs on every build path against a throwaway local
// Postgres, acting as real `authenticated`, `anon` and `service_role` sessions
// through the live grants, policies, triggers and RPCs (the stub carries
// Supabase's default grants). Every check runs in its own transaction that is
// rolled back. Against the 0070 schema every negative below is accepted.
//
// Cast: creator C in agency ORG (owner O, manager seat D, chatter seat H
// scoped to C), stranger creator S, MFA-enrolled creator E, pending P,
// approved U whose e-mail is unconfirmed, confirmed invitee V.
// C's games: WH (a spin and two links stored on it), WN (no history), WS
// (scheduled), WC (a campaign's game), WL (a link's game), WA (scheduled but
// archived); every game has exactly 2 prizes.

const id = (n) => `00000000-0000-4000-8000-0000000071${n}`;
const sess = (n) => `00000000-0000-4000-9000-0000000071${n}`;
const prize = (w, k) => `00000000-0000-4000-a000-0000000071${w}${k}`;
const U = { C: "c1", O: "a1", D: "d1", H: "e1", S: "f1", E: "b1", P: "b2", U: "b3", V: "b4" };
const uid = (k) => id(U[k]);
const W = { WH: "11", WN: "12", WS: "13", WC: "14", WL: "15", WA: "16", WX: "17", WE: "18" };
const wid = (k) => id(W[k]);
const pz = (k, n) => prize(W[k].slice(1), n);
const ORG = id("71"), SD = id("72"), SH = id("73"), K = id("61"), F = id("21"), FE = id("22");
const P1 = id("31"), P2 = id("32"), PE = id("33"), SP = id("41"), SE = id("42"), G = id("51"), IU = id("81"), IV = id("82");
const EMAIL = (k) => `probe-0071-${k.toLowerCase()}@example.test`;

const SEED = `
  insert into auth.users (id, email, email_confirmed_at) values
    ${Object.keys(U).map((k) => `('${uid(k)}', '${EMAIL(k)}', ${k === "U" ? "null" : "now()"})`).join(", ")};
  update public.profiles set is_active = true, approval_status = 'approved' where id in (${Object.keys(U).filter((k) => k !== "P").map((k) => `'${uid(k)}'`).join(", ")});
  insert into auth.mfa_factors (user_id, status) values ('${uid("E")}', 'verified');
  insert into auth.sessions (id, user_id) values ${Object.values(U).map((n) => `('${sess(n)}', '${id(n)}')`).join(", ")};
  insert into public.orgs (id, name, owner_id) values ('${ORG}', 'probe org', '${uid("O")}');
  update public.profiles set org_id = '${ORG}' where id = '${uid("C")}';
  insert into public.org_members (id, org_id, profile_id, role) values ('${SD}', '${ORG}', '${uid("D")}', 'manager'), ('${SH}', '${ORG}', '${uid("H")}', 'chatter');
  insert into public.org_member_creators (member_id, creator_id) values ('${SH}', '${uid("C")}');
  insert into public.wheels (id, creator_id, title) values
    ${Object.keys(W).map((k) => `('${wid(k)}', '${k === "WX" ? uid("S") : k === "WE" ? uid("E") : uid("C")}', '${k}')`).join(", ")};
  insert into public.prizes (id, wheel_id, label, rarity, weight) values
    ${Object.keys(W).flatMap((k) => [1, 2].map((n) => `('${pz(k, n)}', '${wid(k)}', '${k}-${n}', 'common', 10)`)).join(", ")};
  update public.wheels set active_from = now() - interval '1 hour' where id in ('${wid("WS")}', '${wid("WA")}');
  update public.wheels set archived_at = now() where id = '${wid("WA")}';
  insert into public.campaigns (id, creator_id, name, pinned_wheel_id) values ('${K}', '${uid("C")}', 'camp', '${wid("WC")}');
  insert into public.fans (id, creator_id, display_name) values ('${F}', '${uid("C")}', 'Fan'), ('${FE}', '${uid("E")}', 'Fan E');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values
    ('${P1}', 'probe-0071-p1', '${uid("C")}', '${wid("WH")}', '${F}'), ('${PE}', 'probe-0071-pe', '${uid("E")}', '${wid("WE")}', '${FE}');
  set local fanfunnel.pass_game_write = '${P2}';
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id, pinned_wheel_id) values ('${P2}', 'probe-0071-p2', '${uid("C")}', '${wid("WH")}', '${F}', '${wid("WL")}');
  set local fanfunnel.pass_game_write = '';
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity) values
    ('${SP}', '${P1}', '${uid("C")}', '${wid("WH")}', '${F}', '${pz("WH", 1)}', 'WH-1', 'common'),
    ('${SE}', '${PE}', '${uid("E")}', '${wid("WE")}', '${FE}', '${pz("WE", 1)}', 'WE-1', 'common');
  insert into public.grants (id, creator_id, fan_id, fan_pass_id, spins, amount_cents) values ('${G}', '${uid("C")}', '${F}', '${P1}', 5, 500);
  set local fanfunnel.economic_write = 'off';
  insert into public.org_invites (id, org_id, email, status, created_at, expires_at, role) values
    ('${IU}', '${ORG}', '${EMAIL("U")}', 'pending', now(), now() + interval '7 days', 'chatter'),
    ('${IV}', '${ORG}', '${EMAIL("V")}', 'pending', now(), now() + interval '7 days', 'chatter');
  insert into public.creator_request_journal (id, creator_id, actor_id, kind, request_hash, state, finished_at) values (gen_random_uuid(), '${uid("E")}', '${uid("E")}', 'grant', repeat('a', 64), 'committed', now());
  insert into public.actor_request_cancellations (actor_id, id, kind) values ('${uid("E")}', gen_random_uuid(), 'grant');
  insert into public.creator_applications (profile_id, display_name) values ('${uid("E")}', 'E');`;

const claims = (k, aal) => `'{"sub":"${uid(k)}","role":"authenticated","session_id":"${sess(U[k])}","aal":"${aal}","exp":${Math.floor(Date.now() / 1000) + 3600}}'`;
/** @param {keyof typeof U} k @param {string} stmt */
const as = (k, stmt, aal = "aal1") =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid(k)}', true);` +
  ` select set_config('request.jwt.claims', ${claims(k, aal)}, true); ${stmt} reset role;` +
  ` select set_config('request.jwt.claim.sub', '', true); select set_config('request.jwt.claims', '', true);`;
const asAnon = (stmt) => `set local role anon; ${stmt} reset role;`;
const asService = (stmt) => `set local role service_role; ${stmt} reset role;`;
/** A real actor context minted on k's session, kept in fanfunnel.probe_ctx for the service call after it. */
const mint = (k, creator, perm) => as(k, `do $$ begin perform set_config('fanfunnel.probe_ctx', public.issue_creator_actor_context('${creator}', '${perm}')::text, true); end $$;`);
const CTX = "current_setting('fanfunnel.probe_ctx', true)::uuid";

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {{ bad: string[], checks: number }}
 */
export function probeLedgerGuards(db, psql) {
  const bad = [];
  let checks = 0;
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const expect = (label, body, want) => {
    checks++;
    const r = run(body);
    const got = out(r);
    const missing = want.filter((w) => !got.includes(w));
    if (r.status !== 0 || missing.length) bad.push(`${label} (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ")}; ${r.status !== 0 ? err(r) : "ok"})`);
  };
  const refused = (label, body, pattern) => {
    checks++;
    const r = run(body);
    if (!pattern.test(r.stderr || "")) bad.push(`${label} was not refused (${err(r)}; out ${out(r).filter(Boolean).join(" ")})`);
  };
  const noWheelDelete = /permission denied for table wheels/;

  // --- (a) H1: a game with history is archived, never deleted ---------------
  refused("H1 a manager seat DELETEs the creator's game with history", as("D", `delete from public.wheels where id = '${wid("WH")}';`), noWheelDelete);
  refused("H1 the creator DELETEs its own game directly", as("C", `delete from public.wheels where id = '${wid("WN")}';`), noWheelDelete);
  refused("H1 the service role DELETEs a game with history", asService(`delete from public.wheels where id = '${wid("WH")}';`), /game_has_history/);
  refused("H1 the table owner DELETEs a game with history", `delete from public.wheels where id = '${wid("WH")}';`, /game_has_history/);
  expect("H1 delete_wheel keeps its answers (has_history; ok without history) and the history survives", `
    ${as("D", `select 'rpc-hist:' || public.delete_wheel('${wid("WH")}');`)}
    ${as("C", `select 'rpc-none:' || public.delete_wheel('${wid("WN")}');`)}
    select 'kept:' || (select count(*) from public.wheels where id = '${wid("WH")}') || ',' || (select count(*) from public.spins where id = '${SP}') || ',' || (select count(*) from public.fan_passes where wheel_id = '${wid("WH")}');`,
    ["rpc-hist:has_history", "rpc-none:ok", "kept:1,1,2"]);
  expect("H1 the account-deletion cascade still removes games with history", `
    delete from auth.users where id = '${uid("C")}';
    select 'cascade:' || count(*) from public.wheels where creator_id = '${uid("C")}';`, ["cascade:0"]);
  refused("H1 a session calls reset_creator_content", as("C", `select public.reset_creator_content(gen_random_uuid(), '${uid("C")}', '${uid("C")}');`), /permission denied for function reset_creator_content/);
  expect("H1 reset_creator_content: only the owner's own context resets, seats and forged contexts are forbidden", `
    ${mint("D", uid("C"), "edit_wheel")}
    ${asService(`select 'reset-seat:' || public.reset_creator_content(${CTX}, '${uid("C")}', '${uid("D")}');`)}
    ${asService(`select 'reset-seat-as-owner:' || public.reset_creator_content(${CTX}, '${uid("C")}', '${uid("C")}');`)}
    ${asService(`select 'reset-forged:' || public.reset_creator_content(gen_random_uuid(), '${uid("C")}', '${uid("C")}');`)}
    select 'untouched:' || count(*) from public.wheels where creator_id = '${uid("C")}';
    ${mint("C", uid("C"), "edit_wheel")}
    ${asService(`select 'reset-own:' || public.reset_creator_content(${CTX}, '${uid("C")}', '${uid("C")}');`)}
    select 'reset-left:' || (select count(*) from public.wheels where creator_id = '${uid("C")}') || ',' || (select count(*) from public.campaigns where creator_id = '${uid("C")}') || ',' || (select count(*) from public.wheels where creator_id = '${uid("S")}');`,
    ["reset-seat:forbidden", "reset-seat-as-owner:forbidden", "reset-forged:forbidden", "untouched:6", "reset-own:ok", "reset-left:0,0,1"]);

  // --- (b) H1: the grant ledger --------------------------------------------
  refused("H1 the creator rewrites a grant's amount_cents", as("C", `update public.grants set amount_cents = 0 where id = '${G}';`), /permission denied for table grants/);
  refused("H1 a manager seat DELETEs a grant", as("D", `delete from public.grants where id = '${G}';`), /permission denied for table grants/);
  refused("H1 the creator INSERTs a grant", as("C", `insert into public.grants (creator_id, fan_id, spins, amount_cents) values ('${uid("C")}', '${F}', 99, 0);`), /permission denied for table grants/);
  refused("H1 the ledger trigger refuses a session even if UPDATE comes back", `grant update on public.grants to authenticated; ${as("C", `update public.grants set amount_cents = 0 where id = '${G}';`)}`, /grants are written by the grant RPCs/);
  expect("H1 sessions hold no grant write privilege; a fan deletion still cascades its grants", `
    select 'grant-privs:' || has_table_privilege('authenticated', 'public.grants', 'INSERT') || ',' || has_table_privilege('authenticated', 'public.grants', 'UPDATE') || ',' || has_table_privilege('authenticated', 'public.grants', 'DELETE');
    ${as("C", `with d as (delete from public.fans where id = '${F}' returning 1) select 'fan-delete:' || count(*) from d;`)}
    select 'grants-after:' || count(*) from public.grants where fan_id = '${F}';`,
    ["grant-privs:false,false,false", "fan-delete:1", "grants-after:0"]);

  // --- (c) links and campaigns ---------------------------------------------
  refused("H1 a manager seat DELETEs a link (and its paid balance)", as("D", `delete from public.fan_passes where id = '${P1}';`), /permission denied for table fan_passes/);
  refused("H1 the creator DELETEs a link directly", as("C", `delete from public.fan_passes where id = '${P1}';`), /permission denied for table fan_passes/);
  refused("F5 the creator DELETEs a campaign directly", as("C", `delete from public.campaigns where id = '${K}';`), /permission denied for table campaigns/);
  refused("F5 anon calls delete_campaign", asAnon(`select public.delete_campaign('${K}', '${uid("C")}');`), /permission denied for function delete_campaign/);
  expect("F5 delete_campaign: a chatter seat or a stranger deletes nothing, the owner and a manager do", `
    ${as("H", `select 'del-chatter:' || public.delete_campaign('${K}', '${uid("C")}');`)}
    ${as("S", `select 'del-stranger:' || public.delete_campaign('${K}', '${uid("C")}');`)}
    ${as("D", `select 'del-wrong-creator:' || public.delete_campaign('${K}', '${uid("S")}');`)}
    select 'still:' || count(*) from public.campaigns where id = '${K}';
    ${as("D", `select 'del-manager:' || public.delete_campaign('${K}', '${uid("C")}');`)}
    select 'gone:' || count(*) from public.campaigns where id = '${K}';`,
    ["del-chatter:not_found", "del-stranger:not_found", "del-wrong-creator:not_found", "still:1", "del-manager:ok", "gone:0"]);

  // --- (d) a chosen game keeps 2 prizes ------------------------------------
  refused("H1 the creator deletes a prize of its scheduled game", as("C", `delete from public.prizes where id = '${pz("WS", 1)}';`), /game_needs_prizes/);
  refused("H1 the creator deletes a prize of a campaign's game", as("C", `delete from public.prizes where id = '${pz("WC", 1)}';`), /game_needs_prizes/);
  refused("H1 a manager seat deletes a prize of a link's game", as("D", `delete from public.prizes where id = '${pz("WL", 2)}';`), /game_needs_prizes/);
  refused("H1 the service role deletes a scheduled game's prizes", asService(`delete from public.prizes where wheel_id = '${wid("WS")}';`), /game_needs_prizes/);
  refused("H1 the creator moves a prize off its scheduled game", as("C", `update public.prizes set wheel_id = '${wid("WN")}' where id = '${pz("WS", 2)}';`), /game_needs_prizes/);
  refused("H1 a game inserted with a schedule and no prizes", as("C", `insert into public.wheels (id, creator_id, title, active_from) values ('${id("19")}', '${uid("C")}', 'new', now()); set constraints all immediate;`), /game_needs_prizes/);
  expect("H1 unchosen and archived games still lose prizes; a full save and a scheduled insert with its prizes pass", `
    ${as("C", `with d as (delete from public.prizes where id = '${pz("WN", 1)}' returning 1) select 'unchosen:' || count(*) from d;`)}
    ${as("C", `with d as (delete from public.prizes where id = '${pz("WA", 1)}' returning 1) select 'archived:' || count(*) from d;`)}
    ${asService(`select public.save_wheel_prizes('${wid("WS")}', '${uid("C")}', '[{"label":"n1","rarity":"common","weight":1},{"label":"n2","rarity":"common","weight":1}]'::jsonb);`)}
    select 'saved:' || count(*) from public.prizes where wheel_id = '${wid("WS")}';
    ${as("C", `insert into public.wheels (id, creator_id, title, active_from) values ('${id("1a")}', '${uid("C")}', 'new', now()); insert into public.prizes (wheel_id, label, rarity, weight) values ('${id("1a")}', 'a', 'common', 1), ('${id("1a")}', 'b', 'common', 1); set constraints all immediate; select 'sched-insert:ok';`)}`,
    ["unchosen:1", "archived:1", "saved:2", "sched-insert:ok"]);

  // --- (e) M1: the e-mail is never a display name ---------------------------
  expect("M1 sign-up never stores the e-mail (or a name holding it) as the display name", `
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${id("91")}', 'm1@example.test', '{"display_name":"m1@example.test"}'),
      ('${id("92")}', 'm2@example.test', '{"display_name":"Ann (M2@Example.test)"}'),
      ('${id("93")}', 'm3@example.test', '{"display_name":"@ann_m3"}'),
      ('${id("94")}', 'm4@example.test', '{}'),
      ('${id("95")}', 'm5@example.test', '{"display_name":"other@else.test"}');
    select 'm' || right(id::text, 1) || ':' || coalesce(display_name, 'null') from public.profiles where id in ('${id("91")}', '${id("92")}', '${id("93")}', '${id("94")}', '${id("95")}') order by id;
    update public.profiles set display_name = email where id = '${uid("C")}';
    select 'admin-email:' || coalesce(display_name, 'null') from public.profiles where id = '${uid("C")}';`,
    ["m1:null", "m2:null", "m3:@ann_m3", "m4:null", "m5:null", "admin-email:null"]);
  refused("M1 set_display_name with the caller's own e-mail", as("C", `select public.set_display_name('${EMAIL("C")}');`), /looks like an e-mail address/);
  refused("L2 set_display_name over 80 characters", as("C", `select public.set_display_name(repeat('x', 81));`), /invalid display name/);
  expect("M1 the stats mask a legacy e-mail name for a seat (owner entitled), my_seat_creators says Creator", `
    set local session_replication_role = replica;
    update public.profiles set display_name = '${EMAIL("C")}' where id = '${uid("C")}';
    set local session_replication_role = origin;
    ${as("H", `select 'stats-seat:' || coalesce(display_name, 'null') || ',' || coalesce(email, 'null') from public.org_account_stats('${ORG}');`)}
    ${as("H", `select 'seat-list:' || display_name from public.my_seat_creators();`)}
    ${as("O", `select 'stats-owner:' || display_name from public.org_account_stats('${ORG}');`)}
    ${as("C", `select public.set_display_name('Cleo');`)}
    select 'renamed:' || display_name from public.profiles where id = '${uid("C")}';`,
    ["stats-seat:null,null", "seat-list:Creator", `stats-owner:${EMAIL("C")}`, "renamed:Cleo"]);

  // --- (f) M2: seats and agencies only through their RPCs --------------------
  refused("M2 the owner seats an account directly", as("O", `insert into public.org_members (org_id, profile_id, role) values ('${ORG}', '${uid("S")}', 'manager');`), /permission denied for table org_members/);
  refused("M2 the owner rewrites a seat's role directly", as("O", `update public.org_members set role = 'manager' where id = '${SH}';`), /permission denied for table org_members/);
  refused("M2 the owner inserts a second agency directly", as("O", `insert into public.orgs (name, owner_id) values ('second', '${uid("O")}');`), /permission denied for table orgs/);
  refused("M2 not even the service role adds a second agency for one owner", asService(`insert into public.orgs (name, owner_id) values ('second', '${uid("O")}');`), /orgs_owner_id_key/);
  refused("M2 anon calls org_leave", asAnon(`select public.org_leave('${ORG}');`), /permission denied for function org_leave/);
  expect("M2 org_create answers the one agency; a seat and a member creator leave on their own", `
    ${as("O", `select 'create-again:' || (public.org_create('again') = '${ORG}');`)}
    ${as("S", `select 'leave-stranger:' || public.org_leave('${ORG}');`)}
    ${as("H", `select 'leave-seat:' || public.org_leave('${ORG}');`)}
    ${as("C", `select 'leave-creator:' || public.org_leave('${ORG}');`)}
    select 'after:' || (select count(*) from public.org_members where id = '${SH}') || ',' || coalesce((select org_id::text from public.profiles where id = '${uid("C")}'), 'null') || ',' || (select count(*) from public.org_members where id = '${SD}');`,
    ["create-again:true", "leave-stranger:not_member", "leave-seat:ok", "leave-creator:ok", "after:0,null,1"]);

  // --- (g) L1: own-row reads need the enrolled-MFA session -----------------
  const l1 = (tag, aal) => as("E", `select '${tag}:' || (select count(*) from public.spins where creator_id = '${uid("E")}') || ',' || (select count(*) from public.creator_request_journal where actor_id = '${uid("E")}') || ',' || (select count(*) from public.actor_request_cancellations where actor_id = '${uid("E")}') || ',' || (select count(*) from public.creator_applications where profile_id = '${uid("E")}');`, aal);
  expect("L1 an enrolled creator reads its own spins, journal, cancellations and application at aal2 only", `
    ${l1("l1-aal1", "aal1")} ${l1("l1-aal2", "aal2")}
    select 'l1-storage:' || count(*) from pg_policies where schemaname = 'public' and policyname in ('creator_storage_deletions_read', 'creator_storage_dispatches_read', 'creator_storage_objects_read') and qual ~ '\\(owner_id = auth\\.uid\\(\\)\\) AND can_act_for\\(auth\\.uid\\(\\), ''view''';`,
    ["l1-aal1:0,0,0,0", "l1-aal2:1,1,1,1", "l1-storage:3"]);

  // --- (h) L2: profile fields -------------------------------------------------
  refused("L2 set_public_profile with a Cyrillic look-alike slug", as("C", `select public.set_public_profile('сlео', null, null);`), /invalid slug/);
  refused("L2 set_public_profile with an un-normalized slug", as("C", `select public.set_public_profile('Has Space', null, null);`), /invalid slug/);
  refused("L2 set_public_profile with a 201-character tagline", as("C", `select public.set_public_profile(null, null, repeat('x', 201));`), /invalid tagline/);
  refused("L2 the table owner stores an invalid slug", `update public.profiles set public_slug = 'BAD' where id = '${uid("C")}';`, /invalid slug/);
  expect("L2 a valid profile saves; a legacy invalid slug never blocks an unrelated update", `
    ${as("C", `select public.set_public_profile('cleo-creator', null, 'hello');`)}
    select 'slug:' || public_slug || ',' || public_tagline from public.profiles where id = '${uid("C")}';
    set local session_replication_role = replica;
    update public.profiles set public_slug = 'Legacy Slug' where id = '${uid("S")}';
    set local session_replication_role = origin;
    with u as (update public.profiles set is_active = false where id = '${uid("S")}' returning 1) select 'legacy-update:' || count(*) from u;`,
    ["slug:cleo-creator,hello", "legacy-update:1"]);

  // --- (i) L7: confirmed e-mail ----------------------------------------------
  expect("L7 an unconfirmed address neither sees nor accepts its invitation; a confirmed one does", `
    ${as("U", `select 'u-read:' || count(*) from public.org_invites;`)}
    ${as("U", `select 'u-accept:' || public.org_invite_respond('${IU}', true);`)}
    ${as("V", `select 'v-read:' || count(*) from public.org_invites;`)}
    ${as("V", `select 'v-accept:' || public.org_invite_respond('${IV}', true);`)}
    select 'seats:' || (select count(*) from public.org_members where profile_id = '${uid("U")}') || ',' || (select count(*) from public.org_members where profile_id = '${uid("V")}');`,
    ["u-read:0", "u-accept:not_invitee", "v-read:1", "v-accept:ok", "seats:0,1"]);

  // --- F2 + ledger: a fan's pause keeps its credit and is no ledger violation --
  expect("F2 self_exclude_pass pauses the link, keeps its credit, and the ledger stays healthy", `
    set local fanfunnel.economic_write = 'on';
    update public.fan_passes set spins_remaining = 3, spins_granted_total = 3 where id = '${P1}';
    set local fanfunnel.economic_write = '';
    set local role service_role;
    select 'pause:' || public.self_exclude_pass('probe-0071-p1') || ',' || public.self_exclude_pass('probe-0071-p1') || ',' || public.self_exclude_pass('probe-0071-none');
    reset role;
    select 'paused:' || p.is_active || ',' || p.spins_remaining || ',' || f.spins_remaining from public.fan_passes p join public.fans f on f.id = p.fan_id where p.id = '${P1}';
    set local role service_role;
    select 'ledger:' || (public.run_reward_ledger_invariants() -> 'counts' ->> 'fanCreditMismatch');
    reset role;
    set local fanfunnel.economic_write = 'on';
    alter table public.fans disable trigger user;
    update public.fans set spins_remaining = 7 where id = '${F}';
    alter table public.fans enable trigger user;
    set local role service_role;
    select 'drift:' || (public.run_reward_ledger_invariants() -> 'counts' ->> 'fanCreditMismatch');`,
    ["pause:ok,ok,not_found", "paused:false,3,0", "ledger:0", "drift:1"]);
  refused("F2 a creator session calls self_exclude_pass", as("C", `select public.self_exclude_pass('probe-0071-p1');`), /permission denied for function self_exclude_pass/);

  // --- (j) I1: default privileges of future tables ----------------------------
  expect("I1 a future table grants anon nothing and nobody TRUNCATE", `
    create table public.probe_0071_future (id int);
    select 'i1:' || has_table_privilege('anon', 'public.probe_0071_future', 'SELECT') || ',' || has_table_privilege('authenticated', 'public.probe_0071_future', 'TRUNCATE') || ',' || has_table_privilege('service_role', 'public.probe_0071_future', 'TRUNCATE') || ',' || has_table_privilege('authenticated', 'public.probe_0071_future', 'SELECT');`,
    ["i1:false,false,true,true"]);

  return { bad, checks };
}
