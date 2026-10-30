// Interplay stress probe (A26): features in tandem on a disposable local
// PostgreSQL. sql() must run each call in its own real session so the
// concurrency sections exercise real row locks. No Supabase credential is read.
//
// Default mode prints disagreements that are documented in interplayCases.mjs
// as KNOWN-BUG lines and exits green; INTERPLAY_STRICT=1 fails on them.
// INTERPLAY_WRITE_FIXTURE=1 rewrites interplay-resolution.fixture.json (the TS
// mirror test src/lib/data/wheelResolutionInterplay.test.ts replays it).
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUGS, CASES, SURPRISES } from "./interplayCases.mjs";
const quote = s => `'${String(s).replaceAll("'", "''")}'`;
const json = v => `${quote(JSON.stringify(v))}::jsonb`;
const hash = s => createHash("sha256").update(s).digest("hex");
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const uid = (n, suffix) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${suffix.padStart(12, "0")}`;
const TERMS = "2026-10-27";
const FIXTURE = join(import.meta.dirname, "interplay-resolution.fixture.json");

export async function probeInterplay(sqlInput, options = {}) {
  const strict = options.strict ?? process.env.INTERPLAY_STRICT === "1";
  const writeFixture = options.writeFixture ?? process.env.INTERPLAY_WRITE_FIXTURE === "1";
  const pending = new Set();
  const sql = q => { const p = sqlInput(q); pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p; };
  let checks = 0; const knownBugs = []; const surprises = new Set(); const creators = [];
  const check = (v, label) => { checks++; if (!v) throw Error(`interplay ${label}`); };
  const known = (id, detail) => { checks++; knownBugs.push(`${id}: ${detail}`); };
  const rpc = async (name, args) => JSON.parse((await sql(`select public.${name}(${args.join(",")});`)).trim() || "null");
  const scalar = async q => (await sql(q)).trim();
  const refused = async (q, pattern) => { try { await sql(q); return false; } catch (e) { if (pattern && !pattern.test(e.message)) throw Error(`Unexpected SQL refusal: ${e.message}`); return true; } };
  const settled = ps => Promise.all(ps.map(p => p.then(value => ({ ok: true, value }), e => ({ ok: false, error: e.message }))));
  const lastLine = out => out.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const asUser = (user, stmt) => sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(user)},true);select set_config('request.jwt.claim.role','authenticated',true);${stmt};commit;`).then(lastLine);

  const addCreator = async (id, features = { scratch: true, bingo: true }) => {
    creators.push(id);
    await sql(`insert into auth.users(id,email) values(${quote(id)},'interplay-${id}@example.test');update public.profiles set is_active=true,approval_status='approved',features=${json(features)} where id=${quote(id)};`);
    return id;
  };
  const addWheel = async (id, creator, spec, title = id.slice(-1)) => {
    const ts = h => h == null ? "null" : `now()+interval '${h} hours'`;
    if (spec.k === "bingo") {
      // A Bingo game starts as a draft and is published through the atomic saver (0061); a draft stays unready.
      await sql(`insert into public.wheels(id,creator_id,title,show_stock,created_at,game_kind,game_config,game_ready) values(${quote(id)},${quote(creator)},${quote(title)},false,now()-interval '${spec.age ?? 60} minutes','bingo','{"size":3,"linePrizeId":null}',false);`);
      if (spec.ready === false) return;
      const line = randomUUID(), cells = Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), label: `Cell ${i}`, emoji: "🟦", rarity: i === 0 ? "rare" : "common", weight: 1, stock: null, sort_order: i, delivery: "manual", boostable: true }));
      await rpc("save_game_wheel", [quote(id), quote(creator), json([...cells, { id: line, label: "Line", emoji: "🏆", rarity: "rare", weight: 0, stock: null, sort_order: 10, delivery: "manual", boostable: true }]), json({ game_kind: "bingo", game_config: { size: 3, linePrizeId: line }, title }), quote(creator)]);
      await sql(`update public.wheels set is_active=${spec.active ? "true" : "false"},active_from=${ts(spec.from)},active_until=${ts(spec.until)},archived_at=${spec.archived ? "now()" : "null"} where id=${quote(id)};`);
      return;
    }
    await sql(`insert into public.wheels(id,creator_id,title,show_stock,is_active,active_from,active_until,archived_at,created_at,game_kind,game_config) values(${quote(id)},${quote(creator)},${quote(title)},false,${spec.active ? "true" : "false"},${ts(spec.from)},${ts(spec.until)},${spec.archived ? "now()" : "null"},now()-interval '${spec.age ?? 60} minutes',${quote(spec.k)},${spec.k === "scratch" ? `'{"style":"classic"}'` : "'{}'"}::jsonb);
      insert into public.prizes(wheel_id,label,weight,emoji,sort_order) values(${quote(id)},'Common',1,'🟦',0),(${quote(id)},'Other',1,'🟥',1);`);
  };
  const grantFan = async (creator, wheel, campaign, spins = 3) => {
    const out = await rpc("create_pass_grant", [quote(randomUUID()), quote(creator), "null", wheel ? quote(wheel) : "null", "'Fan'", String(spins), "0", "0", campaign ? quote(campaign) : "null"]);
    if (out.status !== "granted") return { status: out.status, error: out.error ?? null };
    await sql(`update public.fans set acked_at=now(),acked_terms_version=${quote(TERMS)} where id=${quote(out.fanId)};`);
    return { ...out, fan: out.fanId, pass: out.passId };
  };
  const prep = async (who, id = randomUUID()) => { const binding = hash(id); return { id, binding, ...(await rpc("prepare_spin_attempt", [quote(id), quote(who.token), quote(binding)])) }; };
  const cancel = (who, a) => rpc("cancel_spin_attempt", [quote(a.id), quote(who.token), quote(a.binding)]);
  const status = (who, a) => rpc("get_spin_attempt_status", [quote(a.id), quote(who.token), quote(a.binding)]);
  // Plain wheel play with no focus/chase promise: SQL validates economics and the
  // hashed pool, the pure RNG order is the service's job (0059 boundary).
  const wheelBody = (a, prizeId, excluded = []) => {
    const c = a.context, inPool = p => p.stock == null || p.stock > 0;
    const snapshot = { v: 3, rules: "focus-v1", game: "wheel", prizes: c.prizes.filter(inPool).map(p => ({ id: p.id, label: p.label, emoji: p.emoji, rarity: p.rarity, w: Math.round(p.weight), baseW: p.weight })).sort((x, y) => x.id.localeCompare(y.id)),
      modifiers: { happyHour: { multiplier: c.happyHourMultiplier ?? 1 }, pity: { counter: c.pityCounter, threshold: 10 }, focus: null, chase: null } };
    const p = c.prizes.find(x => x.id === prizeId), seed = randomUUID().replaceAll("-", "").repeat(2);
    return { ctx: { contextHash: c.contextHash }, spin: { id: a.id, fan_id: c.fanId, fan_pass_id: c.passId, creator_id: c.creatorId, wheel_id: c.wheelId, campaign_id: c.campaignId, prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url, server_seed: c.serverSeed, server_seed_hash: c.serverSeedHash, nonce: c.nonce, client_seed: "interplay", fair_version: 3, pool_snapshot: snapshot, pool_hash: hash(canonical(snapshot)), fair_trace: { excluded, won: p.id }, next_pity_counter: c.pityCounter + 1, focus_consumed: false, chase_consumed: false, chase_completed: false, next_focus_spins_left: null, next_chase_counter: null, response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, response_prize_index: c.prizes.findIndex(x => x.id === p.id), response_show_stock: c.wheel.show_stock }, expected: { delivery: "manual" }, next: { seed, hash: hash(seed) } };
  };
  const commit = (who, a, b) => rpc("commit_spin_attempt", [quote(a.id), quote(who.token), quote(a.binding), json(b.ctx), json(b.spin), json(b.expected), json(b.next)]);
  const prizeId = (wheel, label) => scalar(`select id from public.prizes where wheel_id=${quote(wheel)} and label=${quote(label)};`);
  const stockOf = async prize => { const v = await scalar(`select coalesce(stock::text,'null') from public.prizes where id=${quote(prize)};`); return v === "null" ? null : Number(v); };
  const invariants = async (creator, label) => {
    const v = JSON.parse(await scalar(`select jsonb_build_object(
      'fanMismatch',(select count(*) from public.fans f where f.creator_id=${quote(creator)} and (f.spins_remaining<>coalesce((select sum(p.spins_remaining) from public.fan_passes p where p.fan_id=f.id and p.is_active),0) or f.spins_granted_total<>coalesce((select sum(p.spins_granted_total) from public.fan_passes p where p.fan_id=f.id and p.is_active),0))),
      'negativeStock',(select count(*) from public.prizes pr join public.wheels w on w.id=pr.wheel_id where w.creator_id=${quote(creator)} and pr.stock<0),
      'negativeBalance',(select count(*) from public.fan_passes where creator_id=${quote(creator)} and spins_remaining<0),
      'spins',(select count(*) from public.spins where creator_id=${quote(creator)}),
      'redemptions',(select count(*) from public.redemptions where creator_id=${quote(creator)}),
      'pending',(select count(*) from public.spin_attempts where creator_id=${quote(creator)} and state='pending'),
      'nonceDup',(select count(*) from (select fan_pass_id,nonce from public.spins where creator_id=${quote(creator)} group by 1,2 having count(*)>1) d),
      'crossWheel',(select count(*) from public.spins s join public.prizes pr on pr.id=s.prize_id where s.creator_id=${quote(creator)} and pr.wheel_id<>s.wheel_id),
      'debitVsSpins',(select coalesce(sum(p.spins_granted_total-p.spins_remaining),0)-(select count(*) from public.spins s where s.creator_id=${quote(creator)}) from public.fan_passes p where p.creator_id=${quote(creator)}));`));
    check(v.fanMismatch === 0, `${label}: fans aggregate equals the sum of its passes`);
    check(v.negativeStock === 0 && v.negativeBalance === 0, `${label}: no negative stock or balance`);
    check(v.spins === v.redemptions, `${label}: one redemption per committed spin (${v.spins}/${v.redemptions})`);
    check(v.nonceDup === 0 && v.crossWheel === 0, `${label}: unique nonces and every prize belongs to the wheel played`);
    check(v.debitVsSpins === 0, `${label}: every debited credit is one committed spin (${v.debitVsSpins})`);
    check(v.pending === 0, `${label}: no spin attempt left pending`);
    return v;
  };

  // Scratch proofs come from the real pure engine through the stdin bridge.
  const root = join(import.meta.dirname, "../.."), fixture = spawn("npx", ["tsx", "scripts/db/scratchProofFixture.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const waiters = []; let fixtureError = ""; fixture.stderr.on("data", b => fixtureError += b);
  fixture.on("error", e => { for (const w of waiters.splice(0)) w.reject(e); });
  fixture.on("exit", code => { for (const w of waiters.splice(0)) w.reject(Error(`Scratch fixture exited ${code}: ${fixtureError}`)); });
  createInterface({ input: fixture.stdout }).on("line", line => { const w = waiters.shift(); if (!w) return; try { const v = JSON.parse(line); if (!v.ok) throw Error(v.error); w.resolve(v.value); } catch (e) { w.reject(e); } });
  const generate = (context, excluded = []) => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); fixture.stdin.write(JSON.stringify({ context, excluded }) + "\n"); });
  const scratchBody = async a => {
    const g = await generate(a.context), d = g.primary, p = a.context.prizes.find(x => x.id === d.prize.id), n = randomUUID().replaceAll("-", "").repeat(2);
    return { ctx: { contextHash: a.context.contextHash }, spin: { id: a.id, fan_id: a.context.fanId, fan_pass_id: a.context.passId, creator_id: a.context.creatorId, wheel_id: a.context.wheelId, campaign_id: a.context.campaignId, server_seed: a.context.serverSeed, server_seed_hash: a.context.serverSeedHash, nonce: a.context.nonce, client_seed: "scratch-pg-fixture", fair_version: 3, game_kind: "scratch", presentation: g.presentation, pool_snapshot: g.snapshot, pool_hash: g.poolHash, fair_trace: g.trace, prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url, next_pity_counter: d.nextPityCounter, focus_consumed: false, chase_consumed: false, chase_completed: false, next_focus_spins_left: null, next_chase_counter: null, response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, response_prize_index: a.context.prizes.findIndex(x => x.id === p.id), response_show_stock: a.context.wheel.show_stock }, expected: { delivery: p.delivery }, next: { seed: n, hash: hash(n) } };
  };

  try {
    // ------------------------------------------------------------ 1. matrix
    check((await scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('_resolved_spin_wheel','_create_pass_grant_core','_spin_attempt_context','_creator_default_wheel');`)) === "4", "all three SQL resolution paths and the shared ranking exist");
    check((await scalar(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('_resolved_spin_wheel','_create_pass_grant_core') and pg_get_functiondef(p.oid) like '%_creator_default_wheel(%';`)) === "2", "issuance and spin time both call the one shared ranking (cannot drift)");
    const recorded = [];
    for (const [index, c] of CASES.entries()) {
      const n = index + 1, creator = await addCreator(uid(n, "10")), ids = {}, letters = {};
      for (const [letter, spec] of Object.entries(c.wheels)) { ids[letter] = uid(n, letter.toLowerCase()); letters[ids[letter]] = letter; await addWheel(ids[letter], creator, spec); }
      let campaign = null, other = null;
      if (c.pin) {
        campaign = uid(n, "e");
        let pinned = ids[c.pin];
        if (c.pin === "cross") { other = await addCreator(uid(n, "11")); pinned = uid(n, "f"); letters[pinned] = "X"; await addWheel(pinned, other, { k: "wheel", active: true }, "X"); }
        await sql(`insert into public.campaigns(id,creator_id,name,pinned_wheel_id) values(${quote(campaign)},${quote(creator)},${quote(c.id)},${quote(pinned)});`);
      }
      const issued = await grantFan(creator, c.issue === "auto" ? null : ids[c.issue], campaign);
      check(issued.status === "granted", `${c.id}: issuance grants a link (${issued.status}/${issued.error})`);
      for (const step of c.after ?? []) {
        if (step.archive) await sql(`update public.wheels set archived_at=now() where id=${quote(ids[step.archive])};`);
        if (step.schedule) await sql(`update public.wheels set active_from=now()+interval '${step.from} hours' where id=${quote(ids[step.schedule])};`);
        if (step.feature) await sql(`update public.profiles set features=features||${json({ [step.feature]: step.enabled })} where id=${quote(creator)};`);
      }
      const r = JSON.parse(await scalar(`select jsonb_build_object('now',now(),'spin',public._resolved_spin_wheel(${quote(issued.pass)}),'context',public._spin_attempt_context(${quote(issued.pass)})->>'wheelId',
        'pass',(select jsonb_build_object('creator_id',creator_id,'campaign_id',campaign_id,'wheel_id',wheel_id) from public.fan_passes where id=${quote(issued.pass)}),
        'wheels',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'creator_id',creator_id,'is_active',is_active,'active_from',active_from,'active_until',active_until,'archived_at',archived_at,'created_at',created_at,'game_kind',game_kind,'game_ready',game_ready) order by id),'[]'::jsonb) from public.wheels where creator_id in(${quote(creator)},${quote(other ?? creator)})),
        'campaigns',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'creator_id',creator_id,'pinned_wheel_id',pinned_wheel_id)),'[]'::jsonb) from public.campaigns where creator_id=${quote(creator)}),
        'features',(select features from public.profiles where id=${quote(creator)}));`));
      const result = { issuance: letters[r.pass.wheel_id] ?? null, context: r.context ? letters[r.context] ?? "?" : null, spin: r.spin ? letters[r.spin] ?? "?" : null };
      check(result.spin === c.expected.spin, `${c.id}: spin-time resolves ${c.expected.spin} (got ${result.spin})`);
      check(result.issuance === c.expected.issuance, `${c.id}: issuance picks ${c.expected.issuance} (got ${result.issuance})`);
      check(result.context === result.spin, `${c.id}: prepare context agrees with spin-time (${result.context}/${result.spin})`);
      const a = await prep(issued);
      if (result.spin === null) check(a.status === "declined" && a.error === "no_wheel", `${c.id}: fan gets a clean no_wheel decline, not a SQL error`);
      else {
        check(a.status === "ready" && a.context.wheelId === r.spin && a.context.wheel.game_kind === c.wheels[result.spin].k, `${c.id}: prepare serves the resolved game with its real kind`);
        check((await cancel(issued, a)).status === "declined" && (await status(issued, a)).status === "declined", `${c.id}: unused attempt does not stay pending`);
      }
      if (c.expected.surprise) surprises.add(c.expected.surprise);
      // A disagreement is a bug only when both paths saw the same state: an
      // explicit p_wheel or a post-issuance mutation is a documented surprise.
      const mutated = (c.after ?? []).some(s => s.archive || s.schedule) || c.issue !== "auto";
      if (result.issuance !== result.spin && !mutated) {
        if (c.expected.bug) known(c.expected.bug, `${c.id}: link minted for ${result.issuance}, fan plays ${result.spin}`);
        else throw Error(`interplay ${c.id}: undocumented issuance/spin disagreement ${result.issuance}/${result.spin}`);
      } else check(!c.expected.bug || mutated, `${c.id}: documented bug still reproduces`);
      recorded.push({ id: c.id, now: r.now, creatorId: creator, wheels: r.wheels, campaigns: r.campaigns, pass: r.pass, features: r.features, letters, result, expected: c.expected });
    }
    check(await refused(`insert into public.wheels(creator_id,game_ready) values(${quote(creators[0])},false);`, /invalid_game_config/), "game_ready=false is not constructible for wheel/scratch in 0060 (not-ready pins cannot exist)");
    const summary = cases => JSON.stringify(cases.map(x => [x.id, x.result.issuance, x.result.context, x.result.spin]));
    if (writeFixture) writeFileSync(FIXTURE, JSON.stringify({ generatedBy: "scripts/db/interplayProbe.mjs", bugs: BUGS, surprises: SURPRISES, cases: recorded }, null, 1) + "\n");
    else {
      check(existsSync(FIXTURE), "committed resolution fixture exists (INTERPLAY_WRITE_FIXTURE=1 regenerates it)");
      check(summary(JSON.parse(readFileSync(FIXTURE, "utf8")).cases) === summary(recorded), "SQL resolution matches the committed fixture the TS mirror test replays (regenerate with INTERPLAY_WRITE_FIXTURE=1)");
    }
    for (const id of creators) await invariants(id, "matrix");

    // ------------------------------------------------- 2. switching mid-session
    const sw = await addCreator(uid(1000, "10")), A = uid(1000, "a"), B = uid(1000, "b"), camp = uid(1000, "e");
    await addWheel(A, sw, { k: "wheel", active: true, age: 90 }, "A"); await addWheel(B, sw, { k: "wheel", age: 10 }, "B");
    await sql(`update public.prizes set stock=3,label='Limited' where wheel_id=${quote(A)} and label='Common';update public.prizes set stock=2,label='Limited' where wheel_id=${quote(B)} and label='Common';insert into public.campaigns(id,creator_id,name) values(${quote(camp)},${quote(sw)},'switch');`);
    const LA = await prizeId(A, "Limited"), LB = await prizeId(B, "Limited"), OA = await prizeId(A, "Other");
    const fan = await grantFan(sw, A, camp, 10);
    check(fan.status === "granted", "switching fixture fan is credited on A");
    let a1 = await prep(fan);
    check(a1.status === "ready" && a1.context.wheelId === A, "fan loads on A");
    await sql(`update public.wheels set active_from=now()-interval '1 hour' where id=${quote(B)};`);
    let r1 = await commit(fan, a1, wheelBody(a1, LA));
    check(r1.status === "retry_context", "a spin prepared on A is refused (retry_context) once B's schedule opened, not played on either game");
    check(await stockOf(LA) === 3 && await stockOf(LB) === 2, "no stock moved on the refused spin");
    a1 = await prep(fan, a1.id);
    check(a1.status === "ready" && a1.context.wheelId === B, "re-preparing the same attempt follows the schedule to B");
    r1 = await commit(fan, a1, wheelBody(a1, LB));
    check(r1.status === "committed" && r1.spin.wheel_id === B && r1.spin.prize_id === LB, "spin lands on B with B's prize");
    check(await stockOf(LB) === 1 && await stockOf(LA) === 3, "only B's stock is decremented");
    const OB = await prizeId(B, "Other");
    check(r1.spin.pool_hash === hash(canonical(r1.spin.pool_snapshot)) && r1.spin.pool_snapshot.prizes.every(p => [LB, OB].includes(p.id)), "proof pool refers to the game actually played");
    await sql(`update public.campaigns set pinned_wheel_id=${quote(A)} where id=${quote(camp)};`);
    let a2 = await prep(fan);
    check(a2.context.wheelId === A, "pinning the campaign to A beats B's open schedule");
    // Creator edits A's prizes/stock while the fan holds a context on A.
    await rpc("save_wheel_prizes", [quote(A), quote(sw), json([{ id: LA, label: "Limited", rarity: "common", weight: 1, stock: 5, emoji: "🟦" }, { id: OA, label: "Other", rarity: "common", weight: 1, emoji: "🟥" }])]);
    let r2 = await commit(fan, a2, wheelBody(a2, LA));
    check(r2.status === "committed" && r2.spin.wheel_id === A && await stockOf(LA) === 4, "a stock-only edit keeps the context valid and the spin debits the NEW stock on A (5->4)");
    await rpc("save_wheel_prizes", [quote(A), quote(sw), json([{ id: LA, label: "Limited!", rarity: "common", weight: 2, stock: 4, emoji: "🟦" }, { id: OA, label: "Other", rarity: "common", weight: 1, emoji: "🟥" }])]);
    a2 = await prep(fan);
    const stale = structuredClone(a2); stale.context.prizes.find(p => p.id === LA).label = "Limited";
    check(await refused(`select public.commit_spin_attempt(${[quote(a2.id), quote(fan.token), quote(a2.binding), json({ contextHash: a2.context.contextHash }), json(wheelBody(stale, LA).spin), json({ delivery: "manual" }), json(wheelBody(a2, LA).next)].join(",")});`, /pool base mismatch|selected prize mismatch/), "a label/weight edit invalidates a stale pool proof before any debit");
    check(await stockOf(LA) === 4, "refused proof moved no stock");
    r2 = await commit(fan, a2, wheelBody(a2, LA));
    check(r2.status === "committed" && r2.spin.prize_label === "Limited!" && await stockOf(LA) === 3, "fresh context plays the edited prize");
    const a3 = await prep(fan);
    check(a3.context.wheelId === A, "fan holds a context on pinned A");
    await sql(`update public.wheels set archived_at=now() where id=${quote(A)};`);
    const r3 = await commit(fan, a3, wheelBody(a3, LA));
    check(r3.status === "retry_context" && await stockOf(LA) === 3, "archiving A under a prepared attempt refuses the spin without touching A's stock");
    const a4 = await prep(fan);
    check(a4.status === "ready" && a4.context.wheelId === B, "after archiving pinned A the link falls back to scheduled B");
    const r4 = await commit(fan, a4, wheelBody(a4, LB));
    check(r4.status === "committed" && r4.spin.wheel_id === B && await stockOf(LB) === 0, "the spin after the switch lands on B and takes B's last unit");
    check((await cancel(fan, a3)).status === "declined", "the stale attempt is cancelled cleanly");
    check((await scalar(`select string_agg(s.wheel_id::text||':'||pr.wheel_id::text||':'||(s.pool_hash=encode(digest(public._canonical_proof_json(s.pool_snapshot),'sha256'),'hex'))::text,',' order by s.nonce) from public.spins s join public.prizes pr on pr.id=s.prize_id where s.fan_id=${quote(fan.fan)};`)).split(",").every(x => { const [w, pw, ok] = x.split(":"); return w === pw && ok === "true"; }), "every stored spin's prize, wheel and proof hash refer to the game actually played");
    check((await scalar(`select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${quote(fan.pass)};`)) === "6,4", "four credited plays for four commits, none for the refused attempts");
    surprises.add("S1"); surprises.add("S2");
    await invariants(sw, "switching");

    // ---------------------------------------------------------- 3. concurrency
    const cc = await addCreator(uid(2000, "10")), CW = uid(2000, "a");
    await addWheel(CW, cc, { k: "wheel", active: true }, "C");
    await sql(`update public.prizes set stock=3,label='Limited' where wheel_id=${quote(CW)} and label='Common';`);
    const CL = await prizeId(CW, "Limited"), CO = await prizeId(CW, "Other");
    // 3a. One fan, balance 5, twenty parallel attempts, repeated until settled.
    const solo = await grantFan(cc, CW, null, 5);
    let attempts = []; for (let i = 0; i < 20; i++) attempts.push(await prep(solo));
    const tally = { committed: 0, retry_context: 0, declined: 0, other: 0, errors: [] };
    for (let round = 0; round < 12 && attempts.length; round++) {
      const replies = await settled(attempts.map(a => a.status === "ready" ? commit(solo, a, wheelBody(a, CO)) : Promise.resolve(a)));
      const next = [];
      for (const [i, reply] of replies.entries()) {
        if (!reply.ok) { tally.errors.push(reply.error); continue; }
        const s = reply.value.status;
        if (s === "committed") tally.committed++;
        else if (s === "retry_context") { tally.retry_context++; next.push(await prep(solo, attempts[i].id)); }
        else if (s === "declined") tally.declined++;
        else tally.other++;
      }
      attempts = next.map(a => ({ ...a, binding: hash(a.id) }));
    }
    check(tally.errors.length === 0, `same-fan parallel commits never raise (${tally.errors[0]})`);
    check(tally.committed === 5 && tally.declined === 15 && tally.other === 0, `twenty parallel attempts on a balance of 5 commit exactly 5 (${JSON.stringify(tally)})`);
    check((await scalar(`select spins_remaining||','||spins_granted_total||','||next_spin_nonce||','||(select count(*) from public.spins where fan_pass_id=${quote(solo.pass)}) from public.fan_passes where id=${quote(solo.pass)};`)) === "0,5,5,5", "credits are conserved: 5 granted, 5 spent, 5 spins, nonce 5");
    // 3b. Twelve fans race for three units.
    const fans = []; for (let i = 0; i < 12; i++) { const who = await grantFan(cc, CW, null, 2); fans.push({ who, a: await prep(who) }); }
    const race = await settled(fans.map(f => commit(f.who, f.a, wheelBody(f.a, CL))));
    check(race.every(x => x.ok), `many-fan race never raises (${race.find(x => !x.ok)?.error})`);
    const won = race.filter(x => x.value.status === "committed").length, soldOut = race.filter(x => x.value.status === "sold_out").length;
    check(won === 3 && soldOut === 9 && await stockOf(CL) === 0, `twelve fans on stock 3 award exactly three (${won} won, ${soldOut} sold_out)`);
    const redraws = await settled(fans.filter((_, i) => race[i].value.status === "sold_out").map(f => commit(f.who, f.a, wheelBody(f.a, CO, [CL]))));
    check(redraws.every(x => x.ok && x.value.status === "committed"), "sold-out fans redraw on the fallback prize with the limited prize excluded from the trace");
    check((await scalar(`select count(distinct fan_pass_id)||','||count(*) from public.spins where prize_id=${quote(CL)};`)) === "3,3", "no unit is awarded twice");
    // 3c. Creator saves prizes while spins run (A2): stale stock overwrite.
    const SW = uid(2000, "b"); await addWheel(SW, cc, { k: "wheel", active: false }, "S");
    await sql(`update public.wheels set is_active=false where id=${quote(CW)};update public.wheels set is_active=true where id=${quote(SW)};update public.prizes set stock=3,label='Limited' where wheel_id=${quote(SW)} and label='Common';`);
    const SL = await prizeId(SW, "Limited"), SO = await prizeId(SW, "Other");
    // The editor sends the stock it loaded (expected_stock); SQL applies the edit as a delta over the live value.
    const saveRows = (stock, expected) => json([{ id: SL, label: "Limited", rarity: "common", weight: 1, stock, emoji: "🟦", ...(expected === undefined ? {} : { expected_stock: expected }) }, { id: SO, label: "Other", rarity: "common", weight: 1, emoji: "🟥", expected_stock: null }]);
    const racers = []; for (let i = 0; i < 12; i++) { const who = await grantFan(cc, SW, null, 2); racers.push({ who, a: await prep(who) }); }
    const mixed = await settled([...racers.map(f => commit(f.who, f.a, wheelBody(f.a, SL))), ...Array.from({ length: 5 }, () => rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(3, 3)]))]);
    check(mixed.every(x => x.ok), `prize saves interleaved with spins never raise (${mixed.find(x => !x.ok)?.error})`);
    const awardedRace = Number(await scalar(`select count(*) from public.spins where prize_id=${quote(SL)};`));
    check(await stockOf(SL) >= 0, "stock never goes negative under concurrent saves");
    const leftovers = await settled(racers.filter((_, i) => mixed[i].value.status !== "committed").map(async f => { const a = await prep(f.who, f.a.id); return commit(f.who, a, wheelBody(a, SO, [SL])); }));
    check(leftovers.every(x => x.ok && x.value.status === "committed"), `fans refused during the saves settle on the fallback prize (${leftovers.find(x => !x.ok || x.value.status !== "committed")?.error ?? JSON.stringify(leftovers.find(x => x.value?.status !== "committed")?.value)})`);
    // Deterministic form of the same race: spin, stale save, spin, stale save.
    await rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(2, await stockOf(SL))]);
    check(await stockOf(SL) === 2, "a fresh edit over the stock the creator just loaded sets it exactly");
    const seq = []; for (let i = 0; i < 3; i++) seq.push(await grantFan(cc, SW, null, 1));
    let awardedSeq = 0;
    // Each fan takes a unit while one is left (the service excludes a sold-out prize from the pool), then the creator re-saves the stale loaded value.
    for (const who of seq) { const a = await prep(who); const left = await stockOf(SL); if ((await commit(who, a, left > 0 ? wheelBody(a, SL) : wheelBody(a, SO, [SL]))).status === "committed" && left > 0) awardedSeq++; await rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(2, 2)]); }
    check(awardedSeq === 2 && awardedRace <= 3, `limited stock is never exceeded by a stale creator save (${awardedSeq} from 2 sequential, ${awardedRace} from 3 parallel)`);
    check(await stockOf(SL) === 0, "the stale re-saves of the loaded value left the spent stock alone (0, not 2)");
    // Compare-and-set semantics: a stock edit over moved stock is the creator's delta; an unseen limited/unlimited switch is a conflict.
    await rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(5, 0)]);
    check(await stockOf(SL) === 5, "restocking from the loaded 0 to 5 lands 5");
    await sql(`update public.prizes set stock=stock-1 where id=${quote(SL)};`);
    await rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(7, 5)]);
    check(await stockOf(SL) === 6, "an edit of +2 over stock that moved 5->4 meanwhile lands 6, never the stale 7");
    check(await refused(`select public.save_wheel_prizes(${quote(SW)},${quote(cc)},${saveRows(3, null)});`, /stock_changed/), "a limit set over stock the creator saw as unlimited is a clean stock_changed conflict");
    check(await stockOf(SL) === 6, "the refused save changed nothing");
    await rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(null, 6)]);
    check(await stockOf(SL) === null, "making a prize unlimited is honoured whatever the live count");
    await rpc("save_wheel_prizes", [quote(SW), quote(cc), saveRows(4)]);
    check(await stockOf(SL) === 4, "a save without expected_stock (no loaded value) still sets the stock");
    // 3d. A top-up lands while spins run.
    const topped = await grantFan(cc, SW, null, 2);
    let open = []; for (let i = 0; i < 6; i++) open.push(await prep(topped));
    let committed = 0; const grantP = rpc("grant_pass_spins", [quote(randomUUID()), quote(cc), quote(topped.fan), quote(topped.pass), "4", "0", "0", "null"]);
    for (let round = 0; round < 12 && committed < 6; round++) {
      const replies = await settled(open.map(a => a.status === "ready" ? commit(topped, a, wheelBody(a, SO)) : Promise.resolve({ status: "declined" })));
      check(replies.every(x => x.ok), `top-up race never raises (${replies.find(x => !x.ok)?.error})`);
      const next = [];
      for (const [i, r] of replies.entries()) { if (r.value.status === "committed") committed++; else if (r.value.status === "retry_context") next.push(await prep(topped, open[i].id)); else next.push(await prep(topped)); }
      open = next.map(a => ({ ...a, binding: hash(a.id) }));
      if (round === 0) check((await grantP).status === "granted", "top-up grant lands during the spins");
    }
    check(committed === 6 && (await scalar(`select spins_remaining||','||spins_granted_total from public.fan_passes where id=${quote(topped.pass)};`)) === "0,6", "2 + 4 topped-up credits yield exactly 6 commits and a zero balance");
    for (const a of open) await cancel(topped, a);
    await invariants(cc, "concurrency");

    // --------------------------------------------------------- 4. cross-tenant
    const ta = await addCreator(uid(3000, "10")), tb = await addCreator(uid(3000, "11")), WA = uid(3000, "a"), WB = uid(3000, "b"), CA = uid(3000, "e"), CB = uid(3000, "f");
    await addWheel(WA, ta, { k: "wheel", active: true }, "A"); await addWheel(WB, tb, { k: "wheel", active: true }, "B");
    await sql(`insert into public.campaigns(id,creator_id,name) values(${quote(CA)},${quote(ta)},'A'),(${quote(CB)},${quote(tb)},'B');
      grant select,insert,update,delete on public.wheels,public.prizes,public.campaigns,public.fan_passes,public.fans,public.happy_hours to authenticated;`);
    const fanA = await grantFan(ta, WA, CA, 2), fanB = await grantFan(tb, WB, CB, 2);
    check(await asUser(tb, `select count(*) from public.wheels where creator_id=${quote(ta)}`) === "0", "B cannot read A's games");
    check(await asUser(tb, `select count(*) from public.fan_passes where creator_id=${quote(ta)}`) === "0", "B cannot read A's fan links");
    check(await asUser(tb, `with u as(update public.wheels set active_from=now()-interval '1 hour' where id=${quote(WA)} returning 1) select count(*) from u`) === "0", "B cannot schedule A's game");
    check(await asUser(tb, `with u as(update public.wheels set archived_at=now() where id=${quote(WA)} returning 1) select count(*) from u`) === "0", "B cannot archive A's game");
    check(await asUser(tb, `with u as(update public.wheels set is_active=true where id=${quote(WA)} returning 1) select count(*) from u`) === "0", "B cannot flip A's active flag");
    check(await asUser(tb, `with u as(update public.campaigns set pinned_wheel_id=${quote(WB)} where id=${quote(CA)} returning 1) select count(*) from u`) === "0", "B cannot pin A's campaign");
    check(await refused(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(tb)},true);insert into public.prizes(wheel_id,label) values(${quote(WA)},'forged');commit;`, /row-level security|permission denied/), "B cannot add a prize to A's game");
    // A happy hour may only boost its own creator's game: RLS with-check for sessions, a BEFORE trigger for every role, and a creator filter at play time.
    check(await refused(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(tb)},true);insert into public.happy_hours(creator_id,wheel_id,multiplier,starts_at,ends_at) values(${quote(tb)},${quote(WA)},5,now(),now()+interval '1 hour');commit;`, /row-level security|another creator/), "B cannot attach a happy hour to A's game through RLS");
    check(await refused(`insert into public.happy_hours(creator_id,wheel_id,multiplier,starts_at,ends_at) values(${quote(tb)},${quote(WA)},5,now(),now()+interval '1 hour');`, /another creator/), "not even the service role can attach a happy hour to another creator's game (trigger)");
    check(await asUser(tb, `with i as(insert into public.happy_hours(creator_id,wheel_id,multiplier,starts_at,ends_at) values(${quote(tb)},${quote(WB)},5,now(),now()+interval '1 hour') returning 1) select count(*) from i`) === "1", "B still schedules a happy hour on B's own game");
    await sql(`alter table public.happy_hours disable trigger aa_happy_hour_tenant;insert into public.happy_hours(creator_id,wheel_id,multiplier,starts_at,ends_at) values(${quote(tb)},${quote(WA)},5,now(),now()+interval '1 hour');alter table public.happy_hours enable trigger aa_happy_hour_tenant;`);
    check(await scalar(`select public._spin_attempt_context(${quote(fanA.pass)})->>'happyHourMultiplier';`) === "1" && await scalar(`select public._spin_attempt_context(${quote(fanB.pass)})->>'happyHourMultiplier';`) === "5", "a cross-tenant happy hour row that predates the guard never boosts A's game while B's own boosts B");
    await sql(`delete from public.happy_hours where wheel_id in(${quote(WA)},${quote(WB)});`);
    check(await refused(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(tb)},true);select public.prepare_spin_attempt(gen_random_uuid(),${quote(fanA.token)},repeat('a',64));commit;`, /permission denied/), "browser roles cannot reach the spin RPC at all");
    check(await refused(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(tb)},true);select public._resolved_spin_wheel(${quote(fanA.pass)});commit;`, /permission denied/), "the resolver is private to the atomic boundary");
    check((await rpc("create_pass_grant", [quote(randomUUID()), quote(ta), "null", "null", "'x'", "1", "0", "0", "null", "null", "null", "1", quote(tb)])).status === "unavailable", "B acting as actor cannot mint A's links through the service RPC");
    check((await rpc("grant_pass_spins", [quote(randomUUID()), quote(tb), quote(fanA.fan), quote(fanA.pass), "1", "0", "0", "null"])).status === "unavailable", "B cannot top up A's fan");
    check(await refused(`update public.fan_passes set campaign_id=${quote(CB)} where id=${quote(fanA.pass)};`, /another creator/), "even the service cannot attach A's link to B's campaign");
    // RLS lets B point B's own campaign at A's wheel id (FK only); resolution ignores it.
    check(await asUser(tb, `with u as(update public.campaigns set pinned_wheel_id=${quote(WA)} where id=${quote(CB)} returning 1) select count(*) from u`) === "1", "no DB guard on a cross-tenant pin id (S4)");
    check(await scalar(`select public._resolved_spin_wheel(${quote(fanB.pass)});`) === WB && await scalar(`select public._resolved_spin_wheel(${quote(fanA.pass)});`) === WA, "a cross-tenant pin is ignored: B's fans stay on B, A's on A");
    const pa = await prep(fanA); check(pa.status === "ready" && pa.context.wheelId === WA && (await commit(fanA, pa, wheelBody(pa, await prizeId(WA, "Other")))).status === "committed", "A's fan spins A's game untouched by B's attempts");
    surprises.add("S4");
    await invariants(ta, "cross-tenant A"); await invariants(tb, "cross-tenant B");

    // ---------------------------------------------- 5. feature-flag interplay
    const fc = await addCreator(uid(4000, "10")), FW = uid(4000, "a"), FS = uid(4000, "b"), FC = uid(4000, "e");
    await addWheel(FW, fc, { k: "wheel", active: true }, "W"); await addWheel(FS, fc, { k: "scratch" }, "S");
    await sql(`insert into public.campaigns(id,creator_id,name,pinned_wheel_id) values(${quote(FC)},${quote(fc)},'flag',${quote(FS)});`);
    const flagFan = await grantFan(fc, null, FC, 3);
    check(flagFan.status === "granted" && (await scalar(`select wheel_id from public.fan_passes where id=${quote(flagFan.pass)};`)) === FS, "link minted on the pinned scratch game while the flag is on");
    await sql(`update public.profiles set features=features||'{"scratch":false}'::jsonb where id=${quote(fc)};`);
    const ensure = await rpc("ensure_pass_commitment", [quote(flagFan.token)]);
    check(typeof ensure?.hash === "string", "fan page commitment read is clean with the flag off");
    const fa = await prep(flagFan);
    check(fa.status === "ready" && fa.context.wheelId === FS && fa.context.wheel.game_kind === "scratch", "pinned scratch stays the served game with the flag off (S6: grandfathered, no fallback)");
    const fr = await commit(flagFan, fa, await scratchBody(fa));
    check(fr.status === "committed" && fr.gameKind === "scratch" && fr.presentation?.cells?.length === 9, "the scratch play commits cleanly with the flag off");
    check(await refused(`insert into public.wheels(creator_id,game_kind,game_config) values(${quote(fc)},'scratch','{"style":"classic"}');`, /feature_disabled/), "a NEW scratch game is cleanly refused with the flag off");
    await sql(`update public.campaigns set pinned_wheel_id=null where id=${quote(FC)};update public.wheels set active_from=now()-interval '1 hour' where id=${quote(FS)};`);
    const fb = await prep(flagFan);
    check(fb.status === "ready" && fb.context.wheelId === FS, "a scheduled scratch game is still served with the flag off");
    await sql(`update public.wheels set active_from=null,is_active=true where id=${quote(FS)};update public.wheels set is_active=false where id=${quote(FW)};`);
    const fb2 = await prep(flagFan, fb.id);
    check(fb2.status === "ready" && fb2.context.wheelId === FS, "an active scratch game is still served with the flag off");
    check(await refused(`update public.wheels set game_kind='wheel',game_config='{}' where id=${quote(FS)};`, /game_kind_locked/), "a played scratch game cannot be converted to a wheel to dodge the flag");
    await sql(`update public.wheels set archived_at=now() where id=${quote(FS)};`);
    const fb3 = await prep(flagFan, fb.id);
    check(fb3.status === "ready" && fb3.context.wheelId === FW && fb3.context.wheel.game_kind === "wheel", "archiving the scratch game is the creator's clean way to fall back to the wheel");
    check((await cancel(flagFan, fb3)).status === "declined", "the unused flag-probe attempt is cancelled");
    surprises.add("S6");
    await invariants(fc, "feature flag");

    const notes = [...surprises].sort().map(s => `  ${s}: ${SURPRISES[s]}`).join("\n");
    for (const bug of knownBugs) console.log(`KNOWN-BUG ${bug}`);
    const distinctBugs = new Set(knownBugs.map(b => b.split(":")[0]));
    for (const id of distinctBugs) console.log(`KNOWN-BUG ${id} = ${BUGS[id] ?? "see line above"}`);
    console.log(`Surprising-but-intended (needs clear UI):\n${notes}`);
    if (strict && knownBugs.length) throw Error(`interplay strict: ${knownBugs.length} known-bug case(s) still reproduce: ${[...distinctBugs].join(", ")}`);
    console.log(`PASS interplay ${checks} checks: ${CASES.length} resolution cases, switching, concurrency, cross-tenant, feature flag (${knownBugs.length} known-bug lines${strict ? ", strict" : ""})`);
  } finally {
    fixture.stdin.end(); await Promise.allSettled([...pending]);
    if (creators.length) await sql(`delete from auth.users where id in(${creators.map(quote).join(",")});`);
  }
}
