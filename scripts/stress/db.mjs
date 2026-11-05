// DB-level load scenarios (A26) on the disposable local PostgreSQL: the real
// SQL gateways (prepare/commit_spin_attempt, create_pass_grant, grant_pass_spins,
// edit_pass_grant, import_fans_durable, save_wheel_prizes, add_reward_codes,
// save_game_wheel, run_retention_cleanup, reserve_self_account_deletion,
// grant_focus_pack, cancel_fan_focus, archive_wheel) driven
// by hundreds of concurrent sessions through the pool. Every scenario ends with
// the ledger invariants from docs/handoff/COMPLETENESS_AUDIT_2.md. Fixtures
// follow scripts/db/interplayProbe.mjs; no Supabase credential is read.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { withActorContext, mintActorContext } from "../db/actorContextFixture.mjs";
import { parallel, timed, tally } from "./metrics.mjs";

const quote = s => `'${String(s).replaceAll("'", "''")}'`;
const json = v => `${quote(JSON.stringify(v))}::jsonb`;
const hash = s => createHash("sha256").update(s).digest("hex");
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const TERMS = "2026-10-27";
const root = join(import.meta.dirname, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Latency ceilings (ms, p95) for the pooled local cluster on a 4-CPU box; see STRESS_RESULTS.md. */
/** Commits that all contend on ONE prize or fan row serialise on its lock by design, so their tail is the
 *  queue depth times the service time: those ceilings add `perContender` ms per concurrent caller. */
export const DB_THRESHOLDS = { commit: 400, perContender: 10, prepare: 250, grant: 400, save: 600, import500: 4000, retention: 3000, invariants: 5000, cascade: 15000 };
/** D4: deadlock retries allowed between commit_spin_attempt and a campaign pin flip (0 since 0070; a small bound keeps a regression from hiding behind one stray retry). */
export const D4_DEADLOCK_BOUND = 0;
/** D9: deadlock retries allowed between plays, Focus/Chase grants and cancels, stock saves and archive_wheel (hard bound). */
export const D9_DEADLOCK_BOUND = 0;

export async function runDbScenarios(report, { sql, quick = false, pool, only = null }) {
  const N = quick ? 0.3 : 1;
  const want = id => !only || only.has(id);
  const scale = n => Math.max(4, Math.round(n * N));
  const rpc = async (name, args) => withActorContext(sql, name, args, async bound => JSON.parse((await sql(`begin;set local role service_role;select public.${name}(${bound.join(",")});commit;`)).trim() || "null"));
  const scalar = async q => (await sql(q)).trim();
  const bridges = [];
  const bridge = script => {
    const proc = spawn("npx", ["tsx", script], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }), waiters = []; let stderr = "";
    proc.stderr.on("data", b => stderr += b);
    proc.on("exit", code => { for (const w of waiters.splice(0)) w.reject(Error(`fixture bridge exited ${code}: ${stderr}`)); });
    createInterface({ input: proc.stdout }).on("line", line => { const w = waiters.shift(); if (!w) return; try { const v = JSON.parse(line); if (!v.ok) throw Error(v.error); w.resolve(v.value); } catch (e) { w.reject(e); } });
    bridges.push(proc);
    return input => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); proc.stdin.write(JSON.stringify(input) + "\n"); });
  };
  let scratchGen = null, bingoGen = null;

  // ------------------------------------------------------------ fixtures
  let serial = 0;
  const uid = () => `${(++serial).toString(16).padStart(8, "0")}-5741-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, "0")}`;
  const addCreator = async (features = { scratch: true, bingo: true }) => {
    const id = uid();
    await sql(`insert into auth.users(id,email) values(${quote(id)},'stress-${id}@example.test');update public.profiles set is_active=true,approval_status='approved',features=${json(features)} where id=${quote(id)};`);
    return id;
  };
  /** prizes: [{label, weight, stock?, delivery?}] */
  const addWheel = async (creator, { kind = "wheel", active = true, prizes, title = "Stress" }) => {
    const id = uid();
    await sql(`insert into public.wheels(id,creator_id,title,show_stock,is_active,created_at,game_kind,game_config) values(${quote(id)},${quote(creator)},${quote(title)},true,${active},now()-interval '${serial} seconds',${quote(kind)},${kind === "scratch" ? `'{"style":"classic"}'` : "'{}'"}::jsonb);
      insert into public.prizes(wheel_id,label,weight,emoji,sort_order,stock,rarity) values ${prizes.map((p, i) => `(${quote(id)},${quote(p.label)},${p.weight},'🟦',${i},${p.stock ?? "null"},${quote(p.rarity ?? "common")})`).join(",")};`);
    const ids = {}; for (const row of (await sql(`select label,id from public.prizes where wheel_id=${quote(id)};`)).split("\n")) { const [label, pid] = row.split("\t"); ids[label] = pid; }
    return { id, prizes: ids };
  };
  const addBingo = async (creator) => {
    const id = uid();
    await sql(`insert into public.wheels(id,creator_id,title,show_stock,created_at,game_kind,game_config,game_ready) values(${quote(id)},${quote(creator)},'Stress bingo',false,now()-interval '${serial} seconds','bingo','{"size":3,"linePrizeId":null}',false);`);
    const line = randomUUID(), cells = Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), label: `Cell ${i}`, emoji: "🟦", rarity: i === 0 ? "rare" : "common", weight: 1, stock: null, sort_order: i, delivery: "manual", boostable: true }));
    await rpc("save_game_wheel", [quote(id), quote(creator), json([...cells, { id: line, label: "Line", emoji: "🏆", rarity: "rare", weight: 0, stock: null, sort_order: 10, delivery: "manual", boostable: true }]), json({ game_kind: "bingo", game_config: { size: 3, linePrizeId: line }, title: "Stress bingo" }), quote(creator)]);
    await sql(`update public.wheels set is_active=true where id=${quote(id)};`);
    return { id, line };
  };
  const grantFan = async (creator, wheel, spins = 1, campaign = null, name = "Fan") => {
    const out = await rpc("create_pass_grant", [quote(randomUUID()), quote(creator), "null", wheel ? quote(wheel) : "null", quote(name), String(spins), "0", "0", campaign ? quote(campaign) : "null"]);
    if (out.status !== "granted") throw Error(`grant refused: ${out.status} ${out.error ?? ""}`);
    await sql(`update public.fans set acked_at=now(),acked_terms_version=${quote(TERMS)} where id=${quote(out.fanId)};`);
    return { fan: out.fanId, pass: out.passId, token: out.token, grant: out.grantId };
  };
  const grantFans = (creator, wheel, n, spins = 1, campaign = null) => parallel(Array.from({ length: n }), 16, () => grantFan(creator, wheel, spins, campaign)).then(rs => rs.map(r => { if (!r.ok) throw Error(r.error); return r.value; }));
  const prep = async (who, id = randomUUID(), series) => { const binding = hash(id); const out = await (series ? timed(series, () => rpc("prepare_spin_attempt", [quote(id), quote(who.token), quote(binding)])) : rpc("prepare_spin_attempt", [quote(id), quote(who.token), quote(binding)])); return { id, binding, ...out }; };
  const cancel = (who, a) => rpc("cancel_spin_attempt", [quote(a.id), quote(who.token), quote(a.binding)]);
  const status = (who, a) => rpc("get_spin_attempt_status", [quote(a.id), quote(who.token), quote(a.binding)]);
  const commit = (who, a, b) => rpc("commit_spin_attempt", [quote(a.id), quote(who.token), quote(a.binding), json(b.ctx), json(b.spin), json(b.expected), json(b.next)]);
  const freeCode = async (prize, used = []) => JSON.parse((await sql(`select jsonb_build_object('delivery','codes','codeId',id,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_reward_codes where prize_id=${quote(prize)} and spin_id is null and reserved_focus_id is null ${used.length ? `and id not in(${used.map(quote).join(",")})` : ""} order by created_at,id limit 1;`)).trim() || "null");
  const spinRow = (a, c, p, extra) => ({ id: a.id, fan_id: c.fanId, fan_pass_id: c.passId, creator_id: c.creatorId, wheel_id: c.wheelId, campaign_id: c.campaignId, prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url, server_seed: c.serverSeed, server_seed_hash: c.serverSeedHash, nonce: c.nonce, fair_version: 3, next_pity_counter: c.pityCounter + 1, focus_consumed: false, chase_consumed: false, chase_completed: false, next_focus_spins_left: null, next_chase_counter: null, response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, response_prize_index: c.prizes.findIndex(x => x.id === p.id), response_show_stock: c.wheel.show_stock, ...extra });
  const nextSeed = () => { const seed = randomUUID().replaceAll("-", "").repeat(2); return { seed, hash: hash(seed) }; };
  const wheelBody = async (a, prizeId, excluded, used) => {
    const c = a.context, inPool = p => p.stock == null || p.stock > 0;
    const snapshot = { v: 3, rules: "focus-v1", game: "wheel", prizes: c.prizes.filter(inPool).map(p => ({ id: p.id, label: p.label, emoji: p.emoji, rarity: p.rarity, w: Math.round(p.weight), baseW: p.weight })).sort((x, y) => x.id.localeCompare(y.id)), modifiers: { happyHour: { multiplier: c.happyHourMultiplier ?? 1 }, pity: { counter: c.pityCounter, threshold: 10 }, focus: null, chase: null } };
    const p = c.prizes.find(x => x.id === prizeId);
    // Like the service: the oldest free code not yet seen taken; when every code it saw is gone, re-read the free list; when none is free the stale context's stock is wrong and SQL answers sold_out.
    const expected = p.delivery === "codes" ? await freeCode(p.id, used) ?? await freeCode(p.id, []) ?? { delivery: "codes", codeId: randomUUID(), cipher: "", iv: "", keyVersion: 1 } : { delivery: p.delivery ?? "manual" };
    return { ctx: { contextHash: c.contextHash }, spin: spinRow(a, c, p, { client_seed: "stress", pool_snapshot: snapshot, pool_hash: hash(canonical(snapshot)), fair_trace: { excluded, won: p.id } }), expected, next: nextSeed(), prizeId: p.id, codeId: expected.codeId };
  };
  const scratchBody = async (a, excluded) => {
    scratchGen ??= bridge("scripts/db/scratchProofFixture.ts");
    const g = await scratchGen({ context: a.context, excluded }), d = g.primary, p = a.context.prizes.find(x => x.id === d.prize.id);
    return { ctx: { contextHash: a.context.contextHash }, spin: spinRow(a, a.context, p, { client_seed: "scratch-pg-fixture", game_kind: "scratch", presentation: g.presentation, pool_snapshot: g.snapshot, pool_hash: g.poolHash, fair_trace: g.trace, next_pity_counter: d.nextPityCounter }), expected: { delivery: p.delivery }, next: nextSeed(), prizeId: p.id };
  };
  const bingoBody = async (a, excluded) => {
    bingoGen ??= bridge("scripts/db/bingoProofFixture.ts");
    const g = await bingoGen({ context: a.context, excluded }), d = g.primary, c = a.context, p = c.prizes.find(x => x.id === d.prize.id);
    const bonuses = g.bonuses.map(b => { const row = c.prizes.find(x => x.id === b.prize.id); return { id: randomUUID(), line: b.line, prize_id: row.id, prize_label: row.label, prize_rarity: row.rarity, prize_image_url: row.image_url, response_prize: { id: row.id, label: row.label, rarity: row.rarity, weight: row.weight }, expected_reward: { delivery: row.delivery } }; });
    return { ctx: { contextHash: c.contextHash, cardId: c.bingoCard?.id ?? null, cardVersion: c.bingoCard?.version ?? null }, spin: spinRow(a, c, p, { client_seed: g.clientSeed, game_kind: "bingo", presentation: g.presentation, pool_snapshot: g.snapshot, pool_hash: g.poolHash, fair_trace: g.trace, bonuses, next_pity_counter: d.nextPityCounter, focus_consumed: d.focusConsumed ?? false, chase_consumed: d.chaseConsumed ?? false, chase_completed: d.chaseCompleted ?? false, next_focus_spins_left: d.nextFocusSpinsLeft ?? null, next_chase_counter: d.nextChaseCounter ?? null }), expected: { delivery: p.delivery }, next: nextSeed(), prizeId: p.id };
  };
  /**
   * One full play like the service does it: prepare, build, commit; sold_out
   * excludes the prize and redraws, retry_context/changed re-prepares the same
   * attempt. `pick(context, excluded)` chooses the wheel target (null = engine's
   * own draw for scratch/bingo). Returns the terminal status and the trail.
   */
  const deadlocks = [];
  const play = async (who, { pick = null, series = [], prepSeries, maxRounds = 12, attempt } = {}) => {
    let a = await prep(who, attempt, prepSeries); const excluded = [], used = [], trail = []; let retries = 0, redraws = 0;
    for (let round = 0; round < maxRounds; round++) {
      if (a.status !== "ready") return { status: a.status, error: a.error ?? null, trail, retries, redraws, attempt: a };
      const kind = a.context.wheel.game_kind;
      let body;
      if (kind === "scratch") body = await scratchBody(a, excluded);
      else if (kind === "bingo") body = await bingoBody(a, excluded);
      else { const target = pick ? pick(a.context, excluded) : a.context.prizes.find(p => !excluded.includes(p.id) && (p.stock == null || p.stock > 0))?.id; if (!target) { await cancel(who, a); return { status: "cancelled", trail, retries, redraws, attempt: a }; } body = await wheelBody(a, target, excluded, used); }
      let r;
      try { r = await timed(series, () => commit(who, a, body)); }
      catch (e) { if (e.code !== "40P01") throw e; deadlocks.push(e.detail ?? e.message); trail.push("deadlock"); continue; }
      trail.push(r.status);
      if (r.status === "committed") return { status: "committed", kind, spin: r.spin, prizeId: body.prizeId, codeId: body.codeId, trail, retries, redraws, attempt: a };
      if (r.status === "sold_out") { excluded.push(body.prizeId); redraws++; continue; }
      // changed: the chosen code was taken meanwhile (remember it); retry_context: the game changed under the attempt (the code may still be free).
      if (r.status === "changed" && body.codeId) used.push(body.codeId);
      if (r.status === "retry_context" || r.status === "changed") { retries++; a = await prep(who, a.id); continue; }
      return { status: r.status, error: r.error ?? null, trail, retries, redraws, attempt: a };
    }
    await cancel(who, a).catch(() => {});
    return { status: "exhausted", trail, retries, redraws, attempt: a };
  };
  const outcomes = results => tally(results, v => v.status);
  const st = r => r.ok ? r.value.status : "error";
  const named = async detail => { let out = detail ?? ""; for (const [, oid] of out.matchAll(/relation (\d+)/g)) out = out.replaceAll(`relation ${oid}`, await scalar(`select ${oid}::regclass;`)); return out; };
  const noErrors = async (results, label) => { if (deadlocks.length) { report.check(false, `${label}: no deadlocks retried`, `${deadlocks.length}; ${await named(deadlocks[0])}`); deadlocks.length = 0; } const bad = results.filter(r => !r.ok); const shown = []; for (const r of bad.slice(0, 2)) shown.push(`${r.code}: ${r.error}${r.detail ? ` | ${await named(r.detail)}` : ""}`); return report.check(bad.length === 0, `${label}: no SQL errors or deadlocks`, bad.length ? `${bad.length} errors; ${shown.join(" || ")}` : undefined); };
  const stockOf = async prize => { const v = await scalar(`select coalesce(stock::text,'null') from public.prizes where id=${quote(prize)};`); return v === "null" ? null : Number(v); };
  const awarded = prize => scalar(`select count(*)||','||count(distinct fan_id) from public.spins where prize_id=${quote(prize)};`).then(v => v.split(",").map(Number));
  const invariants = async (creator, label) => {
    const v = JSON.parse(await scalar(`select jsonb_build_object(
      'fanMismatch',(select count(*) from public.fans f where f.creator_id=${quote(creator)} and (f.spins_remaining<>coalesce((select sum(p.spins_remaining) from public.fan_passes p where p.fan_id=f.id and p.is_active),0) or f.spins_granted_total<>coalesce((select sum(p.spins_granted_total) from public.fan_passes p where p.fan_id=f.id and p.is_active),0))),
      'negativeStock',(select count(*) from public.prizes pr join public.wheels w on w.id=pr.wheel_id where w.creator_id=${quote(creator)} and pr.stock<0),
      'negativeBalance',(select count(*) from public.fan_passes where creator_id=${quote(creator)} and spins_remaining<0),
      'spins',(select count(*) from public.spins where creator_id=${quote(creator)}),
      'redemptions',(select count(*) from public.redemptions where creator_id=${quote(creator)}),
      'pending',(select count(*) from public.spin_attempts where creator_id=${quote(creator)} and state='pending' and created_at<now()-interval '60 seconds'),
      'nonceDup',(select count(*) from (select fan_pass_id,nonce from public.spins where creator_id=${quote(creator)} group by 1,2 having count(*)>1) d),
      'crossWheel',(select count(*) from public.spins s join public.prizes pr on pr.id=s.prize_id where s.creator_id=${quote(creator)} and pr.wheel_id<>s.wheel_id),
      'codeDup',(select count(*) from (select spin_id from public.prize_reward_codes where creator_id=${quote(creator)} and spin_id is not null group by 1 having count(*)>1) d),
      'codeStock',(select count(*) from public.prizes pr join public.wheels w on w.id=pr.wheel_id where w.creator_id=${quote(creator)} and pr.delivery='codes' and pr.stock is distinct from (select count(*) from public.prize_reward_codes c where c.prize_id=pr.id and c.spin_id is null and c.erased_at is null)),
      'debitVsSpins',(select coalesce(sum(p.spins_granted_total-p.spins_remaining),0)-(select count(*) from public.spins s join public.fan_passes p2 on p2.id=s.fan_pass_id where s.creator_id=${quote(creator)}) from public.fan_passes p where p.creator_id=${quote(creator)}));`));
    report.check(v.fanMismatch === 0, `${label}: fans.spins_remaining == SUM(fan_passes) (and granted totals)`, v.fanMismatch);
    report.check(v.negativeStock === 0 && v.negativeBalance === 0, `${label}: no negative stock or balance`);
    report.check(v.spins === v.redemptions, `${label}: redemptions == committed spins`, `${v.spins}/${v.redemptions}`);
    report.check(v.nonceDup === 0 && v.crossWheel === 0, `${label}: unique nonces, every prize belongs to the wheel played`);
    report.check(v.codeDup === 0 && v.codeStock === 0, `${label}: assigned codes unique, code stock == unused codes`);
    report.check(v.debitVsSpins === 0, `${label}: every debited credit is one committed spin (a deleted fan keeps its anonymised spins)`, v.debitVsSpins);
    report.check(v.pending === 0, `${label}: no spin attempt pending for more than 60s`, v.pending);
    return v;
  };
  const ledger = async label => { const v = JSON.parse(await scalar(`begin;set local role service_role;select public.run_reward_ledger_invariants();commit;`)); const bad = Object.entries(v.counts ?? {}).filter(([, n]) => Number(n) > 0); report.check(v.status === "healthy" && bad.length === 0, `${label}: run_reward_ledger_invariants healthy`, bad.length ? Object.fromEntries(bad) : v.status); };

  try {
    // ============================================================ D1 oversell
    if (want("D1")) {
      const n = scale(200), stock = scale(25);
      const s = report.scenario("D1", `${n} fans spin one finite-stock prize (stock ${stock}) concurrently`);
      const c = await addCreator(), w = await addWheel(c, { prizes: [{ label: "Limited", weight: 1, stock }, { label: "Other", weight: 1 }] });
      const fans = await grantFans(c, w.id, n), series = [], prepSeries = [];
      const t0 = Date.now();
      const pick = (ctx, ex) => { const lim = ctx.prizes.find(p => p.id === w.prizes.Limited); return !ex.includes(lim.id) && (lim.stock == null || lim.stock > 0) ? lim.id : w.prizes.Other; };
      const results = await parallel(fans, pool.size * 4, who => play(who, { pick, series, prepSeries }));
      report.number("wall_ms", Date.now() - t0); report.number("outcomes", outcomes(results)); report.number("pool", pool.stats());
      await noErrors(results, "oversell race");
      const [units, distinct] = await awarded(w.prizes.Limited);
      report.check(units === stock && distinct === stock, `exactly ${stock} units awarded to ${stock} distinct fans (no oversell)`, `${units} units / ${distinct} fans`);
      report.check(await stockOf(w.prizes.Limited) === 0, "stock lands on exactly 0");
      report.check(results.every(r => st(r) === "committed"), "every fan ends committed (sold-out fans redraw on the fallback)");
      report.number("redraws", results.reduce((t, r) => t + (r.value?.redraws ?? 0), 0));
      report.latency("prepare", prepSeries, DB_THRESHOLDS.prepare + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 4)); report.latency("commit (all on one prize row)", series, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 4));
      await invariants(c, "oversell"); await ledger("oversell"); report.finish(); s.numbers.n = n;
    }
    // ============================================================ D2 idempotency
    if (want("D2")) {
      const n = scale(100), replays = scale(50);
      report.scenario("D2", `idempotency: ${n} distinct attempts on a balance of 5, ${replays} replays of one attempt, binding conflict, status recovery`);
      const c = await addCreator(), w = await addWheel(c, { prizes: [{ label: "A", weight: 1 }, { label: "B", weight: 1 }] });
      const solo = await grantFan(c, w.id, 5), series = [];
      const distinct = await parallel(Array.from({ length: n }), pool.size * 4, () => play(solo, { series }));
      await noErrors(distinct, "same-fan flood");
      const t = outcomes(distinct); report.number("outcomes", t);
      report.check(t.committed === 5 && (t.declined ?? 0) === n - 5, `exactly 5 of ${n} distinct attempts commit, the rest decline cleanly`, t);
      report.check((await scalar(`select spins_remaining||','||spins_granted_total||','||(select count(*) from public.spins where fan_pass_id=${quote(solo.pass)}) from public.fan_passes where id=${quote(solo.pass)};`)) === "0,5,5", "credits conserved: 5 granted, 5 spent, 5 spins");
      report.latency(`commit (${n} attempts on one fan row)`, series, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 4));
      // Replays: one attempt id, one body, many concurrent commits.
      const twin = await grantFan(c, w.id, 3), a = await prep(twin), body = await wheelBody(a, w.prizes.A, [], []);
      const replayed = await parallel(Array.from({ length: replays }), pool.size * 4, () => commit(twin, a, body));
      await noErrors(replayed, "replay flood");
      const ids = new Set(replayed.map(r => r.value?.spin?.id ?? r.value?.status));
      report.check(replayed.every(r => st(r) === "committed") && ids.size === 1, `${replays} concurrent commits of one attempt all answer the same committed spin`, [...ids].slice(0, 3));
      report.check((await scalar(`select spins_remaining||','||(select count(*) from public.spins where fan_pass_id=${quote(twin.pass)}) from public.fan_passes where id=${quote(twin.pass)};`)) === "2,1", "one debit, one spin row for the replayed attempt");
      // Same attempt id, different binding (client seed): a conflict, never a second spin.
      const other = await rpc("prepare_spin_attempt", [quote(a.id), quote(twin.token), quote(hash("other-seed"))]);
      const stale = await rpc("commit_spin_attempt", [quote(a.id), quote(twin.token), quote(hash("other-seed")), json(body.ctx), json(body.spin), json(body.expected), json(body.next)]);
      report.check(other.status === "conflict" && stale.status === "conflict", "a reused attempt id with another binding is a conflict at prepare and commit", `${other.status}/${stale.status}`);
      const recovered = await status(twin, a);
      report.check(recovered.status === "committed" && recovered.spin?.id === [...ids][0], "get_spin_attempt_status recovers the same receipt");
      await invariants(c, "idempotency"); report.finish();
    }
    // ============================================================ D3 editor race, switching, archive
    if (want("D3")) {
      const n = scale(60), stock = scale(10);
      report.scenario("D3", `${n} fans play 2 rounds while the creator saves odds/stock, switches games and archives`);
      const c = await addCreator();
      const A = await addWheel(c, { title: "A", prizes: [{ label: "Limited", weight: 5, stock }, { label: "Other", weight: 1 }] });
      const B = await addWheel(c, { title: "B", active: false, prizes: [{ label: "BL", weight: 1, stock: stock }, { label: "BO", weight: 1 }] });
      const fans = await grantFans(c, A.id, n, 2), series = [], saves = [], edits = [];
      const saveRows = (stockValue, expected, weight) => json([{ id: A.prizes.Limited, label: "Limited", rarity: "common", weight, stock: stockValue, emoji: "🟦", expected_stock: expected }, { id: A.prizes.Other, label: "Other", rarity: "common", weight: 1, emoji: "🟥", expected_stock: null }]);
      const editor = async () => {
        for (let i = 0; i < 10; i++) {
          // Stale editor: it loaded stock `stock` long ago and keeps re-saving it with new odds.
          edits.push(await timed(saves, () => rpc("save_wheel_prizes", [quote(A.id), quote(c), saveRows(stock, stock, 1 + i)])).then(() => "saved", e => `save:${e.code}`));
          await sleep(20);
          if (i === 3) { await sql(`update public.wheels set is_active=true where id=${quote(B.id)};update public.wheels set is_active=false where id=${quote(A.id)};`); edits.push("switch->B"); }
          if (i === 5) { await sql(`update public.wheels set archived_at=now() where id=${quote(B.id)};`); edits.push("archive B"); }
          if (i === 7) { await sql(`update public.wheels set archived_at=null where id=${quote(B.id)};update public.wheels set is_active=true where id=${quote(A.id)};update public.wheels set is_active=false where id=${quote(B.id)};`); edits.push("unarchive B, switch->A"); }
        }
      };
      const pick = (ctx, ex) => { const open = ctx.prizes.filter(p => !ex.includes(p.id) && (p.stock == null || p.stock > 0)); return (open.find(p => p.stock != null) ?? open[0])?.id ?? null; };
      const [results] = await Promise.all([parallel(fans.flatMap(f => [f, f]), pool.size * 2, who => play(who, { pick, series })), editor()]);
      report.number("outcomes", outcomes(results)); report.number("editor", edits);
      await noErrors(results, "edits during play");
      const allowed = new Set(["committed", "declined", "unavailable"]);
      report.check(results.every(r => allowed.has(st(r))), "every play ends committed or cleanly declined (no_wheel while archived)", outcomes(results));
      report.number("declined_reasons", tally(results.filter(r => st(r) !== "committed"), v => v.error ?? v.status));
      report.number("retries", results.reduce((t, r) => t + (r.value?.retries ?? 0), 0));
      const [unitsA] = await awarded(A.prizes.Limited), [unitsB] = await awarded(B.prizes.BL);
      report.check(unitsA <= stock && unitsB <= stock && (await stockOf(A.prizes.Limited)) >= 0, `stale re-saves never restock: A awarded ${unitsA} <= ${stock}, B awarded ${unitsB} <= ${stock}`);
      report.check((await stockOf(A.prizes.Limited)) === stock - unitsA, "A's live stock equals the initial stock minus the units awarded");
      report.latency("commit", series, DB_THRESHOLDS.commit); report.latency("save_wheel_prizes", saves, DB_THRESHOLDS.save);
      await invariants(c, "editor race"); report.finish();
    }
    // ============================================================ D4 campaign pin / per-link pin mid-play
    if (want("D4")) {
      const n = scale(40);
      report.scenario("D4", `campaign pin and per-link pin flip between two games while ${n} fans play`);
      const c = await addCreator(), camp = uid();
      // Two prizes per game: 0069 refuses pinning a game with fewer (campaign and link).
      const A = await addWheel(c, { title: "A", prizes: [{ label: "A1", weight: 1 }, { label: "A2", weight: 1 }] }), B = await addWheel(c, { title: "B", active: false, prizes: [{ label: "B1", weight: 1 }, { label: "B2", weight: 1 }] });
      await sql(`insert into public.campaigns(id,creator_id,name,pinned_wheel_id) values(${quote(camp)},${quote(c)},'stress',${quote(A.id)});`);
      const fans = await grantFans(c, null, n, 3, camp), series = []; let flips = 0, pins = 0;
      let playing = true;
      const pinner = async () => {
        const { context } = await mintActorContext(sql, c, c, "grant");
        try {
          // Flip the campaign pin continuously while the plays run (the dashboard's
          // PATCH /api/campaigns/[id] is a plain UPDATE under RLS: no fan or pass lock),
          // and re-pin one link through the service RPC every few flips.
          for (let i = 0; playing; i++) {
            await sql(`update public.campaigns set pinned_wheel_id=${quote(i % 2 ? A.id : B.id)} where id=${quote(camp)};`); flips++;
            if (i % 4 === 3) {
              const who = fans[i % fans.length];
              const r = JSON.parse((await sql(`begin;set local role service_role;select public.set_fan_pass_game(${quote(context)},${quote(c)},${quote(who.pass)},${i % 3 === 2 ? "null" : quote(i % 2 ? B.id : A.id)},${quote(c)});commit;`)).trim());
              if (r.status === "ok") pins++;
            }
          }
        } finally { await sql(`delete from public.creator_actor_contexts where id=${quote(context)};`); }
      };
      const [results] = await Promise.all([parallel(fans.flatMap(f => [f, f, f]), pool.size * 2, who => play(who, { series })).finally(() => { playing = false; }), pinner()]);
      const dl = deadlocks.splice(0), dlDetail = dl.length ? `${dl.length} deadlocks; ${await named(dl[0])}` : undefined;
      report.number("outcomes", outcomes(results)); report.number("flips", { campaign: flips, link: pins }); report.number("deadlocks_retried", dl.length);
      // COMMIT_RESOLVES_WHEEL_PER_STATEMENT, fixed by 0070 (see STRESS_RESULTS.md): commit_spin_attempt
      // resolves the game once, under the fan and pass locks, and locks the wheel and the prizes of
      // that one game, so a campaign-pin change mid-call can no longer make it hold game A's wheel
      // and game B's prizes (257 deadlock retries per run before the fix). A regression fails here.
      report.check(dl.length <= D4_DEADLOCK_BOUND, `at most ${D4_DEADLOCK_BOUND} deadlock(s) between commit_spin_attempt and a campaign pin change (0070)`, dlDetail ?? dl.length);
      await noErrors(results, "pin flips during play");
      report.check(results.every(r => st(r) === "committed"), "every play commits on whichever game the pin resolved to", outcomes(results));
      report.check((await scalar(`select count(*) from public.spins where creator_id=${quote(c)} and wheel_id not in(${quote(A.id)},${quote(B.id)});`)) === "0", "every spin is on A or B");
      report.number("spins_per_game", Object.fromEntries((await sql(`select w.title,count(*) from public.spins s join public.wheels w on w.id=s.wheel_id where s.creator_id=${quote(c)} group by 1 order by 1;`)).split("\n").map(l => l.split("\t"))));
      report.latency("commit", series, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * pool.size * 2);
      await invariants(c, "pins"); report.finish();
    }
    // ============================================================ D5 bulk import + grants under load
    if (want("D5")) {
      const rows = 500, par = 5, n = scale(40);
      report.scenario("D5", `a ${rows}-row import replayed ${par}x in parallel plus concurrent grants/edits while ${n} fans play`);
      const c = await addCreator(), w = await addWheel(c, { prizes: [{ label: "A", weight: 1 }, { label: "B", weight: 1 }] });
      const fans = await grantFans(c, w.id, n, 2), series = [], imports = [], grants = [];
      const slots = Array.from({ length: rows }, (_, i) => ({ name: `Imported ${i}`, spins: 2, amountCents: 0, campaignId: null, wheelId: null, error: null }));
      const requestHash = hash(canonical(["fan-import-v1", slots])), batch = randomUUID();
      const importOnce = () => timed(imports, () => rpc("import_fans_durable", [quote(batch), quote(c), quote(requestHash), json(slots)]));
      const target = fans[0], same = randomUUID();
      const [plays, imported, sameGrants] = await Promise.all([
        parallel(fans.flatMap(f => [f, f]), pool.size * 2, who => play(who, { series })),
        parallel(Array.from({ length: par }), par, importOnce),
        parallel(Array.from({ length: 20 }), 20, () => timed(grants, () => rpc("grant_pass_spins", [quote(same), quote(c), quote(target.fan), quote(target.pass), "3", "0", "0", "null"]))),
      ]);
      await noErrors(plays, "plays during import"); await noErrors(imported, "parallel import replays"); await noErrors(sameGrants, "one-requestId grant flood");
      const fresh = imported.filter(r => r.value?.status === "imported" && r.value.replayed === false).length, replayedCount = imported.filter(r => r.value?.status === "imported" && r.value.replayed === true).length;
      report.check(fresh === 1 && replayedCount === par - 1, `one batch imported once, ${par - 1} replays`, tally(imported, v => `${v.status}:${v.replayed}`));
      report.check((await scalar(`select count(*) from public.fans where creator_id=${quote(c)} and display_name like 'Imported %';`)) === String(rows), `${rows} imported fans exist exactly once`);
      report.check(imported.every(r => r.ok && r.value?.items?.length === rows && r.value.items.every(i => i.token)), "every receipt carries all rows with tokens");
      report.check(sameGrants.every(r => st(r) === "granted") && sameGrants.filter(r => r.value.replayed === false).length === 1, "20 concurrent grants with one requestId apply once (19 replays)", tally(sameGrants, v => `${v.status}:${v.replayed}`));
      // 0062 caps live actor contexts at 32 per actor: a 40-way burst of distinct privileged calls
      // is partly refused with 54000, and nothing is half-applied.
      const burst = await parallel(Array.from({ length: 40 }), 40, () => timed(grants, () => rpc("grant_pass_spins", [quote(randomUUID()), quote(c), quote(target.fan), quote(target.pass), "1", "0", "0", "null"])));
      const burstGranted = burst.filter(r => st(r) === "granted" && r.value.replayed === false).length, burstRefused = burst.filter(r => !r.ok);
      report.number("burst_40_distinct_grants", { granted: burstGranted, refused: burstRefused.length, codes: tally(burstRefused, () => "") });
      report.check(burstRefused.every(r => r.code === "54000") && burstGranted + burstRefused.length === 40, "a burst beyond 32 live actor contexts is refused only with 54000 (actor context limit), never half-applied", burstRefused.filter(r => r.code !== "54000").map(r => r.error).slice(0, 2));
      const balance = Number(await scalar(`select spins_granted_total from public.fan_passes where id=${quote(target.pass)};`));
      report.check(balance === 2 + 3 + burstGranted, `granted total is exactly 2 + 3 + ${burstGranted} (the grants that were accepted)`, balance);
      // edit_pass_grant: one requestId many times, then distinct patches.
      const grantId = target.grant, edit = (req, patch) => rpc("edit_pass_grant", [quote(req), quote(c), quote(grantId), json(patch), quote(c)]);
      const req = randomUUID();
      const sameEdits = await parallel(Array.from({ length: 10 }), 10, () => edit(req, { spins: 5 }));
      await noErrors(sameEdits, "concurrent edits of one grant");
      report.number("edit_outcomes", tally(sameEdits, v => `${v.status}:${v.replayed ?? ""}`));
      report.check(sameEdits.every(r => st(r) === "updated") && sameEdits.filter(r => r.value.replayed === false).length <= 1, "an edit replayed under one requestId applies at most once");
      report.check(Number(await scalar(`select spins from public.grants where id=${quote(grantId)};`)) === 5, "the grant's spins read the edited value exactly");
      const conflict = await edit(req, { spins: 6 });
      report.check(conflict.status === "conflict", "the same requestId with another patch is a conflict", conflict.status);
      report.latency(`commit (during the import, ${pool.size * 2} in flight)`, series, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * pool.size * 2); report.latency("import 500 rows", imports, DB_THRESHOLDS.import500); report.latency("grant_pass_spins (all on one pass row, beside the plays)", grants, DB_THRESHOLDS.grant + DB_THRESHOLDS.perContender * (40 + pool.size * 2));
      await invariants(c, "import+grants"); report.finish();
    }
    // ============================================================ D6 scratch + bingo
    if (want("D6")) {
      const n = scale(40), stock = 5, nb = quick ? 6 : 12;
      report.scenario("D6", `scratch: ${n} fans on a 5-unit prize; bingo: ${nb} fans play concurrently`);
      const c = await addCreator();
      const S = await addWheel(c, { kind: "scratch", title: "S", prizes: [{ label: "Limited", weight: 1000, stock, rarity: "rare" }, { label: "Other", weight: 1 }, { label: "Third", weight: 1 }] });
      const fans = await grantFans(c, S.id, n), series = [];
      const results = await parallel(fans, pool.size * 2, who => play(who, { series }));
      await noErrors(results, "scratch race");
      report.number("outcomes", outcomes(results));
      const [units, distinct] = await awarded(S.prizes.Limited), targeted = results.filter(r => r.value?.prizeId === S.prizes.Limited || r.value?.redraws > 0).length;
      report.check(results.every(r => st(r) === "committed"), "every scratch play commits (sold-out fans redraw)");
      report.check(units === Math.min(stock, targeted) && distinct === units, `scratch awards exactly ${Math.min(stock, targeted)} units from ${targeted} draws of the limited prize`, `${units}/${distinct}`);
      report.check(await stockOf(S.prizes.Limited) === stock - units, "scratch stock accounts exactly");
      report.latency("scratch commit", series, DB_THRESHOLDS.commit);
      // Its own creator: beside the (older) scratch game the shared ranking would serve scratch, not Bingo.
      const bc = await addCreator(), bingo = await addBingo(bc), bfans = await grantFans(bc, bingo.id, nb, 2), bseries = [];
      const b1 = await parallel(bfans, nb, who => play(who, { series: bseries }));
      await noErrors(b1, "bingo race");
      report.number("bingo_outcomes", outcomes(b1));
      report.check(b1.every(r => st(r) === "committed" && r.value.kind === "bingo"), "every bingo play commits concurrently on the Bingo game");
      const cards = await scalar(`select count(*)||','||count(distinct fan_id)||','||(select count(*) from (select fan_id from public.bingo_cards where wheel_id=${quote(bingo.id)} and status='active' group by 1 having count(*)>1) d) from public.bingo_cards where wheel_id=${quote(bingo.id)};`);
      report.check(cards.split(",")[1] === String(nb) && cards.split(",")[2] === "0", "every fan holds one active card (cards,fans,fans-with-two-active)", cards);
      const b2 = await parallel(bfans, nb, who => play(who, { series: bseries }));
      await noErrors(b2, "bingo second round");
      report.check(b2.every(r => st(r) === "committed") && (await scalar(`select count(*) from public.bingo_cards where wheel_id=${quote(bingo.id)} and version<2;`)) === "0", "a second concurrent round advances every card version");
      report.latency("bingo commit", bseries, DB_THRESHOLDS.commit * 2);
      await invariants(c, "scratch"); await invariants(bc, "bingo"); await ledger("scratch+bingo"); report.finish();
    }
    // ============================================================ D7 code prizes
    if (want("D7")) {
      const n = scale(50), codes = 5, paste = quick ? 300 : 1000;
      report.scenario("D7", `${n} fans on a ${codes}-code prize while ${paste} codes are pasted on another prize`);
      const c = await addCreator(), w = await addWheel(c, { prizes: [{ label: "Codes", weight: 1 }, { label: "More", weight: 1 }, { label: "Other", weight: 1 }] });
      const codeRow = (tag, i) => ({ cipher: `c-${tag}-${i}`, iv: `iv-${i}`, key_version: 1, hint: `h${i % 10}`, fingerprint: hash(`${tag}-${c}-${i}`) });
      await rpc("add_reward_codes", [quote(w.prizes.Codes), quote(c), json(Array.from({ length: codes }, (_, i) => codeRow("a", i)))]);
      report.check(await stockOf(w.prizes.Codes) === codes, "a code prize's stock is its unused-code count");
      const fans = await grantFans(c, w.id, n), series = [], pastes = [];
      const pick = (ctx, ex) => { const cp = ctx.prizes.find(p => p.id === w.prizes.Codes); return !ex.includes(cp.id) && (cp.stock == null || cp.stock > 0) ? cp.id : w.prizes.Other; };
      const [results, pasted] = await Promise.all([
        parallel(fans, pool.size * 2, who => play(who, { pick, series, maxRounds: 24 })),
        (async () => { await sleep(30); return timed(pastes, () => rpc("add_reward_codes", [quote(w.prizes.More), quote(c), json(Array.from({ length: paste }, (_, i) => codeRow("b", i)))])); })(),
      ]);
      await noErrors(results, "code race");
      report.number("outcomes", outcomes(results)); report.number("retries_changed_or_context", results.reduce((t, r) => t + (r.value?.retries ?? 0), 0)); report.number("redraws_sold_out", results.reduce((t, r) => t + (r.value?.redraws ?? 0), 0));
      report.check(results.every(r => st(r) === "committed"), "every fan ends committed");
      report.check((await scalar(`select count(*)||','||count(distinct spin_id) from public.prize_reward_codes where prize_id=${quote(w.prizes.Codes)} and spin_id is not null;`)) === `${codes},${codes}`, `exactly ${codes} distinct codes assigned`);
      report.check((await scalar(`select count(*) from public.spins where prize_id=${quote(w.prizes.Codes)};`)) === String(codes) && await stockOf(w.prizes.Codes) === 0, `${codes} code wins, stock 0`);
      report.check(pasted === paste && await stockOf(w.prizes.More) === paste, `${paste} codes pasted mid-race land as stock`, pasted);
      report.latency(`commit (${n} fans on one code prize)`, series, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * n); report.latency(`add_reward_codes x${paste}`, pastes, DB_THRESHOLDS.save * 3);
      await invariants(c, "codes"); await ledger("codes"); report.finish();
    }
    // ============================================================ D8 scale seed + deletion/retention while activity continues
    if (want("D8")) {
      const fansN = scale(400), rounds = quick ? 3 : 5, active = scale(40);
      report.scenario("D8", `seed ${fansN} fans x ${rounds} spins, then retention cleanup, a creator deletion cascade and a fan deletion while ${active} fans keep playing`);
      const big = await addCreator(), bw = await addWheel(big, { prizes: [{ label: "A", weight: 1 }, { label: "B", weight: 3 }] });
      const seedSeries = []; const t0 = Date.now();
      const seeded = await grantFans(big, bw.id, fansN, rounds);
      const seedPlays = await parallel(seeded.flatMap(f => Array.from({ length: rounds }, () => f)), pool.size * 2, who => play(who, { series: seedSeries }));
      await noErrors(seedPlays, "scale seed");
      report.number("seed", { fans: fansN, spins: Number(await scalar(`select count(*) from public.spins where creator_id=${quote(big)};`)), wall_ms: Date.now() - t0 });
      report.latency(`commit at scale (${pool.size * 2} in flight over ${fansN} fans)`, seedSeries, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * pool.size * 2);
      const inv = []; await timed(inv, () => ledger("at scale")); report.latency("run_reward_ledger_invariants", inv, DB_THRESHOLDS.invariants);
      // Live creator keeps playing while maintenance runs.
      const live = await addCreator(), lw = await addWheel(live, { prizes: [{ label: "A", weight: 1 }, { label: "B", weight: 1 }] }), lfans = await grantFans(live, lw.id, active, 3), series = [], ret = [], cascade = [];
      const victim = lfans[0];
      const maintenance = async () => {
        await sleep(20);
        const both = await parallel([0, 1], 2, () => timed(ret, () => sql(`begin;set local role service_role;select public.run_retention_cleanup(365,90,365,90,90);commit;`)));
        report.check(both.every(r => r.ok), "two concurrent retention runs both succeed", both.filter(r => !r.ok).map(r => r.error));
        const reserved = await scalar(`begin;set local role service_role;select public.reserve_self_account_deletion(${quote(big)});commit;`);
        report.check(reserved === "ok", "the scale creator's deletion is reserved", reserved);
        await timed(cascade, () => sql(`delete from auth.users where id=${quote(big)};`));
        report.check((await scalar(`select count(*) from public.spins where creator_id=${quote(big)};`)) === "0" && (await scalar(`select count(*) from public.profiles where id=${quote(big)};`)) === "0", "the account cascade removed the creator and its spins");
        await sql(`delete from public.fans where id=${quote(victim.fan)} and creator_id=${quote(live)};`);
      };
      const [results] = await Promise.all([parallel(lfans.flatMap(f => [f, f, f]), pool.size, who => play(who, { series })), maintenance()]);
      const mine = results.filter((_, i) => lfans[Math.floor(i / 3)] !== victim), victims = results.filter((_, i) => lfans[Math.floor(i / 3)] === victim);
      await noErrors(mine, "plays during maintenance");
      report.check(mine.every(r => st(r) === "committed"), "other fans' plays all commit while maintenance runs", outcomes(mine));
      report.number("deleted_fan_outcomes", tally(victims, v => `${v.status}:${v.error ?? ""}`));
      report.check(victims.every(r => !r.ok ? /fan|pass|not found|violat/i.test(r.error) : ["committed", "unavailable", "declined", "conflict"].includes(r.value.status)), "the deleted fan's in-flight plays end committed-before or cleanly unavailable", victims.filter(r => !r.ok).map(r => r.error).slice(0, 2));
      report.latency("commit during maintenance", series, DB_THRESHOLDS.commit * 2); report.latency("run_retention_cleanup", ret, DB_THRESHOLDS.retention); report.latency(`creator deletion cascade (${fansN} fans, ${fansN * rounds} spins)`, cascade, DB_THRESHOLDS.cascade);
      await invariants(live, "maintenance"); await ledger("after deletion"); report.finish();
    }
    // ============================================================ D9 Focus/Chase under contention
    if (want("D9")) {
      const n = scale(60), rounds = quick ? 10 : 16, CHASE_STOCK = 20, CODES = 10, FOCUS_STOCK = 30;
      report.scenario("D9", `${n} fans play up to ${rounds} rounds while Focus/Chase packs are granted, replayed and cancelled, the creator edits the Focus prize's stock and archives its game`);
      const c = await addCreator();
      await sql(`insert into public.focus_creator_config(creator_id,chase_enabled) values(${quote(c)},true);`);
      // Every game keeps >= 2 prizes (0069). F is the live game; G takes over when F is archived.
      const F = await addWheel(c, { title: "Focus game", prizes: [{ label: "Common", weight: 20 }, { label: "FocusTarget", weight: 2, stock: FOCUS_STOCK }, { label: "ChaseTarget", weight: 1, stock: CHASE_STOCK, rarity: "rare" }, { label: "ChaseCode", weight: 1, rarity: "rare" }, { label: "Rare", weight: 1, rarity: "rare" }] });
      const G = await addWheel(c, { title: "Fallback game", active: false, prizes: [{ label: "GCommon", weight: 4 }, { label: "GRare", weight: 1, rarity: "rare" }] });
      await sql(`update public.prizes set boostable=true where id in(${[F.prizes.FocusTarget, F.prizes.ChaseTarget, F.prizes.ChaseCode, G.prizes.GRare].map(quote).join(",")});`);
      await rpc("add_reward_codes", [quote(F.prizes.ChaseCode), quote(c), json(Array.from({ length: CODES }, (_, i) => ({ cipher: `d9-${i}`, iv: `iv-${i}`, key_version: 1, hint: `h${i}`, fingerprint: hash(`d9-${c}-${i}`) })))]);
      const makePack = async kind => { const id = uid(); await sql(`insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,focus_spins,chase_within,focus_multiplier) values(${quote(id)},${quote(c)},'d9 ${kind}',6,${quote(kind)},5,5,3);`); return id; };
      const packs = { focus: await makePack("focus"), chase: await makePack("chase") };
      const fans = await grantFans(c, null, n, 6);
      const series = [], prepSeries = [], grantSeries = [], cancelSeries = [], editSeries = [], archiveSeries = [];
      const forged = { pity: 0, chase: 0, early: 0 }, refused = {}, forgeUnexpected = [], grantsOut = [], replayGroups = [], cancelsOut = [], edits = [], deltas = [];
      let wheelGen = null, forgeTick = 0, completed = 0, rateLimited = 0, playing = true, archived = false;
      const codeRow = async id => JSON.parse((await scalar(`select jsonb_build_object('delivery','codes','codeId',id,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_reward_codes where id=${quote(id)} and spin_id is null;`)) || "null");
      const rare = p => ["rare", "epic", "legendary"].includes(p.rarity);
      // The service's body (commitSpinAttempt), drawn by the real engine through the bridge.
      const focusBody = async (a, excluded, used) => {
        wheelGen ??= bridge("scripts/stress/wheelProofFixture.ts");
        const ctx = a.context, g = await wheelGen({ context: ctx, excluded, clientSeed: "stress-d9" }), d = g.draw, p = ctx.prizes.find(x => x.id === d.prize.id);
        const held = ctx.reservation?.prize_id === p.id && g.snapshot.modifiers.chase?.eligible === true;
        const expected = p.delivery === "codes" ? (held ? await codeRow(ctx.reservation.code_id) : await freeCode(p.id, used) ?? await freeCode(p.id, [])) ?? { delivery: "codes", codeId: randomUUID(), cipher: "", iv: "", keyVersion: 1 } : { delivery: p.delivery ?? "manual" };
        const spin = { id: a.id, fan_id: ctx.fanId, fan_pass_id: ctx.passId, creator_id: ctx.creatorId, wheel_id: ctx.wheelId, campaign_id: ctx.campaignId, prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url,
          server_seed: ctx.serverSeed, server_seed_hash: ctx.serverSeedHash, nonce: ctx.nonce, client_seed: g.clientSeed, fair_version: 3, pool_snapshot: g.snapshot, pool_hash: g.poolHash, fair_trace: g.trace,
          next_pity_counter: d.nextPityCounter, focus_consumed: d.focusConsumed ?? false, chase_consumed: d.chaseConsumed ?? false, chase_completed: d.chaseCompleted ?? false, next_focus_spins_left: d.nextFocusSpinsLeft ?? null, next_chase_counter: d.nextChaseCounter ?? null,
          response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, response_prize_index: Math.max(0, g.prizeIndex), response_show_stock: ctx.wheel.show_stock };
        return { ctx: { contextHash: ctx.contextHash }, spin, expected, next: nextSeed(), prizeId: p.id, codeId: expected.codeId, g };
      };
      // A client that claims an outcome it is not entitled to: a common prize while a guarantee is due, or an early Chase completion.
      const forge = (body, a) => {
        const s = structuredClone(body), ctx = a.context, g = body.g, common = ctx.prizes.find(p => !rare(p) && p.stock == null);
        const asWin = p => Object.assign(s.spin, { prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url, fair_trace: { ...s.spin.fair_trace, won: p.id }, response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, next_pity_counter: rare(p) ? 0 : ctx.pityCounter + 1 });
        if (g.chaseForced) { asWin(common); s.spin.chase_completed = false; return { kind: "chase", body: s, expect: /chase guarantee violated/ }; }
        if (g.pityForced) { asWin(common); return { kind: "pity", body: s, expect: /pity guarantee violated/ }; }
        const chase = g.snapshot.modifiers.chase;
        if (chase?.eligible && s.spin.prize_id !== chase.prizeId) { s.spin.chase_completed = true; return { kind: "early", body: s, expect: /counter transition mismatch/ }; }
        return null;
      };
      const focusPlay = async who => {
        let a = await prep(who, undefined, prepSeries), forgeTried = false; const excluded = [], used = [];
        for (let round = 0; round < 16; round++) {
          if (a.status !== "ready") return { status: a.status, error: a.error ?? null };
          const body = await focusBody(a, excluded, used);
          const f = forgeTried ? null : forge(body, a); forgeTried = true;
          if (f && ++forgeTick % 2 === 0) {
            forged[f.kind]++;
            try { const r = await commit(who, a, f.body); if (r.status === "committed") forgeUnexpected.push(`${f.kind}: committed`); else refused[`${f.kind}:${r.status}`] = (refused[`${f.kind}:${r.status}`] ?? 0) + 1; }
            catch (e) { if (e.code === "40P01") deadlocks.push(e.detail ?? e.message); const k = `${f.kind}:${e.code}:${f.expect.test(e.message) ? "refused" : e.message}`; refused[k] = (refused[k] ?? 0) + 1; }
          }
          let r;
          try { r = await timed(series, () => commit(who, a, body)); } catch (e) { if (e.code !== "40P01") throw e; deadlocks.push(e.detail ?? e.message); continue; }
          if (r.status === "committed") return { status: "committed", prizeId: body.prizeId };
          if (r.status === "sold_out") { excluded.push(body.prizeId); continue; }
          if (r.status === "changed" && body.codeId) used.push(body.codeId);
          if (r.status === "retry_context" || r.status === "changed") { a = await prep(who, a.id); excluded.length = 0; continue; }
          return { status: r.status, error: r.error ?? null };
        }
        await cancel(who, a).catch(() => {});
        return { status: "exhausted" };
      };
      // A fan keeps playing until the credits run out. The 8-per-10s fan window is real: a declined play ages the window (the pause a person would take) and plays again.
      const fanLoop = async who => {
        const out = [];
        for (let i = 0; i < rounds; i++) {
          let r = await focusPlay(who);
          if (r.status === "declined" && r.error === "rate_limited") { rateLimited++; await sql(`update public.fans set rl_window_start=now()-interval '11 seconds' where id=${quote(who.fan)};`); r = await focusPlay(who); }
          out.push(r); completed++;
          if (r.status !== "committed") break;
        }
        return out;
      };
      const guard = (promise, out) => promise.catch(e => { if (e.code === "40P01") deadlocks.push(e.detail ?? e.message); return { status: `error:${e.code ?? "?"}`, error: e.message }; }).then(v => { out?.push(v.status); return v; });
      const creatorLoop = async () => {
        for (let i = 0; playing; i += 4) {
          await parallel([0, 1, 2, 3], 4, async j => {
            const k = (i + j) % n, who = fans[k];
            const live = await scalar(`select coalesce((select id::text from public.fan_focus where fan_id=${quote(who.fan)} and status in('active','paused')),'none');`);
            if (live !== "none" && (i / 4 + j) % 3 === 0) return guard(timed(cancelSeries, () => rpc("cancel_fan_focus", [quote(c), quote(who.fan), quote(live)])), cancelsOut);
            const kind = (i / 4 + k) % 2 ? "chase" : "focus";
            const prize = archived ? G.prizes.GRare : kind === "focus" ? F.prizes.FocusTarget : k % 4 < 2 ? F.prizes.ChaseCode : F.prizes.ChaseTarget;
            const args = [quote(randomUUID()), quote(c), quote(who.fan), quote(who.pass), quote(packs[kind]), quote(prize)];
            // Every fifth purchase is a double-submit: three copies of one requestId at once.
            const copies = k % 5 === 0 ? 3 : 1;
            const rs = await Promise.all(Array.from({ length: copies }, () => guard(timed(grantSeries, () => rpc("grant_focus_pack", args)), grantsOut)));
            if (copies > 1) replayGroups.push({ request: args[0], rs });
          });
          await sleep(5);
        }
      };
      const prizeRows = async () => (await sql(`select coalesce(json_agg(json_build_object('id',id,'label',label,'rarity',rarity,'weight',weight,'emoji',emoji,'boostable',boostable,'stock',stock) order by sort_order),'[]') from public.prizes where wheel_id=${quote(F.id)};`)).trim();
      const editor = async () => {
        const stale = JSON.parse(await prizeRows());
        for (let i = 0; playing && !archived && i < 14; i++) {
          await sleep(40);
          const fresh = JSON.parse(await prizeRows()), staleSave = i % 4 === 3;
          let delta = [3, -2, 4, 0, -1, 2][i % 6];
          // A cut is only made with room to spare so the save never clamps at 0 (the conservation check below is exact).
          if (delta < 0 && (fresh.find(r => r.id === F.prizes.FocusTarget).stock ?? 0) < 15) delta = 2;
          const rows = (staleSave ? stale : fresh).map(r => ({ ...r, expected_stock: r.stock }));
          // The stale editor re-saves what it loaded at the start: a zero delta, it must never restock.
          if (staleSave) delta = 0; else rows.find(r => r.id === F.prizes.FocusTarget).stock += delta;
          await timed(editSeries, () => rpc("save_wheel_prizes", [quote(F.id), quote(c), json(rows)])).then(() => { deltas.push(delta); edits.push(`${staleSave ? "stale" : "save"}${delta >= 0 ? "+" : ""}${delta}`); }, e => { if (e.code === "40P01") deadlocks.push(e.detail ?? e.message); edits.push(`save:${e.code}`); });
        }
      };
      // Archive the Focus game through the dashboard's RPC (it locks the game's Focus/Chase fans before the wheel) once the base credits are about spent, then switch to G.
      const archiver = async () => {
        while (playing && completed < n * 6) await sleep(20);
        const r = await guard(timed(archiveSeries, () => sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(c)},true);select public.archive_wheel(${quote(F.id)});commit;`).then(v => ({ status: v.trim().split("\n").at(-1) }))));
        await sql(`update public.wheels set is_active=true where id=${quote(G.id)};`);
        archived = true; edits.push(`archive:${r.status}`);
      };
      const t0 = Date.now();
      const [loops] = await Promise.all([parallel(fans, n, fanLoop).finally(() => { playing = false; }), creatorLoop(), editor(), archiver()]);
      const results = loops.flatMap(r => r.ok ? r.value.map(v => ({ ok: true, value: v })) : [r]);
      const dl = deadlocks.splice(0);
      report.number("wall_ms", Date.now() - t0); report.number("plays", outcomes(results)); report.number("rate_limit_pauses", rateLimited);
      report.number("grants", tally(grantsOut.map(s => ({ ok: true, value: s })), s => s)); report.number("cancels", tally(cancelsOut.map(s => ({ ok: true, value: s })), s => s)); report.number("editor", edits);
      report.number("forged", forged); report.number("forged_outcomes", refused); report.number("deadlocks_retried", dl.length);
      report.check(dl.length <= D9_DEADLOCK_BOUND, `at most ${D9_DEADLOCK_BOUND} deadlock(s) between plays, Focus/Chase grants/cancels, stock saves and archive_wheel`, dl.length ? `${dl.length}; ${await named(dl[0])}` : 0);
      await noErrors(results, "focus/chase plays");
      report.check(results.every(r => r.ok && (r.value.status === "committed" || (r.value.status === "declined" && r.value.error === "no_spins"))), "every play commits until the fan's credits run out", outcomes(results));
      const grantOk = ["granted", "focus_exists", "sold_out", "invalid_target", "rejected"];
      report.check(grantsOut.every(s => grantOk.includes(s)), "every Focus/Chase purchase is granted or cleanly refused (focus_exists, sold_out, invalid_target; a replayed refusal answers rejected)", grantsOut.filter(s => !grantOk.includes(s)).slice(0, 3));
      report.check(cancelsOut.every(s => s === "released" || s === "absent"), "every cancel releases or finds the promise already gone", cancelsOut.filter(s => s !== "released" && s !== "absent").slice(0, 3));
      const replayOk = [];
      for (const g of replayGroups) {
        const granted = g.rs.filter(r => r.status === "granted"), rows = Number(await scalar(`select count(*) from public.grants where id=${g.request};`));
        // A refused purchase is journalled: its copies answer `rejected` with the original refusal.
        const first = g.rs.filter(r => r.status !== "rejected");
        replayOk.push(granted.length === 0 ? rows === 0 && first.length === 1 && g.rs.filter(r => r.status === "rejected").every(r => r.error === first[0].status) : granted.length === 3 && granted.filter(r => r.replayed === false).length === 1 && new Set(granted.map(r => r.focus?.id)).size === 1 && rows === 1);
      }
      report.check(replayOk.every(Boolean), `${replayGroups.length} double-submitted purchases (3 copies of one requestId) apply once: one grant row, one promise, two replays`, replayOk.filter(v => !v).length);
      report.check(forgeUnexpected.length === 0 && Object.keys(refused).every(k => /:22023:refused$/.test(k) || /:(retry_context|changed|sold_out|declined)$/.test(k)), "every forged outcome (a common prize while pity or Chase is due, an early Chase completion) is refused with 22023 (or meets a changed context first) and never commits", { refused, forgeUnexpected });
      const v = JSON.parse(await scalar(`with s as (select s.*,a.result from public.spins s join public.spin_attempts a on a.spin_id=s.id where s.creator_id=${quote(c)} and s.kind='play'),
        snap as (select s.*,s.pool_snapshot->'modifiers' m,coalesce(s.fair_trace->'excluded','[]'::jsonb) ex from s)
        select jsonb_build_object(
        'focusMismatch',(select count(*) from public.fans f where f.creator_id=${quote(c)} and coalesce((select sum(z.total_spins-z.spins_left) from public.fan_focus z where z.fan_id=f.id and z.kind='focus'),0)<>(select count(*) from s where s.fan_id=f.id and (s.result->>'focusConsumed')::boolean)),
        'chaseMismatch',(select count(*) from public.fans f where f.creator_id=${quote(c)} and coalesce((select sum(z.chase_counter) from public.fan_focus z where z.fan_id=f.id and z.kind='chase'),0)<>(select count(*) from s where s.fan_id=f.id and (s.result->>'chaseConsumed')::boolean)),
        'focusRange',(select count(*) from public.fan_focus where creator_id=${quote(c)} and (spins_left<0 or spins_left>total_spins or chase_counter<0 or chase_counter>total_spins)),
        'liveOnArchived',(select count(*) from public.fan_focus where creator_id=${quote(c)} and wheel_id=${quote(F.id)} and status in('active','paused')),
        'heldOnArchived',(select count(*) from public.chase_reservations where creator_id=${quote(c)} and state='held' and prize_id in(${[F.prizes.ChaseTarget, F.prizes.ChaseCode].map(quote).join(",")})),
        'doubleConsumed',(select count(*) from (select consumed_spin_id from public.chase_reservations where creator_id=${quote(c)} and consumed_spin_id is not null group by 1 having count(*)>1) d),
        'consumedMismatch',(select count(*) from public.chase_reservations r join public.fan_focus z on z.id=r.focus_id left join public.spins x on x.id=r.consumed_spin_id where r.creator_id=${quote(c)} and r.state='consumed' and (x.id is null or x.prize_id<>r.prize_id or x.fan_id<>z.fan_id)),
        'consumedVsCompleted',(select count(*) from public.chase_reservations where creator_id=${quote(c)} and state='consumed')-(select count(*) from s where (s.result->>'chaseCompleted')::boolean),
        'heldCodes',(select count(*) from public.prize_reward_codes where prize_id=${quote(F.prizes.ChaseCode)} and reserved_focus_id is not null),
        'grantLedger',(select count(*) from public.fan_passes p where p.creator_id=${quote(c)} and p.spins_granted_total<>(select coalesce(sum(g.spins),0) from public.grants g where g.fan_pass_id=p.id)),
        'balanceLedger',(select count(*) from public.fan_passes p where p.creator_id=${quote(c)} and p.spins_remaining<>p.spins_granted_total-(select count(*) from public.spins x where x.fan_pass_id=p.id and x.kind='play')),
        'pityUnentitled',(select count(*) from snap where (result->>'pityAwarded')::boolean and not((m#>>'{pity,counter}')::int+1>=(m#>>'{pity,threshold}')::int and prize_rarity in('rare','epic','legendary'))),
        'chaseUnentitled',(select count(*) from snap where (result->>'chaseAwarded')::boolean and not(m->'chase' is not null and m->'chase'<>'null'::jsonb and (m#>>'{chase,eligible}')::boolean and (m#>>'{chase,counter}')::int+1>=(m#>>'{chase,within}')::int and prize_id::text=m#>>'{chase,prizeId}')),
        'chaseMissed',(select count(*) from snap where m->'chase'<>'null'::jsonb and (m#>>'{chase,eligible}')::boolean and (m#>>'{chase,counter}')::int+1>=(m#>>'{chase,within}')::int and prize_id::text<>m#>>'{chase,prizeId}'),
        'pityMissed',(select count(*) from snap where (m#>>'{pity,counter}')::int+1>=(m#>>'{pity,threshold}')::int and prize_rarity not in('rare','epic','legendary')
          and not(m->'chase'<>'null'::jsonb and (m#>>'{chase,eligible}')::boolean and (m#>>'{chase,counter}')::int+1>=(m#>>'{chase,within}')::int)
          and exists(select 1 from jsonb_array_elements(pool_snapshot->'prizes') x where x->>'rarity' in('rare','epic','legendary') and not(ex ? (x->>'id')))),
        'pityAwarded',(select count(*) from s where (result->>'pityAwarded')::boolean),'chaseAwarded',(select count(*) from s where (result->>'chaseAwarded')::boolean),
        'focusConsumed',(select count(*) from s where (result->>'focusConsumed')::boolean),'chaseCompleted',(select count(*) from s where (result->>'chaseCompleted')::boolean),
        'focusPaused',(select count(*) from snap where m->'focus'<>'null'::jsonb and not (m#>>'{focus,applied}')::boolean),
        'spinsOnF',(select count(*) from s where wheel_id=${quote(F.id)}),'spinsOnG',(select count(*) from s where wheel_id=${quote(G.id)}),
        'focusStatuses',(select jsonb_object_agg(k,v) from (select kind||':'||status k,count(*) v from public.fan_focus where creator_id=${quote(c)} group by 1) q));`));
      report.number("ledger", v);
      report.check(v.focusMismatch === 0 && v.chaseMismatch === 0, "no double consumption: every Focus spin used and every Chase step counted is exactly one committed play", `${v.focusMismatch}/${v.chaseMismatch}`);
      report.check(v.doubleConsumed === 0 && v.consumedMismatch === 0 && v.consumedVsCompleted === 0, "every consumed Chase unit belongs to exactly one win of its own prize by its own fan", v);
      report.check(v.focusRange === 0, "every promise's counters stay within 0..length");
      report.check(v.grantLedger === 0 && v.balanceLedger === 0, "each pass's balance equals its grant ledger minus its plays (Focus/Chase packs included)", `${v.grantLedger}/${v.balanceLedger}`);
      report.check(v.pityUnentitled === 0 && v.chaseUnentitled === 0, "a forced outcome (pity or Chase) appears only when the counters entitled it", `${v.pityUnentitled}/${v.chaseUnentitled}`);
      report.check(v.pityMissed === 0 && v.chaseMissed === 0, "every due guarantee was honoured (a rare at pity, the target at the Chase deadline)", `${v.pityMissed}/${v.chaseMissed}`);
      if (quick) { if (!v.pityAwarded || !v.chaseAwarded) report.warn(`quick run: pity forced ${v.pityAwarded}, Chase forced ${v.chaseAwarded}`); }
      else report.check(v.pityAwarded > 0 && v.chaseAwarded > 0 && forged.pity > 0 && forged.chase > 0, "pity and Chase forcing both kicked in under contention (and were each probed with a forged outcome)", { pity: v.pityAwarded, chase: v.chaseAwarded, forged });
      report.check(v.liveOnArchived === 0 && v.heldOnArchived === 0 && v.heldCodes === 0, "archiving the Focus game released every promise on it and returned every held unit and code", v);
      report.check(edits.includes("archive:ok") && v.spinsOnG > 0, "the game was archived mid-play and play carried on on the fallback game", { edits: edits.at(-1), spinsOnG: v.spinsOnG });
      const [chaseWins] = await awarded(F.prizes.ChaseTarget), [codeWins] = await awarded(F.prizes.ChaseCode), [focusWins] = await awarded(F.prizes.FocusTarget);
      const chaseStock = await stockOf(F.prizes.ChaseTarget), focusStock = await stockOf(F.prizes.FocusTarget), sumDelta = deltas.reduce((t, d) => t + d, 0);
      report.check(chaseStock >= 0 && chaseStock + chaseWins === CHASE_STOCK, `Chase stock conserved: ${CHASE_STOCK} = ${chaseStock} left + ${chaseWins} won (no unit held after the archive)`);
      const codes = (await scalar(`select count(*)||','||count(spin_id)||','||count(*) filter(where spin_id is null and reserved_focus_id is null) from public.prize_reward_codes where prize_id=${quote(F.prizes.ChaseCode)};`)).split(",").map(Number);
      report.check(codes[0] === CODES && codes[1] === codeWins && codes[2] === await stockOf(F.prizes.ChaseCode), `Chase codes conserved: ${CODES} = ${codes[2]} free + ${codes[1]} assigned to ${codeWins} wins`, codes);
      report.check(focusStock >= 0 && focusStock === FOCUS_STOCK + sumDelta - focusWins, `Focus prize stock = ${FOCUS_STOCK} + creator edits (${sumDelta >= 0 ? "+" : ""}${sumDelta}) - ${focusWins} won; stale re-saves never restock`, focusStock);
      report.latency("commit (every fan on one game's prize rows)", series, DB_THRESHOLDS.commit + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 2)); report.latency("prepare", prepSeries, DB_THRESHOLDS.prepare + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 2));
      report.latency("grant_focus_pack (beside the plays)", grantSeries, DB_THRESHOLDS.grant + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 2)); report.latency("cancel_fan_focus", cancelSeries, DB_THRESHOLDS.grant + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 2));
      report.latency("save_wheel_prizes (Focus prize stock)", editSeries, DB_THRESHOLDS.save + DB_THRESHOLDS.perContender * Math.min(n, pool.size * 2)); report.latency("archive_wheel", archiveSeries, DB_THRESHOLDS.retention);
      await invariants(c, "focus/chase"); await ledger("focus/chase"); report.finish();
    }
  } finally {
    for (const b of bridges) { try { b.stdin.end(); b.kill(); } catch { /* already gone */ } }
  }
}
