// @ts-check
// Agency seat-scope probe (0066, audit A19). Run by schema-drift-check.mjs on
// every build path against a throwaway local Postgres, acting as real
// `authenticated` users through the live RLS policies and RPCs.
//
// Cast (rolled back at the end): ORG owned by O (owner seat) with creators C
// and D. Seats: CH chatter scoped to C, FU fulfiller scoped to C, M manager.
// X is a creator outside the org; OUT a signed-in non-member.
//
// It proves, with rows seeded for C, D and X:
//  - creator_inbox_threads(p_creator => C): the chatter, the manager and the
//    owner read C's threads; the fulfiller reads none; nobody reads X's; the
//    chatter reads nothing of D (not in its scope); no p_creator = own rows.
//  - creator_redemption_queue(p_creator => C): the fulfiller, the manager and
//    the owner read C's queue; the chatter reads none.
//  - writes follow the same split through RLS: the chatter can reply to C's
//    fan but cannot update C's redemption; the fulfiller the reverse.
//  - my_seat_creators(): each seat lists exactly the creators and jobs it has;
//    a non-member lists nothing; anon cannot call it.
//  - set_redemption_state (0067) splits the same way as the redemptions RLS.
//  - a suspended chatter reads nothing for C.

const id = (n) => `00000000-0000-4000-8000-0000000066${n}`;
const U = { O: id("a1"), M: id("a2"), CH: id("a3"), FU: id("a4"), C: id("a5"), D: id("a6"), X: id("a7"), OUT: id("a8") };
const ORG = id("f1");
const SEAT = { O: id("e1"), M: id("e2"), CH: id("e3"), FU: id("e4") };
const W = { C: id("b1"), D: id("b2"), X: id("b3") };
const F = { C: id("c1"), D: id("c2"), X: id("c3") };
const P = { C: id("d1"), D: id("d2"), X: id("d3") };
const S = { C: id("41"), D: id("42"), X: id("43") };
const R = { C: id("51"), D: id("52"), X: id("53") };

const SEED = `
  insert into auth.users (id, email) values ${Object.entries(U).map(([k, v]) => `('${v}', 'probe-0066-${k.toLowerCase()}@example.test')`).join(", ")};
  update public.profiles set is_active = true, approval_status = 'approved' where id in (${Object.values(U).map((v) => `'${v}'`).join(", ")});
  update public.profiles set display_name = 'Creator C' where id = '${U.C}';
  update public.profiles set display_name = 'Creator D' where id = '${U.D}';
  insert into public.orgs (id, name, owner_id) values ('${ORG}', 'Org66', '${U.O}');
  insert into public.org_members (id, org_id, profile_id, role) values
    ('${SEAT.O}', '${ORG}', '${U.O}', 'owner'), ('${SEAT.M}', '${ORG}', '${U.M}', 'manager'),
    ('${SEAT.CH}', '${ORG}', '${U.CH}', 'chatter'), ('${SEAT.FU}', '${ORG}', '${U.FU}', 'fulfiller');
  insert into public.org_member_creators (member_id, creator_id) values ('${SEAT.CH}', '${U.C}'), ('${SEAT.FU}', '${U.C}');
  update public.profiles set org_id = '${ORG}' where id in ('${U.C}', '${U.D}');
  insert into public.wheels (id, creator_id, title) values ('${W.C}', '${U.C}', 'wc'), ('${W.D}', '${U.D}', 'wd'), ('${W.X}', '${U.X}', 'wx');
  insert into public.fans (id, creator_id, display_name) values ('${F.C}', '${U.C}', 'Fan C'), ('${F.D}', '${U.D}', 'Fan D'), ('${F.X}', '${U.X}', 'Fan X');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values
    ('${P.C}', 'probe-0066-pc', '${U.C}', '${W.C}', '${F.C}'), ('${P.D}', 'probe-0066-pd', '${U.D}', '${W.D}', '${F.D}'),
    ('${P.X}', 'probe-0066-px', '${U.X}', '${W.X}', '${F.X}');
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_label) values
    ('${S.C}', '${P.C}', '${U.C}', '${W.C}', '${F.C}', 'Prize C'), ('${S.D}', '${P.D}', '${U.D}', '${W.D}', '${F.D}', 'Prize D'),
    ('${S.X}', '${P.X}', '${U.X}', '${W.X}', '${F.X}', 'Prize X');
  set local fanfunnel.economic_write = 'off';
  insert into public.redemptions (id, spin_id, creator_id) values ('${R.C}', '${S.C}', '${U.C}'), ('${R.D}', '${S.D}', '${U.D}'), ('${R.X}', '${S.X}', '${U.X}');
  insert into public.messages (creator_id, fan_id, sender, body) values
    ('${U.C}', '${F.C}', 'fan', 'hello c'), ('${U.D}', '${F.D}', 'fan', 'hello d'), ('${U.X}', '${F.X}', 'fan', 'hello x');
  grant all on table public.redemptions, public.spins, public.fans, public.messages to anon, authenticated;`;

const as = (uid, stmt) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);` +
  ` select set_config('request.jwt.claims', '{"aal":"aal1"}', true); ${stmt} reset role;`;
const asAnon = (stmt) => `set local role anon; select set_config('request.jwt.claim.sub', '', true); ${stmt} reset role;`;
const threads = (who, creator) =>
  as(U[who], `select '${who}-threads-${creator}:' || coalesce(string_agg(last_body, ',' order by last_body), '') from public.creator_inbox_threads(p_creator => '${U[creator]}');`);
const queue = (who, creator) =>
  as(U[who], `select '${who}-queue-${creator}:' || coalesce(string_agg(prize_label, ',' order by prize_label), '') from public.creator_redemption_queue(p_creator => '${U[creator]}');`);

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {string[]} problems found (empty = pass)
 */
export function probeSeatScopes(db, psql) {
  const bad = [];
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const expect = (label, r, want) => {
    const got = out(r);
    const missing = want.filter((w) => !got.includes(w));
    if (r.status !== 0 || missing.length) bad.push(`${label} (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ")}; ${r.status !== 0 ? err(r) : "ok"})`);
  };

  expect("inbox: chatter/manager/owner read the scoped creator's threads; fulfiller, outsiders and unscoped creators read none", run(`
    ${threads("CH", "C")} ${threads("M", "C")} ${threads("O", "C")} ${threads("FU", "C")}
    ${threads("CH", "D")} ${threads("M", "D")} ${threads("CH", "X")} ${threads("M", "X")} ${threads("OUT", "C")}
    ${as(U.C, `select 'C-own:' || coalesce(string_agg(last_body, ','), '') from public.creator_inbox_threads();`)}
    ${as(U.CH, `select 'CH-own:' || count(*) from public.creator_inbox_threads();`)}`), [
    "CH-threads-C:hello c", "M-threads-C:hello c", "O-threads-C:hello c", "FU-threads-C:",
    "CH-threads-D:", "M-threads-D:hello d", "CH-threads-X:", "M-threads-X:", "OUT-threads-C:",
    "C-own:hello c", "CH-own:0",
  ]);

  expect("queue: fulfiller/manager/owner read the scoped creator's queue; chatter, outsiders and unscoped creators read none", run(`
    ${queue("FU", "C")} ${queue("M", "C")} ${queue("O", "C")} ${queue("CH", "C")}
    ${queue("FU", "D")} ${queue("M", "D")} ${queue("FU", "X")} ${queue("OUT", "C")}
    ${as(U.C, `select 'C-own:' || coalesce(string_agg(prize_label, ','), '') from public.creator_redemption_queue();`)}`), [
    "FU-queue-C:Prize C", "M-queue-C:Prize C", "O-queue-C:Prize C", "CH-queue-C:",
    "FU-queue-D:", "M-queue-D:Prize D", "FU-queue-X:", "OUT-queue-C:", "C-own:Prize C",
  ]);

  expect("writes split the same way: the chatter replies but cannot fulfil; the fulfiller fulfils but cannot reply", run(`
    ${as(U.CH, `with i as (insert into public.messages (creator_id, fan_id, sender, body) values ('${U.C}', '${F.C}', 'creator', 'reply') returning 1) select 'CH-reply:' || count(*) from i;`)}
    ${as(U.CH, `with u as (update public.redemptions set status = 'fulfilled', fulfilled_at = now() where id = '${R.C}' returning 1) select 'CH-fulfil:' || count(*) from u;`)}
    ${as(U.FU, `with u as (update public.redemptions set status = 'fulfilled', fulfilled_at = now() where id = '${R.C}' returning 1) select 'FU-fulfil:' || count(*) from u;`)}
    ${as(U.FU, `select 'FU-reply:' || public.can_act_for('${U.C}', 'chat')::text;`)}
    ${as(U.CH, `select 'CH-grant:' || public.can_act_for('${U.C}', 'grant')::text || ',' || public.can_act_for('${U.C}', 'manage')::text || ',' || public.can_act_for('${U.C}', 'edit_wheel')::text;`)}
    ${as(U.FU, `select 'FU-grant:' || public.can_act_for('${U.C}', 'grant')::text || ',' || public.can_act_for('${U.C}', 'manage')::text || ',' || public.can_act_for('${U.C}', 'edit_wheel')::text;`)}`), [
    "CH-reply:1", "CH-fulfil:0", "FU-fulfil:1", "FU-reply:false", "CH-grant:false,false,false", "FU-grant:false,false,false",
  ]);
  // 0067: the cancel/reopen RPC applies the same split (can_act_for 'fulfil' on the caller).
  expect("set_redemption_state follows the seat split: the fulfiller and manager cancel in scope, the chatter and outsiders cannot", run(`
    ${as(U.CH, `select 'CH-cancel-C:' || (public.set_redemption_state('${R.C}', '${U.C}', '{"status":"cancelled"}'::jsonb)->>'status');`)}
    ${as(U.FU, `select 'FU-cancel-C:' || (public.set_redemption_state('${R.C}', '${U.C}', '{"status":"cancelled"}'::jsonb)->>'status');`)}
    ${as(U.FU, `select 'FU-cancel-D:' || (public.set_redemption_state('${R.D}', '${U.D}', '{"status":"cancelled"}'::jsonb)->>'status');`)}
    ${as(U.M, `select 'M-cancel-D:' || (public.set_redemption_state('${R.D}', '${U.D}', '{"status":"cancelled"}'::jsonb)->>'status');`)}
    ${as(U.X, `select 'X-cancel-C:' || (public.set_redemption_state('${R.C}', '${U.C}', '{"status":"cancelled"}'::jsonb)->>'status');`)}
    ${as(U.X, `select 'X-cancel-C-as-X:' || (public.set_redemption_state('${R.C}', '${U.X}', '{"status":"cancelled"}'::jsonb)->>'status');`)}
    ${as(U.OUT, `select 'OUT-cancel-X:' || (public.set_redemption_state('${R.X}', '${U.X}', '{"status":"cancelled"}'::jsonb)->>'status');`)}`), [
    "CH-cancel-C:forbidden", "FU-cancel-C:ok", "FU-cancel-D:forbidden", "M-cancel-D:ok", "X-cancel-C:forbidden", "X-cancel-C-as-X:not_found", "OUT-cancel-X:forbidden",
  ]);
  const fuReply = run(as(U.FU, `insert into public.messages (creator_id, fan_id, sender, body) values ('${U.C}', '${F.C}', 'creator', 'nope');`));
  if (!/row-level security|permission denied/.test(fuReply.stderr || "")) bad.push(`the fulfiller's reply to C's fan was not refused (${err(fuReply)})`);

  expect("my_seat_creators lists exactly each seat's creators and jobs", run(`
    ${as(U.CH, `select 'CH-seats:' || coalesce(string_agg(display_name || '/' || can_chat || '/' || can_fulfil, ',' order by display_name), '') from public.my_seat_creators();`)}
    ${as(U.FU, `select 'FU-seats:' || coalesce(string_agg(display_name || '/' || can_chat || '/' || can_fulfil, ',' order by display_name), '') from public.my_seat_creators();`)}
    ${as(U.M, `select 'M-seats:' || coalesce(string_agg(display_name || '/' || can_chat || '/' || can_fulfil, ',' order by display_name), '') from public.my_seat_creators();`)}
    ${as(U.OUT, `select 'OUT-seats:' || count(*) from public.my_seat_creators();`)}
    ${as(U.X, `select 'X-seats:' || count(*) from public.my_seat_creators();`)}`), [
    "CH-seats:Creator C/true/false", "FU-seats:Creator C/false/true", "M-seats:Creator C/true/true,Creator D/true/true", "OUT-seats:0", "X-seats:0",
  ]);
  const anon = run(asAnon("select * from public.my_seat_creators();"));
  if (!/permission denied for function my_seat_creators/.test(anon.stderr || "")) bad.push(`anon calling my_seat_creators was not refused (${err(anon)})`);

  // Nobody widens their own seat. Table privileges are granted for this block so
  // the RLS policies alone must refuse (rolled back with the rest).
  const ESC_GRANTS = "grant all on table public.org_members, public.org_member_creators, public.orgs, public.profiles to authenticated;";
  const refusedWrite = (label, who, stmt) => {
    const r = run(`${ESC_GRANTS} ${as(U[who], stmt)}`);
    const n = out(r).find((l) => /^n:/.test(l));
    if (!(r.status !== 0 && /row-level security|permission denied/.test(r.stderr || "")) && n !== "n:0") bad.push(`${label} was not refused (${r.status === 0 ? `wrote ${n ?? "?"}` : err(r)})`);
  };
  refusedWrite("the chatter scoping itself to creator D", "CH", `insert into public.org_member_creators (member_id, creator_id) values ('${SEAT.CH}', '${U.D}');`);
  refusedWrite("the chatter promoting its own seat to manager", "CH", `with u as (update public.org_members set role = 'manager' where id = '${SEAT.CH}' returning 1) select 'n:' || count(*) from u;`);
  refusedWrite("the fulfiller promoting its own seat to owner", "FU", `with u as (update public.org_members set role = 'owner' where id = '${SEAT.FU}' returning 1) select 'n:' || count(*) from u;`);
  refusedWrite("the chatter re-pointing its scope row at creator D", "CH", `with u as (update public.org_member_creators set creator_id = '${U.D}' where member_id = '${SEAT.CH}' returning 1) select 'n:' || count(*) from u;`);
  refusedWrite("an outside creator joining the agency as a manager", "X", `insert into public.org_members (org_id, profile_id, role) values ('${ORG}', '${U.X}', 'manager');`);
  refusedWrite("the chatter taking over the agency", "CH", `with u as (update public.orgs set owner_id = '${U.CH}' where id = '${ORG}' returning 1) select 'n:' || count(*) from u;`);
  refusedWrite("the chatter promoting its profile to admin", "CH", `with u as (update public.profiles set role = 'admin' where id = '${U.CH}' returning 1) select 'n:' || count(*) from u;`);
  refusedWrite("a creator moving itself into the agency", "X", `with u as (update public.profiles set org_id = '${ORG}' where id = '${U.X}' returning 1) select 'n:' || count(*) from u;`);
  // The refused inserts abort their own transaction; the updates are replayed
  // here so the checks run after them, in the same transaction.
  expect("after the self-escalation attempts the seats still hold only their own jobs", run(`${ESC_GRANTS}
    ${as(U.CH, `update public.org_members set role = 'manager' where id = '${SEAT.CH}';`)}
    ${as(U.CH, `update public.org_member_creators set creator_id = '${U.D}' where member_id = '${SEAT.CH}';`)}
    ${as(U.CH, `update public.orgs set owner_id = '${U.CH}' where id = '${ORG}';`)}
    ${as(U.CH, `update public.profiles set role = 'admin' where id = '${U.CH}';`)}
    ${as(U.X, `update public.profiles set org_id = '${ORG}' where id = '${U.X}';`)}
    ${as(U.CH, `select 'CH-after:' || public.can_act_for('${U.D}', 'chat')::text || ',' || public.can_act_for('${U.C}', 'fulfil')::text || ',' || public.can_act_for('${U.C}', 'manage')::text || ',' || public.is_admin()::text;`)}
    ${as(U.X, `select 'X-after:' || public.can_act_for('${U.C}', 'view')::text || ',' || count(*) from public.my_seat_creators();`)}
    ${threads("CH", "D")} ${queue("CH", "C")}`), [
    "CH-after:false,false,false,false", "X-after:false,0", "CH-threads-D:", "CH-queue-C:",
  ]);

  expect("a suspended chatter reads nothing for its creator", run(`
    update public.profiles set is_active = false where id = '${U.CH}';
    ${threads("CH", "C")}
    ${as(U.CH, `select 'CH-suspended-seats:' || count(*) from public.my_seat_creators();`)}`), [
    "CH-threads-C:", "CH-suspended-seats:0",
  ]);
  return bad;
}
