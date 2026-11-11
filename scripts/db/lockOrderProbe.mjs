// @ts-check
// 0071 lock-order probe (DB concurrency audit b5, F1-F6), run by
// schema-drift-check.mjs on every build path against a throwaway local
// Postgres. Each scenario stages the audit's deadlock deterministically with
// the real functions: a gate session holds one row, the two contenders are
// started in the order that deadlocked before 0071, and every step waits for
// an OBSERVED lock wait (pg_stat_activity), never a sleep window. A scenario
// passes when neither contender gets 40P01 and both finish. Against the 0070
// definitions F1, F3, F4 and F6 report 40P01; F2 and F5 had no fan-first path
// at all (the plain UPDATE / DELETE deadlocked; scratchpad repro r2, r5).
//   F1  a fan deletion vs a commit of that fan's play (and cancel's order)
//   F2  the fan pauses its link (self_exclude_pass) vs a committing play
//   F3  save_wheel_prizes / set_prize_delivery drop a Focus target vs its play
//   F4  a creator suspension vs a Chase fan's play (two fans, id order)
//   F5  delete_campaign vs a play on a link in that campaign
//   F6  an account deletion cascade vs a committing play (and a preparing one)
// 0073 (batch-7 concurrency audit CC-01/03/04/07):
//   F7  the owner's full reset (reset_creator_content) vs a Chase fan's commit
//   F8  a fulfil seat's state change in flight while the owner removes the seat
//   F9  archive_wheel vs a direct link pause by the creator session (Chase fan)
//   F10 a manager seat's grant in flight while the owner removes the seat
// 0073 round 6 (independent review L6, L3, M3, H1):
//   F12 the owner's full reset vs a fulfilment of one of its prizes (and one
//       fan's deletion vs the same fulfilment, which needed no change)
//   F13 an account deletion cascade vs a fan's acknowledgement (record_fan_ack)
//   F14 the migration's lock block gives up after 5 seconds behind a held table
//   H1  an attempt aged out by retention releases the request; the next play
//       commits once; replays move nothing (ledger asserted)
import { createHash, randomUUID } from "node:crypto";
import { mintActorContext, withActorContext } from "./actorContextFixture.mjs";
import { LOCK_BLOCK_0073 } from "./batch7Probe.mjs";

const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const TERMS = "2026-11-11";
// Wait (bounded) until a session named `name` exists, optionally blocked on a lock.
const seen = (name, lock) => `do $$ begin for i in 1..1500 loop perform pg_stat_clear_snapshot(); exit when exists(select 1 from pg_stat_activity where application_name='${name}'${lock ? " and wait_event_type='Lock'" : ""}); perform pg_sleep(0.01); end loop; end $$;`;
const asCreator = (creator, body) => `begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(creator)},true);select set_config('request.jwt.claims','{"sub":"${creator}","role":"authenticated","aal":"aal1"}',true);${body}commit;`;

/**
 * The real fixtures of a play (creator, game, fan with ten granted spins,
 * prepare, a plain-wheel commit), shared with goLivePrecheckProbe.mjs.
 * @param {string} db @param {(db: string, sql: string) => Promise<{ status: number | null, stdout: string, stderr: string }>} psqlAsync
 */
export function playFixtures(db, psqlAsync) {
  const sql = async (q) => { const r = await psqlAsync(db, q); if (r.status !== 0) throw Error(`${q.slice(0, 100)}: ${(r.stderr || "").trim()}`); return r.stdout; };
  const rpc = async (name, args) => withActorContext(sql, name, args, async (bound) => JSON.parse((await sql(`begin;set local role service_role;select public.${name}(${bound.join(",")});commit;`)).trim().split("\n").at(-1) || "null"));

  // ---- fixtures (scratchpad b5conc/repro/lib.mjs, the real grant/prepare/commit)
  const addCreator = async () => {
    const id = randomUUID();
    await sql(`insert into auth.users(id,email,email_confirmed_at) values(${quote(id)},'lock-${id}@example.test',now());update public.profiles set is_active=true,approval_status='approved' where id=${quote(id)};
      insert into public.focus_creator_config(creator_id,chase_enabled) values(${quote(id)},true);`);
    return id;
  };
  const addWheel = async (creator, prizes = [{ label: "A" }, { label: "B" }]) => {
    const id = randomUUID(), ids = {};
    for (const p of prizes) ids[p.label] = randomUUID();
    await sql(`insert into public.wheels(id,creator_id,title,show_stock,is_active) values(${quote(id)},${quote(creator)},'Lock order',true,true);
      insert into public.prizes(id,wheel_id,label,weight,emoji,sort_order,stock,rarity,boostable) values ${prizes.map((p, i) => `(${quote(ids[p.label])},${quote(id)},${quote(p.label)},1,'🟦',${i},${p.stock ?? "null"},'common',true)`).join(",")};`);
    return { id, prizes: ids };
  };
  const addFan = async (creator, wheel, { campaign = null } = {}) => {
    const fan = randomUUID(), pass = randomUUID(), token = `lock-${randomUUID()}`;
    await sql(`insert into public.fans(id,creator_id,acked_at,acked_terms_version) values(${quote(fan)},${quote(creator)},now(),${quote(TERMS)});
      insert into public.fan_passes(id,token,creator_id,fan_id,wheel_id,campaign_id) values(${quote(pass)},${quote(token)},${quote(creator)},${quote(fan)},${quote(wheel)},${campaign ? quote(campaign) : "null"});`);
    const g = await rpc("grant_pass_spins", [quote(randomUUID()), quote(creator), quote(fan), quote(pass), "10", "0", "0", campaign ? quote(campaign) : "null"]);
    if (g?.status !== "granted") throw Error(`grant: ${JSON.stringify(g)}`);
    return { fan, pass, token, creator };
  };
  const focusOn = async (creator, who, prizeId, kind) => {
    const pack = randomUUID();
    await sql(`insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,focus_spins,chase_within) values(${quote(pack)},${quote(creator)},'${kind}',10,'${kind}',5,5);`);
    const g = await rpc("grant_focus_pack", [quote(randomUUID()), quote(creator), quote(who.fan), quote(who.pass), quote(pack), quote(prizeId)]);
    if (g?.status !== "granted") throw Error(`${kind} grant: ${JSON.stringify(g)}`);
  };
  const prep = async (who) => {
    const id = randomUUID(), binding = hash(id);
    const out = JSON.parse((await sql(`begin;set local role service_role;select public.prepare_spin_attempt(${quote(id)},${quote(who.token)},${quote(binding)});commit;`)).trim().split("\n").at(-1));
    if (out.status !== "ready") throw Error(`prepare: ${JSON.stringify(out)}`);
    return { id, binding, ...out };
  };
  // A plain-wheel commit body (scripts/stress/db.mjs wheelBody). A Focus/Chase
  // fan's commit then refuses its terms AFTER taking every lock, which is all
  // a lock-order check needs.
  const commitSql = (who, a) => {
    const c = a.context, inPool = (p) => p.stock == null || p.stock > 0;
    const snapshot = { v: 3, rules: "focus-v1", game: "wheel", prizes: c.prizes.filter(inPool).map((p) => ({ id: p.id, label: p.label, emoji: p.emoji, rarity: p.rarity, w: Math.round(p.weight), baseW: p.weight })).sort((x, y) => x.id.localeCompare(y.id)), modifiers: { happyHour: { multiplier: c.happyHourMultiplier ?? 1 }, pity: { counter: c.pityCounter, threshold: 10 }, focus: null, chase: null } };
    const p = c.prizes[0], seed = randomUUID().replaceAll("-", "").repeat(2);
    const spin = { id: a.id, fan_id: c.fanId, fan_pass_id: c.passId, creator_id: c.creatorId, wheel_id: c.wheelId, campaign_id: c.campaignId, prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url, server_seed: c.serverSeed, server_seed_hash: c.serverSeedHash, nonce: c.nonce, fair_version: 3, next_pity_counter: c.pityCounter + 1, focus_consumed: false, chase_consumed: false, chase_completed: false, next_focus_spins_left: null, next_chase_counter: null, response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, response_prize_index: c.prizes.findIndex((x) => x.id === p.id), response_show_stock: c.wheel.show_stock, client_seed: "lock-order", pool_snapshot: snapshot, pool_hash: hash(canonical(snapshot)), fair_trace: { excluded: [], won: p.id } };
    return `begin;set local role service_role;select public.commit_spin_attempt(${quote(a.id)},${quote(who.token)},${quote(a.binding)},${json({ contextHash: c.contextHash })},${json(spin)},${json({ delivery: p.delivery ?? "manual" })},${json({ seed, hash: hash(seed) })});commit;`;
  };

  return { sql, rpc, addCreator, addWheel, addFan, focusOn, prep, commitSql };
}

/** @param {string} db @param {(db: string, sql: string) => Promise<{ status: number | null, stdout: string, stderr: string }>} psqlAsync */
export async function probeLockOrder(db, psqlAsync) {
  const bad = []; let checks = 0;
  const check = (ok, label) => { checks++; if (!ok) bad.push(label); };
  const { sql, addCreator, addWheel, addFan, focusOn, prep, commitSql } = playFixtures(db, psqlAsync);

  /**
   * Gate holds `gateSql`'s rows; `first` starts and is seen blocked, then
   * `second` starts and is seen blocked; the gate commits once it sees
   * `second` waiting. Returns both results and whether each was seen blocked.
   */
  const staged = async (gateSql, first, second) => {
    const tag = `ff-lock-${randomUUID().slice(0, 8)}`;
    // The gate itself records whether it saw the second contender waiting
    // before it let go (a separate observer would race the release).
    const gate = psqlAsync(db, `begin;set local statement_timeout='20s';${gateSql}set local application_name='${tag}-gate';${seen(`${tag}-2`, true)}select 'second-blocked:'||count(*) from pg_stat_activity where application_name='${tag}-2' and wait_event_type='Lock';commit;`);
    await psqlAsync(db, seen(`${tag}-gate`, false));
    const named = (n, body) => `set application_name='${tag}-${n}';set statement_timeout='20s';${body}`;
    const one = psqlAsync(db, named(1, first));
    const firstBlocked = (await psqlAsync(db, `${seen(`${tag}-1`, true)}select count(*) from pg_stat_activity where application_name='${tag}-1' and wait_event_type='Lock';`)).stdout.trim() === "1";
    const two = psqlAsync(db, named(2, second));
    if (process.env.LOCK_ORDER_DEBUG) for (let i = 0; i < 4; i++) console.error((await psqlAsync(db, `select pg_sleep(0.5); select application_name, state, wait_event_type, wait_event, left(query, 40) from pg_stat_activity where application_name like '${tag}%';`)).stdout);
    const [g, r1, r2] = await Promise.all([gate, one, two]);
    const secondBlocked = /second-blocked:1/.test(g.stdout || "");
    const deadlock = [r1, r2].some((r) => /deadlock detected/.test(r.stderr || ""));
    const timeout = [g, r1, r2].some((r) => /statement timeout/.test(r.stderr || ""));
    const last = (r) => (r.stdout || "").trim().split("\n").at(-1) ?? "";
    const why = (r) => (r.stderr || "").trim().split("\n").find((l) => /ERROR/.test(l)) ?? last(r).slice(0, 60);
    return { firstBlocked, secondBlocked, deadlock, timeout, first: r1, second: r2, last, why, gate: g };
  };
  const clean = (label, r, extra = true) => {
    check(r.firstBlocked && r.secondBlocked, `${label}: the staging reached both lock waits (${r.firstBlocked}/${r.secondBlocked})`);
    check(!r.deadlock && !r.timeout, `${label}: no 40P01 and no timeout (${r.why(r.first)} | ${r.why(r.second)})`);
    check(extra, `${label}: both sides finished as expected (${r.why(r.first)} | ${r.why(r.second)})`);
  };
  const committed = (out) => /"spin"/.test(out);

  // A scenario that cannot run (a missing function on an older schema, a
  // fixture error) is reported as a failure and the next one still runs.
  const guard = async (label, fn) => { try { await fn(); } catch (e) { checks++; bad.push(`${label}: ${String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 200)}`); } };
  const creator = await addCreator(), w = await addWheel(creator);

  // F1: the delete holds the fan (its triggers then rewrite the attempt); the
  // commit used to hold the attempt and wait for the fan.
  await guard("F1 commit", async () => {
    const who = await addFan(creator, w.id), a = await prep(who);
    const r = await staged(`select 1 from public.fan_passes where id=${quote(who.pass)} for update;`,
      `delete from public.fans where id=${quote(who.fan)};`, commitSql(who, a));
    // 0073 (CC-02): the commit that lost its fan is declined as blocked (and stays so), no longer a retryable unavailable.
    clean("F1 fan deletion vs commit", r, r.first.status === 0 && /"declined".*"blocked"|"blocked".*"declined"/.test(r.last(r.second)));
  });
  await guard("F1 cancel", async () => {
    const who = await addFan(creator, w.id), a = await prep(who);
    const r = await staged(`select 1 from public.fan_passes where id=${quote(who.pass)} for update;`,
      `delete from public.fans where id=${quote(who.fan)};`,
      `begin;set local role service_role;select public.cancel_spin_attempt(${quote(a.id)},${quote(who.token)},${quote(a.binding)},'cancelled');commit;`);
    clean("F1 fan deletion vs cancel", r, r.first.status === 0 && r.second.status === 0);
  });
  // F2: the play queues on the fan first, then the fan's pause.
  await guard("F2", async () => {
    const who = await addFan(creator, w.id), a = await prep(who);
    const r = await staged(`select 1 from public.fans where id=${quote(who.fan)} for update;`,
      commitSql(who, a), `begin;set local role service_role;select public.self_exclude_pass(${quote(who.token)});commit;`);
    clean("F2 link pause vs commit", r, committed(r.last(r.first)) && r.last(r.second) === "ok");
    check((await sql(`select (self_excluded_at is not null and not is_active)::text from public.fan_passes where id=${quote(who.pass)};`)).trim() === "true", "F2 the link is paused after the play");
    check((await sql(`begin;set local role service_role;select public.self_exclude_pass(${quote(who.token)});select public.self_exclude_pass('no-such-token');commit;`)).trim().split("\n").join(",") === "ok,not_found", "F2 self_exclude_pass is idempotent and answers not_found for an unknown token");
  });
  // F3: a Focus fan's play queues on its fan, then the editor drops the target.
  for (const [label, edit] of [
    ["save_wheel_prizes", (fw, c) => `begin;set local role service_role;select public.save_wheel_prizes(${quote(fw.id)},${quote(c)},${json([{ id: fw.prizes.B, label: "B", rarity: "common", weight: 1, emoji: "🟥", expected_stock: null }, { label: "C", rarity: "common", weight: 1, emoji: "🟩" }])});commit;`],
    ["set_prize_delivery", (fw, c) => `begin;set local role service_role;select public.set_prize_delivery(${quote(fw.prizes.A)},${quote(c)},'text','c1','iv1',1::smallint);commit;`],
  ]) await guard(`F3 ${label}`, async () => {
    const c = await addCreator(), fw = await addWheel(c), who = await addFan(c, fw.id);
    await focusOn(c, who, fw.prizes.A, "focus");
    const a = await prep(who);
    const r = await staged(`select 1 from public.fans where id=${quote(who.fan)} for update;`, commitSql(who, a), edit(fw, c));
    clean(`F3 ${label} vs a Focus fan's commit`, r, r.second.status === 0);
    check((await sql(`select status from public.fan_focus where fan_id=${quote(who.fan)} order by created_at desc limit 1;`)).trim() === "released", `F3 ${label}: the Focus promise is released once the edit lands`);
  });
  // F4: fan 2 plays (held at its Focus row); the suspension releases fan 1's
  // Chase (game + prize) and used to wait for fan 2 while holding the game.
  await guard("F4", async () => {
    const c = await addCreator(), cw = await addWheel(c, [{ label: "A", stock: 50 }, { label: "B" }]);
    const fans = [await addFan(c, cw.id), await addFan(c, cw.id)];
    for (const f of fans) await focusOn(c, f, cw.prizes.A, "chase");
    fans.sort((x, y) => x.fan.localeCompare(y.fan));
    const a2 = await prep(fans[1]);
    const r = await staged(`select 1 from public.fan_focus where fan_id=${quote(fans[1].fan)} and status in('active','paused') for update;`,
      commitSql(fans[1], a2), `update public.profiles set is_active=false where id=${quote(c)};`);
    clean("F4 creator suspension vs a Chase fan's commit", r, r.second.status === 0);
    check((await sql(`select string_agg(state,',' order by state) from public.chase_reservations where creator_id=${quote(c)};`)).trim() === "released,released", "F4 both Chase reservations are released by the suspension");
  });
  // F5: the play holds its link and waits for the game; delete_campaign used
  // to be a plain DELETE that took the campaign, then waited for the link.
  await guard("F5", async () => {
    const c = await addCreator(), cw = await addWheel(c), cmp = randomUUID();
    await sql(`insert into public.campaigns(id,creator_id,name) values(${quote(cmp)},${quote(c)},'Lock order');`);
    const who = await addFan(c, cw.id, { campaign: cmp }), a = await prep(who);
    const r = await staged(`select 1 from public.wheels where id=${quote(cw.id)} for update;`,
      commitSql(who, a), asCreator(c, `select public.delete_campaign(${quote(cmp)},${quote(c)});`));
    clean("F5 delete_campaign vs a play in the campaign", r, committed(r.last(r.first)) && r.last(r.second) === "ok");
    check((await sql(`select coalesce(campaign_id::text,'null') from public.fan_passes where id=${quote(who.pass)};`)).trim() === "null", "F5 the link leaves the deleted campaign");
  });
  // F6: the play holds fan + link and waits for the game; the account
  // deletion cascade used to hold the profile and wait for the fan.
  await guard("F6", async () => {
    const c = await addCreator(), cw = await addWheel(c), who = await addFan(c, cw.id), a = await prep(who);
    const r = await staged(`select 1 from public.wheels where id=${quote(cw.id)} for update;`,
      commitSql(who, a), `delete from auth.users where id=${quote(c)};`);
    clean("F6 account deletion vs a committing play", r, committed(r.last(r.first)) && r.second.status === 0);
    check((await sql(`select count(*) from public.profiles where id=${quote(c)};`)).trim() === "0", "F6 the account is gone after the play");
  });
  // F6 (prepare): a fresh play's prepare held the fan and then took the
  // profile key share for its spin_attempts insert; the account deletion held
  // the profile and waited for that fan (found by stress D10). Gate: the fan.
  await guard("F6 prepare", async () => {
    const c = await addCreator(), cw = await addWheel(c), who = await addFan(c, cw.id), id = randomUUID();
    const r = await staged(`select 1 from public.fans where id=${quote(who.fan)} for update;`,
      `begin;set local role service_role;select public.prepare_spin_attempt(${quote(id)},${quote(who.token)},${quote(hash(id))});commit;`,
      `delete from auth.users where id=${quote(c)};`);
    clean("F6 account deletion vs a preparing play", r, /"status": "ready"/.test(r.last(r.first)) && r.second.status === 0);
    check((await sql(`select count(*) from public.profiles where id=${quote(c)};`)).trim() === "0", "F6 the account is gone after the prepare");
  });
  // F7 (CC-01): the route used to DELETE the fans itself (fan trigger: wheel
  // -> prize per fan while the next fan was still unlocked) before calling
  // reset_creator_content. The RPC now deletes them under its pre-locks:
  // every fan and link first, then the game. Gate: the game.
  await guard("F7", async () => {
    const c = await addCreator(), cw = await addWheel(c, [{ label: "A", stock: 50 }, { label: "B" }]);
    const fans = [await addFan(c, cw.id), await addFan(c, cw.id), await addFan(c, cw.id)];
    for (const f of fans) await focusOn(c, f, cw.prizes.A, "chase");
    const a = await prep(fans[2]);
    const { context } = await mintActorContext(sql, c, c, "edit_wheel");
    const r = await staged(`select 1 from public.wheels where id=${quote(cw.id)} for update;`,
      `begin;set local role service_role;select public.reset_creator_content(${quote(context)},${quote(c)},${quote(c)});commit;`, commitSql(fans[2], a));
    clean("F7 reset_creator_content vs a Chase fan's commit", r, r.last(r.first) === "ok" && /"declined"|unavailable/.test(r.last(r.second)));
    check((await sql(`select count(*) from public.fans where creator_id=${quote(c)};`)).trim() === "0", "F7 every fan is gone after the reset");
    await sql(`delete from public.creator_actor_contexts where id=${quote(context)};`);
  });
  // F8 (CC-03): the seat's write is held at the redemption row; the owner
  // removes the seat meanwhile; the write resumes and must refuse itself.
  await guard("F8", async () => {
    const c = await addCreator(), cw = await addWheel(c), who = await addFan(c, cw.id), a = await prep(who);
    const first = await psqlAsync(db, commitSql(who, a));
    if (!committed(first.stdout)) throw Error(`F8 fixture commit: ${first.stderr || first.stdout}`);
    const seat = randomUUID(), org = randomUUID(), red = (await sql(`select id from public.redemptions where creator_id=${quote(c)} limit 1;`)).trim();
    if (!red) throw Error("F8 fixture: no redemption");
    const fu = randomUUID();
    await sql(`insert into auth.users(id,email,email_confirmed_at) values(${quote(fu)},'lock-fu-${fu}@example.test',now());update public.profiles set is_active=true,approval_status='approved' where id=${quote(fu)};
      insert into public.orgs(id,name,owner_id) values(${quote(org)},'Lock order',${quote(c)});update public.profiles set org_id=${quote(org)} where id=${quote(c)};
      insert into public.org_members(id,org_id,profile_id,role) values(${quote(seat)},${quote(org)},${quote(fu)},'fulfiller');insert into public.org_member_creators(member_id,creator_id) values(${quote(seat)},${quote(c)});`);
    const tag = `ff-lock-${randomUUID().slice(0, 8)}`;
    const gate = psqlAsync(db, `begin;set local statement_timeout='20s';set local application_name='${tag}-gate';select 1 from public.redemptions where id=${quote(red)} for update;${seen(`${tag}-1`, true)}
      do $$ begin for i in 1..1500 loop exit when not exists(select 1 from public.org_members where id=${quote(seat)}); perform pg_sleep(0.01); end loop; end $$;commit;`);
    await psqlAsync(db, seen(`${tag}-gate`, false));
    const write = psqlAsync(db, `set application_name='${tag}-1';set statement_timeout='20s';${asCreator(fu, `select public.set_redemption_state(${quote(red)},${quote(c)},'{"status":"fulfilled"}'::jsonb);`)}`);
    const blocked = (await psqlAsync(db, `${seen(`${tag}-1`, true)}select count(*) from pg_stat_activity where application_name='${tag}-1' and wait_event_type='Lock';`)).stdout.trim() === "1";
    const removal = await psqlAsync(db, asCreator(c, `select public.org_remove_member(${quote(seat)});`));
    const [g, w] = await Promise.all([gate, write]);
    check(blocked && removal.stdout.trim().split("\n").at(-1) === "ok", `F8 the seat's write was held and the owner removed the seat meanwhile (${removal.stderr || removal.stdout})`);
    check(g.status === 0 && w.status === 0 && /"status": ?"forbidden"/.test(w.stdout), `F8 the resumed write refuses itself after the removal (${(w.stderr || w.stdout).trim().slice(0, 120)})`);
    check((await sql(`select status from public.redemptions where id=${quote(red)};`)).trim() === "pending", "F8 the redemption is unchanged");
  });
  // F9 (CC-07): the archive holds the Chase fan and waits for the game; a
  // direct link pause by the creator session held the link and wanted the
  // fan (BEFORE trigger). The archive now pre-locks the link too.
  await guard("F9", async () => {
    const c = await addCreator(), cw = await addWheel(c, [{ label: "A", stock: 50 }, { label: "B" }]), who = await addFan(c, cw.id);
    await focusOn(c, who, cw.prizes.A, "chase");
    const r = await staged(`select 1 from public.wheels where id=${quote(cw.id)} for update;`,
      asCreator(c, `select public.archive_wheel(${quote(cw.id)});`), asCreator(c, `update public.fan_passes set is_active=false where id=${quote(who.pass)};`));
    clean("F9 archive_wheel vs a direct link pause", r, r.last(r.first) === "ok" && r.second.status === 0);
    check((await sql(`select (archived_at is not null)::text||','||(select (not is_active)::text from public.fan_passes where id=${quote(who.pass)}) from public.wheels where id=${quote(cw.id)};`)).trim() === "true,true", "F9 the game is archived and the link paused");
  });
  // F10 (CC-04): the seat's grant holds its seat row (key share) and waits at
  // the fan; the owner's removal queues behind it instead of landing first.
  await guard("F10", async () => {
    const c = await addCreator(), cw = await addWheel(c), who = await addFan(c, cw.id);
    const org = randomUUID(), seat = randomUUID(), mg = randomUUID();
    await sql(`insert into auth.users(id,email,email_confirmed_at) values(${quote(mg)},'lock-mg-${mg}@example.test',now());update public.profiles set is_active=true,approval_status='approved' where id=${quote(mg)};
      insert into public.orgs(id,name,owner_id) values(${quote(org)},'Lock order',${quote(c)});update public.profiles set org_id=${quote(org)} where id=${quote(c)};
      insert into public.org_members(id,org_id,profile_id,role) values(${quote(seat)},${quote(org)},${quote(mg)},'manager');`);
    const { context } = await mintActorContext(sql, mg, c, "grant");
    // Gate: the link (locked by the grant core after the fan and the recheck).
    const r = await staged(`select 1 from public.fan_passes where id=${quote(who.pass)} for update;`,
      `begin;set local role service_role;select public.grant_pass_spins(${quote(context)},${quote(randomUUID())},${quote(c)},${quote(who.fan)},${quote(who.pass)},3,0,0,null,${quote(mg)});commit;`,
      asCreator(c, `select public.org_remove_member(${quote(seat)});`));
    clean("F10 a seat's grant vs the owner's seat removal", r, /"granted"/.test(r.last(r.first)) && r.last(r.second) === "ok");
    check((await sql(`select (select count(*) from public.org_members where id=${quote(seat)})||','||(select spins_remaining from public.fan_passes where id=${quote(who.pass)});`)).trim() === "0,13", "F10 the grant landed before the seat went");
    await sql(`delete from public.creator_actor_contexts where id=${quote(context)};`);
  });
  // F11 (CC-06): "Set active" is one UPDATE under the creator's games taken
  // in id order. Twelve switches over four games at once neither deadlock nor
  // leave two live games (or none).
  await guard("F11", async () => {
    const c = await addCreator(), games = [];
    for (let i = 0; i < 4; i++) games.push((await addWheel(c)).id);
    for (let round = 0; round < 3; round++) {
      const runs = await Promise.all(Array.from({ length: 12 }, (_, i) => psqlAsync(db, asCreator(c, `select public.set_active_wheel(${quote(games[(i + round) % 4])});`))));
      const errors = runs.map((r) => (r.stderr || "").trim().split("\n").find((l) => /ERROR/.test(l))).filter(Boolean);
      check(errors.length === 0 && runs.every((r) => (r.stdout || "").trim().split("\n").at(-1) === "ok"), `F11 round ${round + 1}: twelve concurrent switches all answer ok (${errors[0] ?? "-"})`);
      check((await sql(`select count(*) filter (where is_active) from public.wheels where creator_id=${quote(c)};`)).trim() === "1", `F11 round ${round + 1}: exactly one game is live afterwards`);
    }
  });
  // F12 (L6): the reset deleted its fans (the fan trigger writes their
  // redemptions) before it held its games, while a fulfilment holds game ->
  // prize -> redemption. The reset now takes the games first. Gate: the prizes.
  await guard("F12", async () => {
    const c = await addCreator(), cw = await addWheel(c, [{ label: "A", stock: 50 }, { label: "B" }]);
    const winner = await addFan(c, cw.id), a = await prep(winner), won = await psqlAsync(db, commitSql(winner, a));
    if (!committed(won.stdout)) throw Error(`F12 fixture commit: ${won.stderr || won.stdout}`);
    const red = (await sql(`select id from public.redemptions where creator_id=${quote(c)} limit 1;`)).trim();
    if (!red) throw Error("F12 fixture: no redemption");
    await sql(`update public.redemptions set notes='leave it at the door' where id=${quote(red)};`);
    const chaser = await addFan(c, cw.id);
    await focusOn(c, chaser, cw.prizes.A, "chase");
    const { context } = await mintActorContext(sql, c, c, "edit_wheel");
    const r = await staged(`select 1 from public.prizes where wheel_id=${quote(cw.id)} order by id for update;`,
      asCreator(c, `select public.set_redemption_state(${quote(red)},${quote(c)},'{"status":"fulfilled"}'::jsonb);`),
      `begin;set local role service_role;select public.reset_creator_content(${quote(context)},${quote(c)},${quote(c)});commit;`);
    clean("F12 reset_creator_content vs a fulfilment", r, /"status": ?"ok"/.test(r.last(r.first)) && r.last(r.second) === "ok");
    check((await sql(`select (select count(*) from public.fans where creator_id=${quote(c)})||','||(select count(*) from public.wheels where creator_id=${quote(c)});`)).trim() === "0,0", "F12 the fans and the games are gone after the reset");
    await sql(`delete from public.creator_actor_contexts where id=${quote(context)};`);
  });
  // F12 (single fan): one fan's deletion takes its Focus game and prize
  // (aa_focus_lifecycle, the first BEFORE trigger) before its redemptions
  // (trg_fan_scrub_traces), the fulfilment's own order, so it needed no
  // change: staged the same way, it waits for the game and both finish.
  await guard("F12 single fan", async () => {
    const c = await addCreator(), cw = await addWheel(c, [{ label: "A", stock: 50 }, { label: "B" }]);
    const who = await addFan(c, cw.id), a = await prep(who), won = await psqlAsync(db, commitSql(who, a));
    if (!committed(won.stdout)) throw Error(`F12 single-fan fixture commit: ${won.stderr || won.stdout}`);
    const red = (await sql(`select id from public.redemptions where creator_id=${quote(c)} limit 1;`)).trim();
    await sql(`update public.redemptions set notes='leave it at the door' where id=${quote(red)};`);
    await focusOn(c, who, cw.prizes.A, "chase");
    const r = await staged(`select 1 from public.prizes where wheel_id=${quote(cw.id)} order by id for update;`,
      asCreator(c, `select public.set_redemption_state(${quote(red)},${quote(c)},'{"status":"fulfilled"}'::jsonb);`),
      `delete from public.fans where id=${quote(who.fan)};`);
    clean("F12 a single fan's deletion vs a fulfilment", r, /"status": ?"ok"/.test(r.last(r.first)) && r.second.status === 0);
    check((await sql(`select (select count(*) from public.fans where id=${quote(who.fan)})||','||(select status from public.redemptions where id=${quote(red)});`)).trim() === "0,fulfilled", "F12 the fan is gone and its prize stays fulfilled");
  });
  // F13 (L3): the acknowledgement held the fan and then took the creator's
  // profile (key share, the evidence insert's foreign key); the account
  // deletion holds the profile and wants the fan. Gate: the fan.
  await guard("F13", async () => {
    const c = await addCreator(), cw = await addWheel(c), who = await addFan(c, cw.id);
    const r = await staged(`select 1 from public.fans where id=${quote(who.fan)} for update;`,
      `begin;set local role service_role;select public.record_fan_ack(${quote(who.token)});commit;`,
      `delete from auth.users where id=${quote(c)};`);
    clean("F13 account deletion vs a fan's acknowledgement", r, /"status": ?"ok"/.test(r.last(r.first)) && r.second.status === 0);
    check((await sql(`select count(*) from public.profiles where id=${quote(c)};`)).trim() === "0", "F13 the account is gone after the acknowledgement");
  });
  // F14 (M3): the migration's first block. A session keeps one table; the
  // block gives up after its 5 second lock_timeout instead of queueing, and
  // goes through once the table is free.
  await guard("F14", async () => {
    const tag = `ff-lock-${randomUUID().slice(0, 8)}`;
    const holder = psqlAsync(db, `set application_name='${tag}-hold';begin;select count(*) from public.spins;select pg_sleep(30);commit;`);
    await psqlAsync(db, `do $$ begin for i in 1..1500 loop exit when exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='${tag}-hold' and l.relation='public.spins'::regclass and l.granted); perform pg_sleep(0.01); end loop; end $$;`);
    const started = Date.now();
    const blocked = await psqlAsync(db, `begin;${LOCK_BLOCK_0073}commit;`);
    const waited = Date.now() - started;
    await psqlAsync(db, `select pg_terminate_backend(pid) from pg_stat_activity where application_name='${tag}-hold';`);
    await holder;
    check(blocked.status !== 0 && /lock timeout/.test(blocked.stderr || "") && waited >= 4500 && waited < 20000, `F14 the lock block fails with a lock timeout after about 5 seconds behind a held table (${waited} ms; ${(blocked.stderr || "no error").trim().split("\n")[0].slice(0, 120)})`);
    const free = await psqlAsync(db, `begin;${LOCK_BLOCK_0073}select 'held:'||count(*) from pg_locks where pid=pg_backend_pid() and mode='AccessExclusiveLock' and relation='public.spins'::regclass;rollback;`);
    check(free.status === 0 && /held:1/.test(free.stdout || ""), `F14 the lock block goes through once the table is free (${(free.stderr || "").trim().split("\n")[0].slice(0, 120)})`);
  });
  // H1: prepare, age the attempt, run retention; status and a fresh prepare
  // with the same request id answer declined/stale (the saved request is
  // released), the old request cannot commit, the next one commits exactly
  // once, and replays of either move nothing.
  await guard("H1", async () => {
    const c = await addCreator(), cw = await addWheel(c), who = await addFan(c, cw.id), a = await prep(who);
    const svc = async (call) => JSON.parse((await sql(`begin;set local role service_role;select ${call};commit;`)).trim().split("\n").at(-1) || "null");
    const ledger = async () => (await sql(`select p.spins_remaining||','||f.spins_remaining||','||(select count(*) from public.spins where fan_id=${quote(who.fan)})||','||(select count(*) from public.spin_attempts where fan_id=${quote(who.fan)} and state='committed')||','||(select count(*) from public.redemptions r join public.spins s on s.id=r.spin_id where s.fan_id=${quote(who.fan)}) from public.fan_passes p join public.fans f on f.id=p.fan_id where p.id=${quote(who.pass)};`)).trim();
    const status = (attempt) => svc(`public.get_spin_attempt_status(${quote(attempt.id)},${quote(who.token)},${quote(attempt.binding)})`);
    await sql(`update public.spin_attempts set created_at=now()-interval '3 days' where id=${quote(a.id)};`);
    await svc(`public.run_retention_cleanup(365,90,180,90,90)`);
    const row = (await sql(`select state||','||error||','||(token_hash<>'')::text from public.spin_attempts where id=${quote(a.id)};`)).trim();
    check(row === "declined,stale,true", `H1 retention declines the aged attempt as stale and keeps its link hash (${row})`);
    const st = await status(a), again = await svc(`public.prepare_spin_attempt(${quote(a.id)},${quote(who.token)},${quote(a.binding)})`);
    check(st?.status === "declined" && st?.error === "stale" && again?.status === "declined" && again?.error === "stale", `H1 status and a fresh prepare with the same request id answer declined/stale (${JSON.stringify(st)} | ${JSON.stringify(again)})`);
    const late = await psqlAsync(db, commitSql(who, a));
    check(late.status === 0 && /"declined"/.test(late.stdout) && /"stale"/.test(late.stdout) && !committed(late.stdout), `H1 the aged request cannot commit any more (${(late.stderr || late.stdout).trim().slice(0, 120)})`);
    check((await ledger()) === "10,10,0,0,0", `H1 nothing moved for the aged request (${await ledger()})`);
    const b = await prep(who), played = await psqlAsync(db, commitSql(who, b));
    check(committed(played.stdout), `H1 the fan plays with a new request (${(played.stderr || played.stdout).trim().slice(0, 120)})`);
    check((await ledger()) === "9,9,1,1,1", `H1 exactly one spin was spent, recorded and awarded (${await ledger()})`);
    const replay = await psqlAsync(db, commitSql(who, b)), stale = await status(a), done = await status(b), lateAgain = await psqlAsync(db, commitSql(who, a));
    check(replay.status === 0 && lateAgain.status === 0 && stale?.status === "declined" && stale?.error === "stale" && done?.status === "committed" && (await ledger()) === "9,9,1,1,1",
      `H1 replays of either request move nothing: no spin lost, none doubled (${JSON.stringify(stale)} | ${done?.status} | ${await ledger()})`);
  });
  return { bad, checks };
}
