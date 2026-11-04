// @ts-check
// Batch-4 integration probe (0069). Run by schema-drift-check.mjs on every
// build path against a throwaway local Postgres, acting as real `authenticated`,
// `anon` and `service_role` sessions through the live grants, policies,
// triggers and RPCs (the stub carries Supabase's default grants).
//
// Cast (every statement runs inside one transaction that is rolled back):
// creator A with W0 (no prizes), W1 (one prize), W2 (two prizes, the link's
// game) and a scheduled one-prize game W1S; creator B with WB (two prizes).
// A has a fan, a link on W2, a campaign without a game, and one award.
//
//  (a) a game with fewer than 2 prizes cannot be chosen: set_fan_pass_game
//      answers game_not_playable for W0 and W1 (ok for W2 and for "follow my
//      live game"); a campaign cannot be created or changed to pin W0, W1, an
//      archived game or another creator's game, by a creator session or the
//      service role, while W2 and null pin, and re-saving a pin whose game
//      lost its prizes later is not refused; a schedule cannot be set on W0 or
//      W1 but can on W2, and clearing or re-saving W1S's schedule unchanged
//      still works;
//  (b) a signed-in creator cannot INSERT a redemption (neither can anon), the
//      service role still can, and the creator's fulfilment UPDATE still works;
//  (c) schema_version() = 69 is covered by probeSchemaVersion in the drift check.

const id = (n) => `00000000-0000-4000-8000-0000000069${n}`;
const U = { A: id("a1"), B: id("a2") };
const W = { W0: id("b0"), W1: id("b1"), W2: id("b2"), W1S: id("b3"), WB: id("b9") };
const PR = { W1: id("d1"), W2a: id("d2"), W2b: id("d3"), W1S: id("d4"), WBa: id("d5"), WBb: id("d6") };
const F = { A: id("c1") };
const P = { A: id("71") };
const S = { A: id("41") };
const R = { A: id("51") };
const CAMP = { A: id("91") };
const SESSION = id("f1");
const EMAIL = (k) => `probe-0069-${k.toLowerCase()}@example.test`;

const SEED = `
  insert into auth.users (id, email) values ${Object.entries(U).map(([k, v]) => `('${v}', '${EMAIL(k)}')`).join(", ")};
  update public.profiles set is_active = true, approval_status = 'approved' where id in (${Object.values(U).map((v) => `'${v}'`).join(", ")});
  insert into public.wheels (id, creator_id, title) values
    ('${W.W0}', '${U.A}', 'empty'), ('${W.W1}', '${U.A}', 'one'), ('${W.W2}', '${U.A}', 'two'), ('${W.WB}', '${U.B}', 'b-two');
  insert into public.wheels (id, creator_id, title, active_from) values ('${W.W1S}', '${U.A}', 'one-scheduled', now() - interval '1 hour');
  insert into public.prizes (id, wheel_id, label, rarity, weight) values
    ('${PR.W1}', '${W.W1}', 'p1', 'common', 10),
    ('${PR.W2a}', '${W.W2}', 'p2a', 'common', 10), ('${PR.W2b}', '${W.W2}', 'p2b', 'common', 10),
    ('${PR.W1S}', '${W.W1S}', 'p1s', 'common', 10),
    ('${PR.WBa}', '${W.WB}', 'pba', 'common', 10), ('${PR.WBb}', '${W.WB}', 'pbb', 'common', 10);
  insert into public.campaigns (id, creator_id, name) values ('${CAMP.A}', '${U.A}', 'A camp');
  insert into public.fans (id, creator_id, display_name) values ('${F.A}', '${U.A}', 'Ava');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values ('${P.A}', 'probe-0069-pa', '${U.A}', '${W.W2}', '${F.A}');
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_id, prize_label, prize_rarity) values
    ('${S.A}', '${P.A}', '${U.A}', '${W.W2}', '${F.A}', '${PR.W2a}', 'p2a', 'common');
  set local fanfunnel.economic_write = 'off';
  insert into public.redemptions (id, spin_id, creator_id) values ('${R.A}', '${S.A}', '${U.A}');
  insert into auth.sessions (id, user_id) values ('${SESSION}', '${U.A}');`;

const claims = (uid) => `'{"sub":"${uid}","role":"authenticated","session_id":"${SESSION}","aal":"aal1","exp":${Math.floor(Date.now() / 1000) + 3600}}'`;
const as = (uid, stmt) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);` +
  ` select set_config('request.jwt.claims', ${claims(uid)}, true); ${stmt} reset role;`;
const asAnon = (stmt) => `set local role anon; select set_config('request.jwt.claim.sub', '', true); select set_config('request.jwt.claims', '', true); ${stmt} reset role;`;
const asService = (stmt) => `set local role service_role; ${stmt} reset role;`;
// A real 'grant' actor context for A, minted the way the server does it
// (issue_creator_actor_context on the signed-in session), kept in a
// transaction-local setting for the service-role gateway call that follows.
const mintContext = as(U.A, `do $$ begin perform set_config('fanfunnel.probe_context', public.issue_creator_actor_context('${U.A}', 'grant')::text, true); end $$;`);
const pin = (wheel, tag) =>
  asService(`select '${tag}:' || (public.set_fan_pass_game(current_setting('fanfunnel.probe_context', true)::uuid, '${U.A}', '${P.A}', ${wheel ? `'${wheel}'` : "null"}, '${U.A}')->>'status');`);

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {string[]} problems found (empty = pass)
 */
export function probeIntegration(db, psql) {
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

  // --- (a) set_fan_pass_game ------------------------------------------------
  expect("set_fan_pass_game refuses a game with fewer than 2 prizes and takes one with enough", `
    ${mintContext}
    ${pin(W.W0, "pin-empty")} ${pin(W.W1, "pin-one")} ${pin(W.W2, "pin-two")} ${pin(null, "pin-follow")}`,
    ["pin-empty:game_not_playable", "pin-one:game_not_playable", "pin-two:ok", "pin-follow:ok"]);

  // --- (a) the campaign's game ----------------------------------------------
  refused("a creator creates a campaign on a game without prizes", as(U.A, `insert into public.campaigns (creator_id, name, pinned_wheel_id) values ('${U.A}', 'x', '${W.W0}');`), /game_needs_prizes/);
  refused("a creator creates a campaign on a one-prize game", as(U.A, `insert into public.campaigns (creator_id, name, pinned_wheel_id) values ('${U.A}', 'x', '${W.W1}');`), /game_needs_prizes/);
  refused("the service role creates a campaign on a one-prize game", asService(`insert into public.campaigns (creator_id, name, pinned_wheel_id) values ('${U.A}', 'x', '${W.W1}');`), /game_needs_prizes/);
  refused("a creator moves a campaign to a one-prize game", as(U.A, `update public.campaigns set pinned_wheel_id = '${W.W1}' where id = '${CAMP.A}';`), /game_needs_prizes/);
  refused("a creator pins another creator's game", as(U.A, `update public.campaigns set pinned_wheel_id = '${W.WB}' where id = '${CAMP.A}';`), /campaign game belongs to another creator/);
  refused("the service role pins another creator's game", asService(`update public.campaigns set pinned_wheel_id = '${W.WB}' where id = '${CAMP.A}';`), /campaign game belongs to another creator/);
  refused("a creator pins an archived game", `update public.wheels set archived_at = now() where id = '${W.W2}'; ${as(U.A, `update public.campaigns set pinned_wheel_id = '${W.W2}' where id = '${CAMP.A}';`)}`, /game_not_playable/);
  expect("a campaign pins a game with enough prizes, unpins, and re-saves a pin whose game lost its prizes later", `
    ${as(U.A, `with u as (update public.campaigns set pinned_wheel_id = '${W.W2}' where id = '${CAMP.A}' returning 1) select 'pin-two:' || count(*) from u;`)}
    delete from public.prizes where id = '${PR.W2b}';
    ${as(U.A, `with u as (update public.campaigns set pinned_wheel_id = '${W.W2}', name = 'renamed' where id = '${CAMP.A}' returning 1) select 'resave:' || count(*) from u;`)}
    ${as(U.A, `with u as (update public.campaigns set pinned_wheel_id = null where id = '${CAMP.A}' returning 1) select 'unpin:' || count(*) from u;`)}
    ${as(U.A, `with i as (insert into public.campaigns (creator_id, name, pinned_wheel_id) values ('${U.A}', 'follow', null) returning 1) select 'create-follow:' || count(*) from i;`)}`,
    ["pin-two:1", "resave:1", "unpin:1", "create-follow:1"]);

  // --- (a) schedules ----------------------------------------------------------
  refused("a creator schedules a game without prizes", as(U.A, `update public.wheels set active_from = now() where id = '${W.W0}';`), /game_needs_prizes/);
  refused("a creator schedules a one-prize game", as(U.A, `update public.wheels set active_until = now() + interval '1 day' where id = '${W.W1}';`), /game_needs_prizes/);
  refused("the service role schedules a one-prize game", asService(`update public.wheels set active_from = now() where id = '${W.W1}';`), /game_needs_prizes/);
  expect("a schedule is set on a game with enough prizes; a one-prize game's old schedule can be re-saved unchanged or cleared", `
    ${as(U.A, `with u as (update public.wheels set active_from = now(), active_until = now() + interval '1 day' where id = '${W.W2}' returning 1) select 'sched-two:' || count(*) from u;`)}
    ${as(U.A, `with u as (update public.wheels set active_from = active_from, active_until = active_until, title = 'renamed' where id = '${W.W1S}' returning 1) select 'resave-one:' || count(*) from u;`)}
    ${as(U.A, `with u as (update public.wheels set active_from = null, active_until = null where id = '${W.W1S}' returning 1) select 'clear-one:' || count(*) from u;`)}`,
    ["sched-two:1", "resave-one:1", "clear-one:1"]);

  // --- (b) redemptions are written by the award only --------------------------
  refused("a creator inserts a redemption for its own spin", as(U.A, `insert into public.redemptions (spin_id, creator_id) values ('${S.A}', '${U.A}');`), /permission denied for table redemptions/);
  refused("anon inserts a redemption", asAnon(`insert into public.redemptions (spin_id, creator_id) values ('${S.A}', '${U.A}');`), /permission denied for table redemptions/);
  expect("the service role still records an award and the creator still fulfils", `
    ${asService(`with i as (insert into public.redemptions (spin_id, creator_id) values ('${S.A}', '${U.A}') returning 1) select 'service-insert:' || count(*) from i;`)}
    ${as(U.A, `with u as (update public.redemptions set notes = 'sent' where id = '${R.A}' returning 1) select 'creator-update:' || count(*) from u;`)}
    select 'authenticated-insert:' || has_table_privilege('authenticated', 'public.redemptions', 'INSERT')::text;`,
    ["service-insert:1", "creator-update:1", "authenticated-insert:false"]);

  return bad;
}
