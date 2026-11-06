// 0070 on a disposable local PostgreSQL only (run by schema-drift-check.mjs on
// every build path). No Supabase credential is read.
//
// A play resolves its game exactly once per call (A26 stress finding
// COMMIT_RESOLVES_WHEEL_PER_STATEMENT, docs/handoff/STRESS_RESULTS.md):
//   static   prepare_spin_attempt and commit_spin_attempt each call
//            _resolved_spin_wheel once, as an assignment to v_wheel, and the
//            card lookup, wheel lock, prize lock and context use v_wheel;
//            _spin_attempt_context(uuid,uuid) never resolves.
//   runtime  with the resolver wrapped by a counting shim, one prepare runs it
//            exactly once, and one commit runs it exactly once before the spin
//            is written (its locks and context); the only later resolution is
//            the receipt's lock-free card read (_spin_attempt_receipt ->
//            get_bingo_card_state, the card of the game the link plays next);
//   race     the shim flips the campaign pin from A to B in the instant after
//            the commit's single resolution (the campaign PATCH is a plain
//            UPDATE with no fan or pass lock). Before 0070 the later statements
//            resolved B: the call held A's wheel and B's prizes (the deadlock
//            cycle) and answered retry_context; now every lock and the context
//            are A's, the play commits on A, and the next prepare serves B.
// The shim is removed again before the probe returns.
import { createHash, randomUUID } from "node:crypto";
import { withActorContext } from "./actorContextFixture.mjs";

const quote = s => `'${String(s).replaceAll("'", "''")}'`;
const json = v => `${quote(JSON.stringify(v))}::jsonb`;
const hash = s => createHash("sha256").update(s).digest("hex");
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const TERMS = "2026-10-27";

/** @param {(q: string) => Promise<string>} sql */
export async function probeSpinResolution(sql) {
  const bad = []; let checks = 0;
  const check = (ok, label) => { checks++; if (!ok) bad.push(label); };
  const scalar = async q => (await sql(q)).trim();
  const rpc = async (name, args) => withActorContext(sql, name, args, async bound => JSON.parse((await sql(`begin;set local role service_role;select public.${name}(${bound.join(",")});commit;`)).trim() || "null"));
  // The fan-side gateways tagged so the shim can attribute each resolution.
  const lastLine = out => out.trim().split("\n").filter(Boolean).at(-1) ?? "null";
  const tagged = async (tag, name, args, extra = "") => JSON.parse(lastLine(await sql(`begin;set local role service_role;select set_config('fanfunnel.probe_call',${quote(tag)},true);${extra}select public.${name}(${args.join(",")});commit;`)));

  // ---------------------------------------------------------------- static
  const src = async (sig) => scalar(`select prosrc from pg_proc where oid=${quote(sig)}::regprocedure;`);
  const count = (text, needle) => text.split(needle).length - 1;
  const commitSrc = await src("public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb)");
  const prepareSrc = await src("public.prepare_spin_attempt(uuid,text,text)");
  const contextSrc = await src("public._spin_attempt_context(uuid,uuid)");
  check(count(commitSrc, "_resolved_spin_wheel(") === 1 && /v_wheel:=public\._resolved_spin_wheel\(p\.id\);/.test(commitSrc), "commit_spin_attempt resolves the game exactly once, into v_wheel");
  check(/from public\.bingo_cards where fan_id=f\.id and wheel_id=v_wheel /.test(commitSrc) && /from public\.wheels where id=v_wheel for update;/.test(commitSrc) && /from public\.prizes where wheel_id=v_wheel or id=r\.prize_id order by id for update;/.test(commitSrc) && /_spin_attempt_context\(p\.id,v_wheel\)/.test(commitSrc), "commit_spin_attempt's card lookup, wheel lock, prize lock and context all use v_wheel");
  check(commitSrc.indexOf("v_wheel:=") > commitSrc.indexOf("from public.fans where id=a.fan_id for update") && commitSrc.indexOf("v_wheel:=") > commitSrc.indexOf("from public.fan_passes where id=a.fan_pass_id and token=p_token for update") && commitSrc.indexOf("v_wheel:=") < commitSrc.indexOf("from public.wheels where id=v_wheel for update"), "commit_spin_attempt resolves after the fan and pass locks and before the wheel lock (fan -> pass -> wheel -> prize)");
  check(count(prepareSrc, "_resolved_spin_wheel(") === 1 && /v_wheel:=public\._resolved_spin_wheel\(p\.id\);/.test(prepareSrc) && /_spin_attempt_context\(p\.id,v_wheel\)/.test(prepareSrc), "prepare_spin_attempt resolves the game exactly once and builds the context on it");
  check(count(contextSrc, "_resolved_spin_wheel(") === 0 && /where id=p_wheel;/.test(contextSrc), "_spin_attempt_context(pass, wheel) reads the caller's game and never resolves");
  // Grants as the roles see them (a PUBLIC grant would show as anon/authenticated=true).
  const grants = await scalar(`select string_agg(f||'['||(select string_agg(r||'='||has_function_privilege(r,f,'execute')::text,',' order by r) from unnest(array['anon','authenticated','service_role']) r)||']',';' order by f) from unnest(array['public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb)','public.prepare_spin_attempt(uuid,text,text)','public._spin_attempt_context(uuid)','public._spin_attempt_context(uuid,uuid)']) f;`);
  check(grants === "public._spin_attempt_context(uuid)[anon=false,authenticated=false,service_role=false];public._spin_attempt_context(uuid,uuid)[anon=false,authenticated=false,service_role=false];public.commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb)[anon=false,authenticated=false,service_role=true];public.prepare_spin_attempt(uuid,text,text)[anon=false,authenticated=false,service_role=true]", `the spin gateways stay service-role only and both _spin_attempt_context forms owner-only (${grants})`);
  const definer = (await scalar(`select string_agg(p.oid::regprocedure::text||':'||p.prosecdef::text||':'||coalesce((select string_agg(c,',') from unnest(p.proconfig) c),'-'),';' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('commit_spin_attempt','prepare_spin_attempt','_spin_attempt_context');`)).replaceAll(" ", "");
  check(definer === "_spin_attempt_context(uuid):true:search_path=public,extensions,pg_temp;_spin_attempt_context(uuid,uuid):true:search_path=public,extensions,pg_temp;commit_spin_attempt(uuid,text,text,jsonb,jsonb,jsonb,jsonb):true:search_path=public,extensions,pg_temp;prepare_spin_attempt(uuid,text,text):true:search_path=public,extensions,pg_temp", `the spin gateways and both contexts stay SECURITY DEFINER with the fixed search_path (${definer})`);

  // ---------------------------------------------------------------- fixtures
  const creator = randomUUID(), camp = randomUUID();
  await sql(`insert into auth.users(id,email) values(${quote(creator)},'resolve-${creator}@example.test');update public.profiles set is_active=true,approval_status='approved' where id=${quote(creator)};`);
  const addWheel = async (title, active) => {
    const id = randomUUID();
    await sql(`insert into public.wheels(id,creator_id,title,show_stock,is_active,created_at) values(${quote(id)},${quote(creator)},${quote(title)},false,${active},now()-interval '1 hour');
      insert into public.prizes(wheel_id,label,weight,emoji,sort_order) values(${quote(id)},'One',1,'🟦',0),(${quote(id)},'Two',1,'🟥',1);`);
    return id;
  };
  const A = await addWheel("A", true), B = await addWheel("B", false);
  await sql(`insert into public.campaigns(id,creator_id,name,pinned_wheel_id) values(${quote(camp)},${quote(creator)},'resolve',${quote(A)});`);
  const grant = await rpc("create_pass_grant", [quote(randomUUID()), quote(creator), "null", "null", "'Fan'", "3", "0", "0", quote(camp)]);
  if (grant.status !== "granted") throw Error(`spin resolution probe: grant refused (${grant.status} ${grant.error ?? ""})`);
  await sql(`update public.fans set acked_at=now(),acked_terms_version=${quote(TERMS)} where id=${quote(grant.fanId)};`);
  const prep = async (id = randomUUID(), tag = "prepare") => { const binding = hash(id); return { id, binding, ...(await tagged(tag, "prepare_spin_attempt", [quote(id), quote(grant.token), quote(binding)])) }; };
  const wheelBody = (a, prizeId) => {
    const c = a.context, p = c.prizes.find(x => x.id === prizeId), seed = hash(`next-${a.id}`);
    const snapshot = { v: 3, rules: "focus-v1", game: "wheel", prizes: c.prizes.map(x => ({ id: x.id, label: x.label, emoji: x.emoji, rarity: x.rarity, w: Math.round(x.weight), baseW: x.weight })).sort((x, y) => x.id.localeCompare(y.id)), modifiers: { happyHour: { multiplier: c.happyHourMultiplier ?? 1 }, pity: { counter: c.pityCounter, threshold: 10 }, focus: null, chase: null } };
    return { ctx: { contextHash: c.contextHash }, spin: { id: a.id, fan_id: c.fanId, fan_pass_id: c.passId, creator_id: c.creatorId, wheel_id: c.wheelId, campaign_id: c.campaignId, prize_id: p.id, prize_label: p.label, prize_rarity: p.rarity, prize_image_url: p.image_url, server_seed: c.serverSeed, server_seed_hash: c.serverSeedHash, nonce: c.nonce, client_seed: "resolve-probe", fair_version: 3, pool_snapshot: snapshot, pool_hash: hash(canonical(snapshot)), fair_trace: { excluded: [], won: p.id }, next_pity_counter: c.pityCounter + 1, focus_consumed: false, chase_consumed: false, chase_completed: false, next_focus_spins_left: null, next_chase_counter: null, response_prize: { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight }, response_prize_index: c.prizes.findIndex(x => x.id === p.id), response_show_stock: c.wheel.show_stock }, expected: { delivery: "manual" }, next: { seed, hash: hash(seed) } };
  };
  const commit = (a, b, tag, extra = "") => tagged(tag, "commit_spin_attempt", [quote(a.id), quote(grant.token), quote(a.binding), json(b.ctx), json(b.spin), json(b.expected), json(b.next)], extra);

  // ---------------------------------------------------------------- the shim
  // The real resolver is renamed and a counting wrapper takes its name; the
  // gateways look the name up at call time (each psql call is a new session).
  // With fanfunnel.probe_flip set, the wrapper also moves the campaign pin
  // to B right after it resolved, once.
  await sql(`create schema if not exists ff_resolve_probe;
    create table ff_resolve_probe.calls(call text not null, resolved uuid, spins_written integer not null, at timestamptz not null default clock_timestamp());
    alter function public._resolved_spin_wheel(uuid) rename to _resolved_spin_wheel_real;
    create function public._resolved_spin_wheel(p_pass uuid) returns uuid language plpgsql volatile security definer set search_path=public as $$
    declare v uuid; begin
      v:=public._resolved_spin_wheel_real(p_pass);
      insert into ff_resolve_probe.calls(call,resolved,spins_written) values(coalesce(current_setting('fanfunnel.probe_call',true),''),v,(select count(*) from public.spins s where s.fan_pass_id=p_pass));
      if current_setting('fanfunnel.probe_flip',true)=${quote(camp)} then
        update public.campaigns set pinned_wheel_id=${quote(B)} where id=${quote(camp)};
        perform set_config('fanfunnel.probe_flip','',true);
      end if;
      return v;
    end $$;`);
  try {
    // Resolutions of one call, split by whether that call had written its spin yet.
    const calls = async tag => (await scalar(`select coalesce(string_agg(spins_written::text||'x'||n,',' order by spins_written),'none') from (select spins_written,count(*) n from ff_resolve_probe.calls where call=${quote(tag)} group by 1) c;`));
    // runtime: one prepare, one commit, one resolution each
    const a1 = await prep(randomUUID(), "prepare-1");
    check(a1.status === "ready" && a1.context.wheelId === A, `a prepared play resolves the pinned game A (${a1.status} ${a1.context?.wheelId})`);
    check(await calls("prepare-1") === "0x1", `prepare_spin_attempt ran the resolver once (${await calls("prepare-1")})`);
    const r1 = await commit(a1, wheelBody(a1, a1.context.prizes[0].id), "commit-1");
    check(r1.status === "committed" && r1.spin.wheel_id === A, `the play commits on A (${r1.status} ${r1.spin?.wheel_id})`);
    check(await calls("commit-1") === "0x1,1x1", `commit_spin_attempt ran the resolver once before writing the spin (its locks and context) and once after, for the receipt's card read (${await calls("commit-1")})`);
    // race: the pin flips to B in the instant after the commit's resolution
    const a2 = await prep(randomUUID(), "prepare-2");
    check(a2.status === "ready" && a2.context.wheelId === A, `the second play is prepared on A (${a2.status} ${a2.context?.wheelId})`);
    const r2 = await commit(a2, wheelBody(a2, a2.context.prizes[1].id), "commit-2", `select set_config('fanfunnel.probe_flip',${quote(camp)},true);`);
    const flipped = await scalar(`select pinned_wheel_id from public.campaigns where id=${quote(camp)};`);
    check(flipped === B, `the campaign pin moved to B during the commit (${flipped === B ? "B" : flipped})`);
    check(r2.status === "committed" && r2.spin.wheel_id === A, `a pin flip right after the resolution leaves the play on A, with every lock and the context on A (${r2.status} ${r2.spin?.wheel_id ?? ""})`);
    check(await calls("commit-2") === "1x1,2x1", `the raced commit ran the resolver once before writing the spin (${await calls("commit-2")})`);
    const a3 = await prep(randomUUID(), "prepare-3");
    check(a3.status === "ready" && a3.context.wheelId === B, `the next play is prepared on B (${a3.status} ${a3.context?.wheelId})`);
    check(await calls("prepare-3") === "2x1", `the next prepare ran the resolver once (${await calls("prepare-3")})`);
    const spins = await scalar(`select string_agg(w.title,',' order by s.nonce) from public.spins s join public.wheels w on w.id=s.wheel_id where s.fan_id=${quote(grant.fanId)};`);
    check(spins === "A,A", `both spins are recorded on A (${spins})`);
  } finally {
    await sql(`drop function public._resolved_spin_wheel(uuid);
      alter function public._resolved_spin_wheel_real(uuid) rename to _resolved_spin_wheel;
      drop schema ff_resolve_probe cascade;`);
    const restored = await scalar(`select provolatile::text||':'||prosecdef::text||':'||coalesce(array_to_string(proacl,','),'(default)') from pg_proc where oid='public._resolved_spin_wheel(uuid)'::regprocedure;`);
    check(restored === "s:true:postgres=X/postgres", `the real resolver is back under its name, stable, SECURITY DEFINER and owner-only (${restored})`);
  }
  return { bad, checks };
}
