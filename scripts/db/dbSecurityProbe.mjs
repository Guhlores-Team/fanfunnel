// @ts-check
// Tenant-boundary / privacy probe (0068, the privacy and database-authorization
// audit at 7bea8ac). Run by schema-drift-check.mjs on every build path against
// a throwaway local Postgres, acting as real `authenticated`, `anon` and
// `service_role` sessions through the live grants, policies, triggers and RPCs.
// The stub now carries Supabase's default grants, so what passes here is what
// the hosted project enforces.
//
// Cast (every statement runs inside one transaction that is rolled back):
// creators A and B; ADM an aal2 admin; ORG owned by OWN with A as a member
// creator, CH a chatter seat scoped to A and MG a manager seat. Each creator
// has a wheel, a prize, a fan, a link and a spin; B has a redemption and a
// campaign; A's fan has one fan message and one creator reply.
//
// It proves:
//  1  a creator cannot pause, un-pause or re-activate a paused link, nobody
//     can un-pause one (the fan asks for a new link), and a token never changes;
//  2  a redemption, grant, message, wishlist, referral or referrer that points
//     at another creator's row is refused for every role, and the fulfilment
//     queue shows nothing for a forged row that pre-dates the guard;
//  3  the four consent columns are the fan's: a creator session cannot write
//     them, the service-role fan path can, notes/tags still work;
//  4  a suspended account or one with an open report cannot close itself, an
//     admin delete still runs, and a report outlives its creator with a
//     non-PII snapshot;
//  5  fan_passes.token is not selectable by a signed-in session; links come
//     from creator_link_tokens, which answers only a caller that may 'grant'
//     for the creator (a chatter gets none), and a served token resolves to
//     its pass (no token) for a 'view' caller only;
//  6  a creator session inserts only creator messages, may only mark a fan
//     message read, and cannot rewrite or delete one;
//  7  org_invite_creator / org_add_member answer 'ok' for any address, never
//     seat anyone without acceptance, refuse 'owner' seats and bad addresses,
//     and an org is throttled at 20 invitations an hour;
//  8  a confirmed auth e-mail change reaches profiles.email and invitations
//     match the new address;
//  9  deleting a fan scrubs creator_reports.token and the fan's attempts, the
//     retention job drops token_hash with a finished attempt's context, and
//     the wipe removes orphaned attempt shells;
//  L2 tip, avatar and prize image URLs are validated in the database;
//  L4 a seat can only be scoped to a creator of the owner's org;
//  Info org_account_stats hides e-mail and revenue from a scoped seat;
//  Info no browser role may TRUNCATE and anon reaches no table or sequence.

const id = (n) => `00000000-0000-4000-8000-0000000068${n}`;
const U = { A: id("a1"), B: id("a2"), ADM: id("a3"), OWN: id("a4"), CH: id("a5"), MG: id("a6") };
const ORG = id("f1");
const SEAT = { OWN: id("e0"), CH: id("e1"), MG: id("e2") };
const W = { A: id("b1"), B: id("b2") };
const PR = { A: id("d1"), B: id("d2") };
const F = { A: id("c1"), B: id("c2") };
const P = { A: id("71"), B: id("72") };
const S = { A: id("41"), B: id("42") };
const R = { B: id("52") };
const CAMP_B = id("91");
const MSG = { FAN: id("31"), CREATOR: id("32") };
const TOKEN = { A: "probe-0068-pa", B: "probe-0068-pb" };
const EMAIL = (k) => `probe-0068-${k.toLowerCase()}@example.test`;

const SEED = `
  insert into auth.users (id, email) values ${Object.entries(U).map(([k, v]) => `('${v}', '${EMAIL(k)}')`).join(", ")};
  update public.profiles set is_active = true, approval_status = 'approved' where id in (${Object.values(U).map((v) => `'${v}'`).join(", ")});
  update public.profiles set role = 'admin' where id = '${U.ADM}';
  update public.profiles set display_name = 'Creator A', public_slug = 'creator-a' where id = '${U.A}';
  update public.profiles set display_name = 'Creator B', public_slug = 'creator-b' where id = '${U.B}';
  insert into public.orgs (id, name, owner_id) values ('${ORG}', 'Org68', '${U.OWN}');
  insert into public.org_members (id, org_id, profile_id, role) values
    ('${SEAT.OWN}', '${ORG}', '${U.OWN}', 'owner'), ('${SEAT.CH}', '${ORG}', '${U.CH}', 'chatter'), ('${SEAT.MG}', '${ORG}', '${U.MG}', 'manager');
  update public.profiles set org_id = '${ORG}' where id = '${U.A}';
  insert into public.org_member_creators (member_id, creator_id) values ('${SEAT.CH}', '${U.A}');
  insert into public.wheels (id, creator_id, title) values ('${W.A}', '${U.A}', 'wa'), ('${W.B}', '${U.B}', 'wb');
  insert into public.prizes (id, wheel_id, label, rarity, weight) values ('${PR.A}', '${W.A}', 'pa', 'common', 10), ('${PR.B}', '${W.B}', 'pb', 'common', 10);
  insert into public.campaigns (id, creator_id, name) values ('${CAMP_B}', '${U.B}', 'B camp');
  insert into public.fans (id, creator_id, display_name) values ('${F.A}', '${U.A}', 'Ava'), ('${F.B}', '${U.B}', 'Bo');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values
    ('${P.A}', '${TOKEN.A}', '${U.A}', '${W.A}', '${F.A}'), ('${P.B}', '${TOKEN.B}', '${U.B}', '${W.B}', '${F.B}');
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity) values
    ('${S.A}', '${P.A}', '${U.A}', '${W.A}', '${F.A}', '${PR.A}', 'Selfie', 'common'),
    ('${S.B}', '${P.B}', '${U.B}', '${W.B}', '${F.B}', '${PR.B}', 'Secret B', 'common');
  set local fanfunnel.economic_write = 'off';
  insert into public.redemptions (id, spin_id, creator_id) values ('${R.B}', '${S.B}', '${U.B}');
  insert into public.messages (id, creator_id, fan_id, sender, body, created_at) values
    ('${MSG.FAN}', '${U.A}', '${F.A}', 'fan', 'hello', now() - interval '2 minutes'),
    ('${MSG.CREATOR}', '${U.A}', '${F.A}', 'creator', 'hi there', now() - interval '1 minute');`;

const jwt = (uid, aal) => `'{"sub":"${uid}","role":"authenticated","aal":"${aal}"}'`;
const as = (uid, stmt, aal = uid === U.ADM ? "aal2" : "aal1") =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);` +
  ` select set_config('request.jwt.claims', ${jwt(uid, aal)}, true); ${stmt} reset role;`;
const asAnon = (stmt) => `set local role anon; select set_config('request.jwt.claim.sub', '', true); select set_config('request.jwt.claims', '', true); ${stmt} reset role;`;
const asService = (stmt) => `set local role service_role; ${stmt} reset role;`;

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {string[]} problems found (empty = pass)
 */
export function probeDbSecurity(db, psql) {
  const bad = [];
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const expect = (label, body, want) => {
    const r = run(body);
    const got = out(r);
    const missing = want.filter((w) => !got.includes(w));
    if (r.status !== 0 || missing.length) bad.push(`${label} (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ")}; ${r.status !== 0 ? err(r) : "ok"})`);
  };
  const refused = (label, body, pattern) => {
    const r = run(body);
    if (!pattern.test(r.stderr || "")) bad.push(`${label} was not refused (${err(r)}; out ${out(r).filter(Boolean).join(" ")})`);
  };

  // --- 1 / S2: pauses and tokens -------------------------------------------
  const pause = asService(`update public.fan_passes set self_excluded_at = now(), is_active = false where id = '${P.A}';`);
  refused("a creator pauses a fan's link", as(U.A, `update public.fan_passes set self_excluded_at = now(), is_active = false where id = '${P.A}';`), /self-exclusion is set by the fan only/);
  refused("a creator un-pauses a link", `${pause} ${as(U.A, `update public.fan_passes set self_excluded_at = null, is_active = true where id = '${P.A}';`)}`, /a paused link stays paused/);
  refused("a creator re-activates a paused link", `${pause} ${as(U.A, `update public.fan_passes set is_active = true where id = '${P.A}';`)}`, /a paused link stays paused/);
  refused("a manager seat un-pauses a link", `${pause} ${as(U.MG, `update public.fan_passes set self_excluded_at = null, is_active = true where id = '${P.A}';`)}`, /a paused link stays paused/);
  refused("the service role un-pauses a link", `${pause} ${asService(`update public.fan_passes set self_excluded_at = null where id = '${P.A}';`)}`, /a paused link stays paused/);
  refused("the service role re-activates a paused link", `${pause} ${asService(`update public.fan_passes set is_active = true where id = '${P.A}';`)}`, /a paused link stays paused/);
  refused("a creator rewrites a link token", as(U.A, `update public.fan_passes set token = 'abcd' where id = '${P.A}';`), /link token is immutable/);
  refused("the service role rewrites a link token", asService(`update public.fan_passes set token = 'abcd' where id = '${P.A}';`), /link token is immutable/);
  expect("the fan path still pauses, and a creator still deactivates an unpaused link", `
    ${pause}
    select 'paused:' || (self_excluded_at is not null) || ',' || is_active from public.fan_passes where id = '${P.A}';
    ${as(U.B, `update public.fan_passes set is_active = false where id = '${P.B}';`)}
    select 'deactivated:' || (not is_active) from public.fan_passes where id = '${P.B}';`, ["paused:true,false", "deactivated:true"]);

  // --- 2: forged references ------------------------------------------------
  // 0067's redemptions_stock_unit_guard fires first (trigger name order) and
  // refuses the same forged reference with its own message; either guard is
  // the tenant boundary, so both messages are accepted.
  const FORGED_REDEMPTION = /redemption references another creator|redemption belongs to its spin's creator/;
  refused("a creator attaches another creator's spin to a redemption", as(U.A, `insert into public.redemptions (spin_id, creator_id) values ('${S.B}', '${U.A}');`), FORGED_REDEMPTION);
  refused("the service role attaches another creator's spin to a redemption", asService(`insert into public.redemptions (spin_id, creator_id) values ('${S.B}', '${U.A}');`), FORGED_REDEMPTION);
  refused("a creator grants to another creator's fan", `set local fanfunnel.economic_write = 'on'; ${as(U.A, `insert into public.grants (creator_id, fan_id, spins) values ('${U.A}', '${F.B}', 1);`)}`, /grant references another creator/);
  refused("a creator grants under another creator's campaign", `set local fanfunnel.economic_write = 'on'; ${as(U.A, `insert into public.grants (creator_id, fan_id, campaign_id, spins) values ('${U.A}', '${F.A}', '${CAMP_B}', 1);`)}`, /grant references another creator/);
  refused("a creator messages another creator's fan", as(U.A, `insert into public.messages (creator_id, fan_id, sender, body) values ('${U.A}', '${F.B}', 'creator', 'hi');`), /message references another creator/);
  refused("a creator wishlists for another creator's fan", as(U.A, `insert into public.wishlists (creator_id, fan_id, prize_label) values ('${U.A}', '${F.B}', 'x');`), /wishlist references another creator/);
  refused("a creator wishlists another creator's prize", as(U.A, `insert into public.wishlists (creator_id, fan_id, prize_id, prize_label) values ('${U.A}', '${F.A}', '${PR.B}', 'x');`), /wishlist references another creator/);
  refused("a creator refers across creators", as(U.A, `insert into public.referrals (creator_id, referrer_fan_id, referred_fan_id) values ('${U.A}', '${F.A}', '${F.B}');`), /referral references another creator/);
  refused("a creator sets a foreign referrer on a fan", as(U.A, `update public.fans set referred_by_fan_id = '${F.B}' where id = '${F.A}';`), /referrer belongs to another creator/);
  expect("own references still work, and the queue ignores a forged row from before the guard", `
    ${as(U.A, `with i as (insert into public.redemptions (spin_id, creator_id) values ('${S.A}', '${U.A}') returning 1) select 'own-redemption:' || count(*) from i;`)}
    ${as(U.A, `with i as (insert into public.messages (creator_id, fan_id, sender, body) values ('${U.A}', '${F.A}', 'creator', 'ok') returning 1) select 'own-message:' || count(*) from i;`)}
    alter table public.redemptions disable trigger trg_redemption_tenant;
    alter table public.redemptions disable trigger redemptions_stock_unit_guard;
    insert into public.redemptions (spin_id, creator_id) values ('${S.B}', '${U.A}');
    alter table public.redemptions enable trigger redemptions_stock_unit_guard;
    alter table public.redemptions enable trigger trg_redemption_tenant;
    ${as(U.A, `select 'queue-leak:' || count(*) from public.creator_redemption_queue(null, null, null, null, 100, null) where prize_label = 'Secret B';`)}
    ${as(U.A, `select 'queue-own:' || count(*) from public.creator_redemption_queue(null, null, null, null, 100, null) where prize_label = 'Selfie';`)}`,
    ["own-redemption:1", "own-message:1", "queue-leak:0", "queue-own:1"]);

  // --- 3: consent ------------------------------------------------------------
  const consent = `leaderboard_opt_in = true, handle = 'forged', acked_at = now(), acked_terms_version = '2026-10-27'`;
  refused("a creator forges a fan's consent", as(U.A, `update public.fans set ${consent} where id = '${F.A}';`), /fan consent is recorded by the fan only/);
  refused("a creator rewrites a fan's board name", as(U.A, `update public.fans set handle = 'forged' where id = '${F.A}';`), /fan consent is recorded by the fan only/);
  refused("a manager seat forges a fan's consent", as(U.MG, `update public.fans set leaderboard_opt_in = true where id = '${F.A}';`), /fan consent is recorded by the fan only/);
  refused("a creator inserts a pre-consented fan", as(U.A, `insert into public.fans (creator_id, display_name, acked_at) values ('${U.A}', 'x', now());`), /fan consent is recorded by the fan only/);
  expect("the fan path records consent; creator notes and tags still work", `
    ${asService(`update public.fans set ${consent} where id = '${F.A}';`)}
    select 'consent:' || leaderboard_opt_in || ',' || handle || ',' || (acked_at is not null) || ',' || acked_terms_version from public.fans where id = '${F.A}';
    ${as(U.A, `update public.fans set notes = 'vip', tags = array['whale'] where id = '${F.A}';`)}
    select 'notes:' || notes || ',' || array_to_string(tags, '') from public.fans where id = '${F.A}';`,
    ["consent:true,forged,true,2026-10-27", "notes:vip,whale"]);

  // --- 4: self-close and report preservation ----------------------------------
  const begin = (actor, action) => `select 'begin:' || coalesce(r->>'error', r->>'state') from public.creator_storage_account('begin', '${U.A}', false, null, '${actor}', '${action}') r;`;
  expect("a healthy account can close itself", asService(begin(U.A, "account.self_close")), ["begin:pending"]);
  expect("a suspended account cannot close itself", `update public.profiles set is_active = false where id = '${U.A}'; ${asService(begin(U.A, "account.self_close"))}`, ["begin:suspended"]);
  expect("an account with an open report cannot close itself", `
    insert into public.creator_reports (creator_id, fan_id, reason) values ('${U.A}', '${F.A}', 'Involves someone under 18');
    ${asService(begin(U.A, "account.self_close"))}
    update public.creator_reports set status = 'resolved', resolved_at = now(), resolved_by = '${U.ADM}' where creator_id = '${U.A}';
    ${asService(begin(U.A, "account.self_close").replace("'begin:'", "'begin-resolved:'"))}`, ["begin:reports_open", "begin-resolved:pending"]);
  expect("an admin still deletes a suspended account with open reports", `
    update public.profiles set is_active = false where id = '${U.A}';
    insert into public.creator_reports (creator_id, fan_id, reason) values ('${U.A}', '${F.A}', 'Involves someone under 18');
    ${asService(begin(U.ADM, "account.delete"))}`, ["begin:pending"]);
  expect("a report outlives the deleted account with a non-PII snapshot", `
    insert into public.creator_reports (id, creator_id, fan_id, token, reason) values ('${id("61")}', '${U.B}', '${F.B}', '${TOKEN.B}', 'Other');
    insert into public.creator_reports (creator_id, fan_id, token, reason) values ('${U.A}', '${F.A}', '${TOKEN.A}', 'Other');
    delete from auth.users where id = '${U.B}';
    select 'report:' || (creator_id is null) || ',' || (creator_snapshot->>'display_name') || ',' || (creator_snapshot->>'public_slug') || ',' || (creator_snapshot ? 'email') || ',' || (creator_snapshot->>'account_deleted_at' is not null) || ',' || coalesce(token, 'null')
      from public.creator_reports where id = '${id("61")}';
    select 'stamped-on-insert:' || (creator_snapshot->>'display_name') || ',' || (creator_snapshot ? 'account_deleted_at') from public.creator_reports where creator_id = '${U.A}' and fan_id = '${F.A}';`, ["report:true,Creator B,creator-b,false,true,null", "stamped-on-insert:Creator A,false"]);

  // --- 5: link tokens ------------------------------------------------------
  refused("a chatter selects link tokens", as(U.CH, `select token from public.fan_passes;`), /permission denied for table fan_passes/);
  refused("a creator filters its own links by token", as(U.A, `select id from public.fan_passes where token = '${TOKEN.A}';`), /permission denied for table fan_passes/);
  refused("anon calls creator_link_tokens", asAnon(`select * from public.creator_link_tokens('${U.A}');`), /permission denied for function creator_link_tokens/);
  refused("anon calls creator_link_pass", asAnon(`select * from public.creator_link_pass('${TOKEN.A}');`), /permission denied for function creator_link_pass/);
  expect("links are served only to a caller that may grant for the creator", `
    ${as(U.CH, `select 'chatter-rows:' || count(*) from public.fan_passes where creator_id = '${U.A}';`)}
    ${as(U.CH, `select 'chatter-tokens:' || count(*) from public.creator_link_tokens('${U.A}');`)}
    ${as(U.CH, `select 'chatter-pass:' || count(*) from public.creator_link_pass('${TOKEN.A}');`)}
    ${as(U.MG, `select 'manager-tokens:' || string_agg(token, ',') from public.creator_link_tokens('${U.A}');`)}
    ${as(U.OWN, `select 'owner-tokens:' || string_agg(token, ',') from public.creator_link_tokens('${U.A}', '${F.A}');`)}
    ${as(U.A, `select 'self-tokens:' || string_agg(token, ',') from public.creator_link_tokens('${U.A}');`)}
    ${as(U.A, `select 'self-pass:' || id || ',' || creator_id || ',' || fan_id || ',' || is_active from public.creator_link_pass('${TOKEN.A}');`)}
    ${as(U.B, `select 'other-tokens:' || count(*) from public.creator_link_tokens('${U.A}');`)}
    ${as(U.B, `select 'other-pass:' || count(*) from public.creator_link_pass('${TOKEN.A}');`)}
    ${as(U.ADM, `select 'admin-tokens:' || count(*) from public.creator_link_tokens('${U.A}');`)}`, [
    "chatter-rows:1", "chatter-tokens:0", "chatter-pass:1", `manager-tokens:${TOKEN.A}`, `owner-tokens:${TOKEN.A}`, `self-tokens:${TOKEN.A}`,
    `self-pass:${P.A},${U.A},${F.A},true`, "other-tokens:0", "other-pass:0", "admin-tokens:1",
  ]);

  // --- 6: messages ---------------------------------------------------------
  refused("a creator inserts a fan-sent message", as(U.A, `insert into public.messages (creator_id, fan_id, sender, body) values ('${U.A}', '${F.A}', 'fan', 'forged');`), /a creator writes only creator messages/);
  refused("a chatter inserts a fan-sent message", as(U.CH, `insert into public.messages (creator_id, fan_id, sender, body) values ('${U.A}', '${F.A}', 'fan', 'forged');`), /a creator writes only creator messages/);
  refused("a creator rewrites a fan's message", as(U.A, `update public.messages set body = 'rewritten' where id = '${MSG.FAN}';`), /append-only/);
  refused("a creator deletes a fan's message", as(U.A, `delete from public.messages where id = '${MSG.FAN}';`), /cannot be deleted by the creator/);
  refused("a creator moves a read receipt", `${as(U.A, `update public.messages set read_at = now() where id = '${MSG.FAN}';`)} ${as(U.A, `update public.messages set read_at = now() - interval '1 day' where id = '${MSG.FAN}';`)}`, /append-only/);
  expect("read receipts, creator replies and the fan path still work", `
    ${as(U.A, `with u as (update public.messages set read_at = now() where id = '${MSG.FAN}' and read_at is null returning 1) select 'read:' || count(*) from u;`)}
    ${as(U.CH, `with i as (insert into public.messages (creator_id, fan_id, sender, body) values ('${U.A}', '${F.A}', 'creator', 'from the seat') returning 1) select 'chatter-reply:' || count(*) from i;`)}
    ${as(U.A, `with d as (delete from public.messages where id = '${MSG.CREATOR}' returning 1) select 'own-delete:' || count(*) from d;`)}
    ${asService(`with i as (insert into public.messages (creator_id, fan_id, sender, body) values ('${U.A}', '${F.A}', 'fan', 'from the fan') returning 1) select 'fan-message:' || count(*) from i;`)}`,
    ["read:1", "chatter-reply:1", "own-delete:1", "fan-message:1"]);

  // --- 7: invitations ------------------------------------------------------
  expect("invitations answer uniformly and seat nobody without acceptance", `
    ${as(U.OWN, `select 'unknown:' || public.org_invite_creator('${ORG}', 'nobody-0068@example.test');`)}
    ${as(U.OWN, `select 'known:' || public.org_invite_creator('${ORG}', '${EMAIL("B")}');`)}
    select 'creator-invite:' || count(*) from public.org_invites where org_id = '${ORG}' and email = '${EMAIL("B")}' and role is null and status = 'pending';
    ${as(U.OWN, `select 'member:' || public.org_invite_creator('${ORG}', '${EMAIL("A")}');`)}
    ${as(U.OWN, `select 'bad-email:' || public.org_invite_creator('${ORG}', 'not an email');`)}
    ${as(U.OWN, `select 'seat-unknown:' || public.org_add_member('${ORG}', 'nobody-seat-0068@example.test', 'chatter');`)}
    ${as(U.OWN, `select 'seat-known:' || public.org_add_member('${ORG}', '${EMAIL("B")}', 'chatter');`)}
    ${as(U.OWN, `select 'seat-owner-role:' || public.org_add_member('${ORG}', '${EMAIL("B")}', 'owner');`)}
    ${as(U.OWN, `select 'self-seat:' || public.org_add_member('${ORG}', '${EMAIL("OWN")}', 'owner');`)}
    ${as(U.B, `select 'non-owner:' || public.org_add_member('${ORG}', '${EMAIL("B")}', 'chatter');`)}
    select 'seated-without-consent:' || count(*) from public.org_members where profile_id = '${U.B}';
    select 'seat-invite:' || role || ',' || status from public.org_invites where org_id = '${ORG}' and email = '${EMAIL("B")}' and role is not null;
    select 'creator-invite-replaced:' || count(*) from public.org_invites where org_id = '${ORG}' and email = '${EMAIL("B")}' and role is null and status = 'pending';
    select 'self-seat-row:' || role from public.org_members where profile_id = '${U.OWN}';
    ${as(U.B, `select 'accept:' || public.org_invite_respond((select id from public.org_invites where org_id = '${ORG}' and email = '${EMAIL("B")}' and role = 'chatter' and status = 'pending'), true);`)}
    select 'seat-after-accept:' || role from public.org_members where profile_id = '${U.B}' and org_id = '${ORG}';
    select 'still-independent:' || (org_id is null) from public.profiles where id = '${U.B}';`, [
    "unknown:ok", "known:ok", "member:ok", "bad-email:invalid_email", "seat-unknown:ok", "seat-known:ok", "seat-owner-role:invalid_role",
    "self-seat:ok", "non-owner:not_owner", "seated-without-consent:0", "seat-invite:chatter,pending", "creator-invite:1", "creator-invite-replaced:0",
    "self-seat-row:owner", "accept:ok", "seat-after-accept:chatter", "still-independent:true",
  ]);
  const twentyOne = Array.from({ length: 21 }, (_, i) => as(U.OWN, `select 'send:' || public.org_invite_creator('${ORG}', 'throttle-${i}-0068@example.test');`)).join("\n");
  expect("an org sends at most 20 invitations an hour", `
    ${twentyOne}
    select 'sent:' || count(*) from public.org_invites where org_id = '${ORG}' and email like 'throttle-%';`, ["send:rate_limited", "sent:20"]);

  // --- 8: e-mail sync ------------------------------------------------------
  expect("a confirmed e-mail change reaches profiles and invitations match it", `
    update auth.users set email = 'b-renamed-0068@example.test' where id = '${U.B}';
    select 'synced:' || email from public.profiles where id = '${U.B}';
    ${as(U.OWN, `select 'invite:' || public.org_invite_creator('${ORG}', 'b-renamed-0068@example.test');`)}
    ${as(U.B, `select 'accept:' || public.org_invite_respond((select id from public.org_invites where org_id = '${ORG}' and email = 'b-renamed-0068@example.test' and status = 'pending'), true);`)}
    select 'joined:' || (org_id = '${ORG}') from public.profiles where id = '${U.B}';`,
    ["synced:b-renamed-0068@example.test", "invite:ok", "accept:ok", "joined:true"]);

  // --- 9: deletion traces --------------------------------------------------
  const ATT = { D: id("81"), C: id("82"), OLD: id("83") };
  const attempts = `
    insert into public.creator_reports (id, creator_id, fan_id, token, reason) values ('${id("62")}', '${U.A}', null, '${TOKEN.A}', 'Other');
    insert into public.spin_attempts (id, creator_id, fan_id, fan_pass_id, token_hash, request_hash, state, context, finished_at) values
      ('${ATT.D}', '${U.A}', '${F.A}', '${P.A}', repeat('d', 64), repeat('1', 64), 'declined', '{"seed":"x"}', now()),
      ('${ATT.C}', '${U.A}', '${F.A}', '${P.A}', repeat('c', 64), repeat('2', 64), 'committed', '{"seed":"y"}', now());`;
  expect("deleting a fan scrubs its report token and attempts; the wipe drops the shells", `
    ${attempts}
    ${as(U.A, `delete from public.fans where id = '${F.A}';`)}
    select 'report-token:' || coalesce(token, 'null') from public.creator_reports where id = '${id("62")}';
    select 'declined:' || count(*) from public.spin_attempts where id = '${ATT.D}';
    select 'committed:' || token_hash || ',' || (context is null) || ',' || (fan_id is null) from public.spin_attempts where id = '${ATT.C}';
    ${as(U.A, `select 'wipe:' || public.wipe_my_spin_attempts();`)}
    select 'left:' || count(*) from public.spin_attempts where creator_id = '${U.A}';`,
    ["report-token:null", "declined:0", "committed:,true,true", "wipe:1", "left:0"]);
  expect("retention drops the link hash with a finished attempt's context", `
    insert into public.spin_attempts (id, creator_id, fan_id, fan_pass_id, token_hash, request_hash, state, context, created_at, finished_at) values
      ('${ATT.OLD}', '${U.A}', '${F.A}', '${P.A}', repeat('e', 64), repeat('3', 64), 'committed', '{"seed":"z"}', now() - interval '100 days', now() - interval '100 days');
    ${asService(`select 'cleanup:' || (public.run_retention_cleanup(365, 90, 180, 90, 90)->>'spin_attempt_contexts');`)}
    select 'old:' || token_hash || ',' || (context is null) || ',' || state from public.spin_attempts where id = '${ATT.OLD}';`,
    ["cleanup:1", "old:,true,committed"]);

  // --- L2: URLs validated in the database ------------------------------------
  refused("a plain-http tip link", as(U.A, `select public.set_public_profile(null, 'http://tips.example.test/a', null);`), /invalid tip url/);
  refused("a javascript: avatar", as(U.A, `select public.set_creator_note(null, 'javascript:alert(1)');`), /invalid avatar url/);
  refused("an avatar off our storage origin", as(U.A, `select public.set_creator_note(null, 'https://evil.example.test/avatars/x.png');`), /invalid avatar url/);
  refused("a non-https prize image", as(U.A, `update public.prizes set image_url = 'http://img.example.test/x.png' where id = '${PR.A}';`), /invalid prize image url/);
  expect("valid tip, avatar and image URLs are stored", `
    ${as(U.A, `select public.set_public_profile(null, 'https://tips.example.test/a', null);`)}
    ${as(U.A, `select public.set_creator_note(null, 'https://project.supabase.co/storage/v1/object/public/avatars/${U.A}/a.png');`)}
    select 'profile:' || tip_url || ',' || avatar_url from public.profiles where id = '${U.A}';
    ${as(U.A, `update public.prizes set image_url = 'https://img.example.test/x.png' where id = '${PR.A}';`)}
    select 'image:' || image_url from public.prizes where id = '${PR.A}';`,
    [`profile:https://tips.example.test/a,https://project.supabase.co/storage/v1/object/public/avatars/${U.A}/a.png`, "image:https://img.example.test/x.png"]);

  // --- L4 / Info: seat scope and stats -----------------------------------------
  expect("a seat is scoped only inside the org and a chatter sees no e-mail or revenue", `
    ${as(U.OWN, `select 'scope-outside:' || public.org_scope_creator('${SEAT.CH}', '${U.B}', true);`)}
    ${as(U.OWN, `select 'scope-inside:' || public.org_scope_creator('${SEAT.MG}', '${U.A}', true);`)}
    select 'scoped-rows:' || count(*) from public.org_member_creators where creator_id = '${U.B}';
    ${as(U.CH, `select 'chatter-stats:' || (email is null) || ',' || (revenue is null) || ',' || display_name from public.org_account_stats('${ORG}') where id = '${U.A}';`)}
    ${as(U.MG, `select 'manager-stats:' || (email is not null) || ',' || (revenue is not null) from public.org_account_stats('${ORG}') where id = '${U.A}';`)}
    ${as(U.OWN, `select 'owner-stats:' || email || ',' || revenue from public.org_account_stats('${ORG}') where id = '${U.A}';`)}`,
    ["scope-outside:not_found", "scope-inside:ok", "scoped-rows:0", "chatter-stats:true,true,Creator A", "manager-stats:true,true", `owner-stats:${EMAIL("A")},0`]);

  // --- Info: TRUNCATE and anon ---------------------------------------------
  expect("no browser role may TRUNCATE and anon reaches no table or sequence", `
    select 'truncate:' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'));
    select 'anon-tables:' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       and has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES');
    select 'anon-sequences:' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE, SELECT, UPDATE') else false end;
    select 'anon-helpers:' || has_function_privilege('anon', 'public.is_admin()', 'execute') || ',' || has_function_privilege('anon', 'public.can_act_for(uuid, text)', 'execute');`,
    ["truncate:0", "anon-tables:0", "anon-sequences:0", "anon-helpers:true,true"]);

  return bad;
}
