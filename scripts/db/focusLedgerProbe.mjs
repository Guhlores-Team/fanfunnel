// Local SQL economics tests; sql() must run each call in its own real session.
import { createHash, randomUUID } from "node:crypto";
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
export async function probeFocusLedger(sqlInput) {
  const pending = new Set();
  const sql = q => { const p=sqlInput(q); pending.add(p); p.then(()=>pending.delete(p),()=>pending.delete(p)); return p; };
  let checks = 0;
  const check = (v, label) => { checks++; if (!v) throw Error(`0059 ${label}`); };
  const rpc = async (name, args) => { const raw=(await sql(`select public.${name}(${args.join(",")});`)).trim(); return name==="set_prize_delivery" ? raw : JSON.parse(raw||"null"); };
  const owner = randomUUID(), other = randomUUID(), wheel = randomUUID(), target = randomUUID(), normal = randomUUID();
  const tokens = new Map();
  await sql(`insert into auth.users(id,email) values(${quote(owner)},'focus-a-${owner}@example.test'),(${quote(other)},'focus-b-${other}@example.test');
    update public.profiles set is_active=true,approval_status='approved' where id in(${quote(owner)},${quote(other)});
    insert into public.wheels(id,creator_id,title,show_stock) values(${quote(wheel)},${quote(owner)},'focus-test',false);
    insert into public.prizes(id,wheel_id,label,weight,boostable,stock,sort_order) values
      (${quote(target)},${quote(wheel)},'Target',1,true,null,0),(${quote(normal)},${quote(wheel)},'Normal',1,false,null,1);
    insert into public.focus_creator_config(creator_id,chase_enabled) values(${quote(owner)},true);`);
  const addFan = async (credit = 100) => {
    const fan = randomUUID(), pass = randomUUID(), token = `focus-${randomUUID()}`;
    await sql(`insert into public.fans(id,creator_id,acked_at,acked_terms_version) values(${quote(fan)},${quote(owner)},now(),'2026-10-27');
      insert into public.fan_passes(id,token,creator_id,fan_id,wheel_id) values(${quote(pass)},${quote(token)},${quote(owner)},${quote(fan)},${quote(wheel)});`);
    const granted = await rpc("grant_pass_spins", [quote(randomUUID()),quote(owner),quote(fan),quote(pass),String(credit),"0","0","null"]);
    check(granted.status === "granted", "fixture ordinary credit grant succeeds");
    tokens.set(token, { fan, pass }); return { fan, pass, token };
  };
  const makePack = async (kind, n = 5) => {
    const id = randomUUID();
    await sql(`insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,focus_spins,chase_within) values(${quote(id)},${quote(owner)},'pack',10,${quote(kind)},${n},${n});`);
    return id;
  };
  const grant = (who, kindPack, id = randomUUID()) => rpc("grant_focus_pack", [quote(id),quote(owner),quote(who.fan),quote(who.pass),quote(kindPack),quote(target)]);
  const prep = async (who, id = randomUUID(), binding = hash(id)) => ({ id, binding, ...(await rpc("prepare_spin_attempt", [quote(id),quote(who.token),quote(binding)])) });
  const build = async (prepared, prizeId, excluded = []) => {
    const c = prepared.context, f = c.focus;
    const baseFactor = p => ["rare","epic","legendary"].includes(p.rarity) ? c.happyHourMultiplier ?? 1 : 1;
    const inPool = p => p.stock == null || p.stock > 0;
    const t = c.prizes.find(p => p.id === f?.prize_id);
    const before = c.prizes.filter(inPool).reduce((s,p) => s + Math.round(p.weight*baseFactor(p)),0);
    const after = before - (t && inPool(t) ? Math.round(t.weight*baseFactor(t)) : 0) + (t && inPool(t) ? Math.round(t.weight*Math.min(5,baseFactor(t)*f.multiplier)) : 0);
    const applied = f?.kind === "focus" && !!t && inPool(t) && Math.round(t.weight*Math.min(5,baseFactor(t)*f.multiplier))*before > Math.round(t.weight*baseFactor(t))*after;
    const eligible = f?.kind === "chase" && !!t && inPool(t);
    const snapshot = {v:3,rules:"focus-v1",game:"wheel",prizes:c.prizes.filter(inPool).map(p => ({id:p.id,label:p.label,emoji:p.emoji,rarity:p.rarity,w:Math.round(p.weight*(applied&&p.id===f.prize_id ? Math.min(5,baseFactor(p)*f.multiplier) : baseFactor(p))),baseW:p.weight})).sort((a,b)=>a.id.localeCompare(b.id)),
      modifiers:{happyHour:{multiplier:c.happyHourMultiplier},pity:{counter:c.pityCounter,threshold:10},focus:f?.kind==="focus"?{prizeId:f.prize_id,multiplier:f.multiplier,spinsLeft:f.spins_left,totalSpins:f.total_spins,effectiveMultiplier:applied?Math.min(5,baseFactor(t)*f.multiplier):t?baseFactor(t):1,applied,pauseReason:applied?null:!t?"other_wheel":!inPool(t)?"sold_out":"no_increase"}:null,
        chase:f?.kind==="chase"?{prizeId:f.prize_id,counter:f.chase_counter,within:f.total_spins,reserved:!!c.reservation,eligible,pauseReason:eligible?null:!t?"other_wheel":"sold_out"}:null}};
    const p = c.prizes.find(p=>p.id===prizeId), rare = ["rare","epic","legendary"].includes(p.rarity);
    let expected = {delivery:p.delivery};
    if(p.delivery==="codes") {
      const code = JSON.parse((await sql(`select row_to_json(c) from(select * from public.prize_reward_codes where prize_id=${quote(p.id)} and spin_id is null and ${c.reservation?.prize_id===p.id?`id=${quote(c.reservation.code_id)}`:"reserved_focus_id is null"} order by id limit 1)c;`)).trim() || "null");
      if(!code) return null;
      expected={delivery:"codes",codeId:code.id,cipher:code.cipher,iv:code.iv,keyVersion:code.key_version};
    } else if(p.delivery!=="manual") {
      const r=JSON.parse((await sql(`select row_to_json(r) from public.prize_rewards r where prize_id=${quote(p.id)};`)).trim());
      expected={delivery:p.delivery,cipher:r.cipher,iv:r.iv,keyVersion:r.key_version};
    }
    const seed=randomUUID().replaceAll("-","").repeat(2),focusConsumed=applied&&!excluded.includes(f.prize_id);
    return {ctx:{contextHash:c.contextHash},spin:{id:prepared.id,fan_id:c.fanId,fan_pass_id:c.passId,creator_id:c.creatorId,wheel_id:c.wheelId,campaign_id:c.campaignId,prize_id:p.id,prize_label:p.label,prize_rarity:p.rarity,prize_image_url:p.image_url,server_seed:c.serverSeed,server_seed_hash:c.serverSeedHash,nonce:c.nonce,client_seed:"probe",fair_version:3,pool_snapshot:snapshot,pool_hash:hash(canonical(snapshot)),fair_trace:{excluded,won:p.id},next_pity_counter:rare?0:c.pityCounter+1,focus_consumed:focusConsumed,chase_consumed:eligible,chase_completed:eligible&&p.id===f.prize_id,next_focus_spins_left:f?.kind==="focus"?f.spins_left-(focusConsumed?1:0):null,next_chase_counter:f?.kind==="chase"?f.chase_counter+(eligible?1:0):null,response_prize:{id:p.id,label:p.label,rarity:p.rarity,weight:p.weight},response_prize_index:c.prizes.findIndex(x=>x.id===p.id),response_show_stock:false},expected,next:{seed,hash:hash(seed)}};
  };
  const commit = (who, a, b) => rpc("commit_spin_attempt",[quote(a.id),quote(who.token),quote(a.binding),json(b.ctx),json(b.spin),json(b.expected),json(b.next)]);
  const status = (who,a) => rpc("get_spin_attempt_status",[quote(a.id),quote(who.token),quote(a.binding)]);
  try {
    const one=await addFan(), two=await addFan();
    check((await rpc("grant_pass_spins",[quote(randomUUID()),quote(other),quote(one.fan),quote(one.pass),"1","0","0","null"])).status==="unavailable","forged creator cannot grant another tenant credit");
    check((await rpc("cancel_fan_focus",[quote(other),quote(one.fan),quote(randomUUID())])).status==="unavailable","forged creator cannot cancel another tenant promise");
    check((await rpc("get_fan_focus_state",[quote("unknown-token")])).status==="unavailable","unknown token cannot read focus metadata");
    check((await rpc("ensure_pass_commitment",[quote("unknown-token")]))===null,"unknown token cannot initialize or read seed commitment");
    for(const table of ["focus_creator_config","fan_focus","chase_reservations","spin_attempts","fan_import_batches","fan_import_items","creator_request_journal","actor_request_cancellations"]) {
      let denied=false;try{await sql(`set role anon;select count(*) from public.${table};`)}catch{denied=true}check(denied,`anon cannot read ${table}`);
      denied=false;try{await sql(`set role authenticated;select set_config('request.jwt.claim.sub',${quote(other)},false);insert into public.${table} default values;`)}catch(e){denied=/permission denied|row-level security/.test(e.message)}check(denied,`authenticated cannot write ${table}`);
    }
    for(const name of ["prepare_spin_attempt","commit_spin_attempt","get_spin_attempt_status","grant_focus_pack","cancel_fan_focus","get_fan_focus_state","grant_pass_spins","edit_pass_grant","ensure_pass_commitment","create_pass_grant","award_fan_referral","cancel_spin_attempt","import_fans_durable","reconcile_creator_request"]) {
      check((await sql(`select bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${quote(name)};`)).trim()==="t",`${name} denies both browser roles`);
    }
    for(const name of ["claim_spin","finalize_reward_spin","reserve_reward_code","release_reward_code","credit_pass_spins","import_fans"])check((await sql(`select bool_and(not has_function_privilege('service_role',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${quote(name)};`)).trim()==="t",`${name} legacy writer retired`);
    let denied=false;try{await sql(`update public.fan_passes set spins_remaining=999 where id=${quote(one.pass)};`)}catch{denied=true}check(denied,"direct credit write denied even service-level caller");
    denied=false;try{await sql(`insert into public.fans(creator_id,spins_remaining) values(${quote(owner)},999);`)}catch(e){denied=/use atomic grant RPC/.test(e.message)}check(denied,"nonzero fan INSERT cannot forge aggregate credit");
    denied=false;try{await sql(`insert into public.fan_passes(token,creator_id,fan_id,wheel_id,next_server_seed,next_server_seed_hash) values('forged-seed-${owner}',${quote(owner)},${quote(one.fan)},${quote(wheel)},repeat('a',64),repeat('b',64));`)}catch(e){denied=/use atomic grant RPC/.test(e.message)}check(denied,"creator cannot choose initial future seed through direct pass INSERT");
    denied=false;try{await sql(`insert into public.fan_passes(token,creator_id,fan_id,wheel_id) values('foreign-pass-${owner}',${quote(other)},${quote(one.fan)},${quote(wheel)});`)}catch(e){denied=/pass references another creator/.test(e.message)}check(denied,"cross-tenant pass/fan/wheel references fail closed");
    denied=false;try{await sql(`update public.fan_passes set fan_id=${quote(two.fan)} where id=${quote(one.pass)};`)}catch(e){denied=/pass identity is immutable/.test(e.message)}check(denied,"moving credited pass to another fan cannot corrupt aggregate invariants");
    const attempt=await prep(one);check(attempt.status==="ready"&&attempt.balance===100,"preparation ready without debit");
    check((await sql(`select spins_remaining||','||next_spin_nonce||','||(select pity_counter from public.fans where id=${quote(one.fan)}) from public.fan_passes where id=${quote(one.pass)};`)).trim()==="100,0,0","preparation leaves balance/nonce/pity untouched");
    check((await status(one,attempt)).status==="pending","prepared attempt stays pending until transaction");
    check((await status(two,attempt)).status==="conflict","other token cannot read receipt");
    const body=await build(attempt,normal), result=await commit(one,attempt,body);
    check(result.status==="committed"&&result.balance===99&&result.replayed===false,"manual win and debit commit together");
    const replay=await commit(one,attempt,body);check(replay.status==="committed"&&replay.replayed===true&&replay.shareId===result.shareId&&replay.balance===99,"same identity replay spends once");
    check((await sql(`select next_spin_nonce||','||(select pity_counter from public.fans where id=${quote(one.fan)})||','||(select count(*) from public.redemptions where spin_id=${quote(attempt.id)}) from public.fan_passes where id=${quote(one.pass)};`)).trim()==="1,1,1","one nonce/pity/redemption transition");
    const collision=await prep(one,attempt.id,hash("different"));check(collision.status==="conflict","same UUID different intent refused");
    const stale=await prep(one), fresh=await prep(one);await commit(one,fresh,await build(fresh,normal));
    check((await commit(one,stale,await build(stale,normal))).status==="retry_context","stale seed/pity context never spends");
    const pack=await makePack("focus"), grantId=randomUUID(), focus=await grant(two,pack,grantId);
    check(focus.status==="granted"&&focus.focus.spins_left===5&&focus.balance===110,"focus credit and promise atomic");
    const grantReplay=await grant(two,pack,grantId);check(grantReplay.replayed&&grantReplay.balance===110,"grant replay cannot mint credits");
    check((await grant(two,pack)).status==="focus_exists","one active OR paused focus");
    for(const table of ["fan_focus","spin_attempts","focus_creator_config"]) {
      const own=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select count(*) from public.${table} where creator_id=${quote(owner)};rollback;`)).trim().split("\n").at(-1);
      const cross=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(other)},true);select count(*) from public.${table} where creator_id=${quote(owner)};rollback;`)).trim().split("\n").at(-1);
      check(Number(own)>0&&cross==="0",`${table} real nonempty own metadata / zero cross-tenant metadata`);
    }
    denied=false;try{await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select context from public.spin_attempts;rollback;`)}catch(e){denied=/permission denied/.test(e.message)}check(denied,"creator SELECT cannot reach attempt future seed context");
    denied=false;try{await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select next_server_seed from public.fan_passes;rollback;`)}catch(e){denied=/permission denied/.test(e.message)}check(denied,"creator cannot read unrevealed pass seed");
    const focusPrepared=await prep(two), focusBody=await build(focusPrepared,normal);
    const forged=structuredClone(focusBody);forged.spin.next_pity_counter=123;denied=false;try{await commit(two,focusPrepared,forged)}catch{denied=true}check(denied,"forged pity transition refused");
    check((await sql(`select spins_remaining from public.fan_passes where id=${quote(two.pass)};`)).trim()==="110","refused forged transition preserves credit");
    check((await commit(two,focusPrepared,focusBody)).focus.spins_left===4,"successful focused spin consumes one promise");
    await sql(`update public.fans set break_until=now()+interval '1 day' where id=${quote(two.fan)};`);
    check((await grant(two,pack)).status==="unavailable","break refuses new purchase");
    check((await sql(`select status||','||spins_left from public.fan_focus where id=${quote(focus.focus.id)};`)).trim()==="paused,4","break retains paid focus");
    await rpc("cancel_fan_focus",[quote(owner),quote(two.fan),quote(focus.focus.id)]);
    await sql(`update public.prizes set stock=1 where id=${quote(target)};`);
    const chasePack=await makePack("chase"), chaseFan=await addFan(), reservation=await grant(chaseFan,chasePack);
    check(reservation.status==="granted"&&(await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()==="0","chase reserves last finite unit");
    const outsider=await addFan();check((await grant(outsider,chasePack)).status==="sold_out","another fan cannot buy held unit");
    const chaseAttempt=await prep(chaseFan), chaseWin=await commit(chaseFan,chaseAttempt,await build(chaseAttempt,target));
    check(chaseWin.status==="committed"&&chaseWin.chaseCompleted&&chaseWin.focus===null,"natural chase target consumes held unit and finishes promise");
    await rpc("cancel_fan_focus",[quote(owner),quote(chaseFan.fan),quote(reservation.focus.id)]);check((await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()==="0","cancel after consumed unit never restocks");
    // Code promises hold an actual encrypted row, not just a scalar decrement.
    const codes=Array.from({length:3},(_,i)=>({cipher:`cipher-${i}`,iv:`iv-${i}`,key_version:1,hint:`c${i}`,fingerprint:hash(`focus-${owner}-${i}`)}));
    await rpc("add_reward_codes",[quote(target),quote(owner),json(codes)]);
    const codeFan=await addFan(), held=await grant(codeFan,chasePack);check(held.status==="granted","code chase granted");
    check((await sql(`select stock||','||(select count(*) from public.prize_reward_codes where prize_id=${quote(target)} and reserved_focus_id is not null) from public.prizes where id=${quote(target)};`)).trim()==="2,1","free code stock excludes one concrete held row");
    const codeAttempt=await prep(codeFan), codeBody=await build(codeAttempt,target), codeWin=await commit(codeFan,codeAttempt,codeBody);
    check(codeWin.status==="committed"&&codeWin.reward.kind==="code"&&codeWin.stockAfter===2,"held concrete code becomes immutable receipt without extra free-stock debit");
    check((await status(codeFan,codeAttempt)).shareId===codeWin.shareId,"status recovers code receipt after lost HTTP response");
    denied=false;try{await sql(`update public.redemptions set status='pending' where spin_id=${quote(codeAttempt.id)};`)}catch{denied=true}check(denied,"Auto delivery cannot reopen");
    await sql(`delete from public.fans where id=${quote(codeFan.fan)};`);
    check((await sql(`select count(*) from public.prize_reward_codes where spin_id=${quote(codeAttempt.id)} and cipher is null and iv is null and erased_at is not null;`)).trim()==="1","fan erasure retains consumed fingerprint tombstone without secret");
    check((await rpc("add_reward_codes",[quote(target),quote(owner),json(codes)])).toString()==="0","erased delivered code cannot be pasted into stock again");
    const heldFan=await addFan(),heldGrant=await grant(heldFan,chasePack);await rpc("cancel_fan_focus",[quote(owner),quote(heldFan.fan),quote(heldGrant.focus.id)]);await rpc("cancel_fan_focus",[quote(owner),quote(heldFan.fan),quote(heldGrant.focus.id)]);
    check((await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()==="2","repeated release returns code once");
    const passRemoved=await addFan();const passRemovedGrant=await grant(passRemoved,chasePack);
    await sql(`delete from public.fan_passes where id=${quote(passRemoved.pass)};`);
    check((await sql(`select status from public.fan_focus where id=${quote(passRemovedGrant.focus.id)};`)).trim()==="released","removing target pass releases its held promise");
    check((await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()==="2","pass removal restores held code exactly once");
    const erasedHeld=await addFan();await grant(erasedHeld,chasePack);await sql(`delete from public.fans where id=${quote(erasedHeld.fan)};`);
    check((await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()==="2","erasing fan releases unused held code before cascades");
    const retryCancelFan=await addFan(),oldFocus=await grant(retryCancelFan,chasePack);
    const cancelledOld=await rpc("cancel_fan_focus",[quote(owner),quote(retryCancelFan.fan),quote(oldFocus.focus.id)]);
    check(cancelledOld.status==="released","initial expected-focus cancellation releases its reservation");
    const newFocus=await grant(retryCancelFan,chasePack),stockWhileNewHeld=(await sql(`select stock from public.prizes where id=${quote(target)};`)).trim();
    check((await rpc("cancel_fan_focus",[quote(owner),quote(retryCancelFan.fan),quote(oldFocus.focus.id)])).status==="absent","retry after a lost old-cancel response cannot cancel a replacement focus");
    check((await sql(`select state from public.chase_reservations where focus_id=${quote(newFocus.focus.id)};`)).trim()==="held"&&(await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()===stockWhileNewHeld,"replacement code reservation remains held and stock unchanged");
    await rpc("cancel_fan_focus",[quote(owner),quote(retryCancelFan.fan),quote(newFocus.focus.id)]);
    // Transaction faults after a debit/allocation must roll every resource back.
    const failureFan=await addFan(), failed=await prep(failureFan), failedBody=await build(failed,normal);
    await sql(`create function public._focus_probe_reject_spin() returns trigger language plpgsql as $$ begin raise exception 'injected spin failure'; end $$;
      create trigger zz_focus_probe_reject_spin before insert on public.spins for each row execute function public._focus_probe_reject_spin();`);
    denied=false;try{await commit(failureFan,failed,failedBody)}catch(e){denied=/injected spin failure/.test(e.message)}
    check(denied,"injected spin INSERT failure reaches real transaction");
    check((await sql(`select spins_remaining||','||next_spin_nonce||','||(select pity_counter from public.fans where id=${quote(failureFan.fan)}) from public.fan_passes where id=${quote(failureFan.pass)};`)).trim()==="100,0,0","insert failure rolls debit/nonce/pity back together");
    check((await status(failureFan,failed)).status==="pending","SQL abort leaves resumable nonspending attempt");
    await sql(`drop trigger zz_focus_probe_reject_spin on public.spins;drop function public._focus_probe_reject_spin();`);
    check((await commit(failureFan,failed,failedBody)).status==="committed","same identity recovers after SQL abort");
    const historicalStatus=await status(one,attempt),currentHash=(await sql(`select next_server_seed_hash from public.fan_passes where id=${quote(one.pass)};`)).trim();
    check(historicalStatus.spin.nonce===0&&historicalStatus.shareId===result.shareId&&historicalStatus.nextServerSeedHash===currentHash&&historicalStatus.balance===98,"old receipt keeps proof while returning fresh current seed hash and balance");
    // A terminal absent tombstone wins against any delayed first request.
    const cancelledId=randomUUID(),cancelledHash=hash(cancelledId);
    check((await rpc("cancel_spin_attempt",[quote(cancelledId),quote(failureFan.token),quote(cancelledHash),quote("no_prizes")])).status==="declined","absent attempt can be durably declined");
    check((await prep(failureFan,cancelledId,cancelledHash)).status==="declined","late original request cannot revive a terminal tombstone");
    const cancelRace=await prep(failureFan),cancelBody=await build(cancelRace,normal);
    const cancelResults=await Promise.all([commit(failureFan,cancelRace,cancelBody),rpc("cancel_spin_attempt",[quote(cancelRace.id),quote(failureFan.token),quote(cancelRace.binding),quote("cancelled")])]);
    check(cancelResults.every(r=>r.status===cancelResults[0].status),"commit/cancel race resolves one terminal outcome");
    const breakFan=await addFan(),breakAttempt=await prep(breakFan),breakBody=await build(breakAttempt,normal);
    await sql(`update public.fans set break_until=now()+interval '1 day' where id=${quote(breakFan.fan)};`);
    const breakRefused=await commit(breakFan,breakAttempt,breakBody);
    check(breakRefused.status==="declined"&&breakRefused.error==="on_break","break started after prepare still refuses atomic spend");
    check((await sql(`select spins_remaining from public.fan_passes where id=${quote(breakFan.pass)};`)).trim()==="100","break refusal neither spends nor refunds guessed credit");
    // Two independent fans race the final ordinary finite unit.
    const stockA=await addFan(),stockB=await addFan();await sql(`update public.prizes set delivery='manual',stock=1 where id=${quote(target)};`);
    const stockPrep=await Promise.all([prep(stockA),prep(stockB)]),stockBodies=await Promise.all(stockPrep.map(a=>build(a,target)));
    const stockRace=await Promise.all([commit(stockA,stockPrep[0],stockBodies[0]),commit(stockB,stockPrep[1],stockBodies[1])]);
    check(stockRace.filter(r=>r.status==="committed").length===1&&stockRace.filter(r=>r.status==="sold_out").length===1,"last ordinary unit has exactly one winner");
    check((await sql(`select sum(spins_remaining) from public.fan_passes where id in(${quote(stockA.pass)},${quote(stockB.pass)});`)).trim()==="199","sold-out race loser never debited");
    await sql(`update public.prizes set stock=null where id=${quote(target)};`);
    // Bootstrap's request UUID protects new fan/pass identities after response loss.
    const bootstrapId=randomUUID(),bootstrapArgs=[quote(bootstrapId),quote(owner),"null",quote(wheel),quote("New fan"),"13","3","500","null","null"];
    const bootstrap=await rpc("create_pass_grant",bootstrapArgs),bootstrapAgain=await rpc("create_pass_grant",bootstrapArgs);
    check(bootstrap.status==="granted"&&bootstrap.balance===13&&bootstrapAgain.replayed&&bootstrapAgain.token===bootstrap.token&&bootstrapAgain.fanId===bootstrap.fanId,"new fan/bootstrap replay creates one fan/pass/grant with inclusive bonus total");
    check((await sql(`select spins||','||bonus_spins from public.grants where id=${quote(bootstrapId)};`)).trim()==="13,3","grant total includes bonus without double credit");
    const beforeFault=(await sql(`select (select count(*) from public.fans where creator_id=${quote(owner)})||','||(select count(*) from public.fan_passes where creator_id=${quote(owner)});`)).trim();
    await sql(`create function public._focus_probe_reject_grant() returns trigger language plpgsql as $$ begin raise exception 'injected grant failure'; end $$;
      create trigger zz_focus_probe_reject_grant before insert on public.grants for each row execute function public._focus_probe_reject_grant();`);
    denied=false;try{await rpc("create_pass_grant",[quote(randomUUID()),quote(owner),"null",quote(wheel),quote("Must roll back"),"5","0","100","null","null"])}catch(e){denied=/injected grant failure/.test(e.message)}
    check(denied,"injected grant INSERT fault occurs inside bootstrap");
    check((await sql(`select (select count(*) from public.fans where creator_id=${quote(owner)})||','||(select count(*) from public.fan_passes where creator_id=${quote(owner)});`)).trim()===beforeFault,"failed bootstrap leaves no fan/pass skeleton");
    const noGrantFan=await addFan(0).catch(()=>null);
    check(noGrantFan===null,"injected ordinary grant failure propagates");
    await sql(`drop trigger zz_focus_probe_reject_grant on public.grants;drop function public._focus_probe_reject_grant();`);
    const packId=randomUUID(),packedRequest=randomUUID();
    await sql(`insert into public.campaign_packs(id,creator_id,label,spins,bonus_spins,amount_cents) values(${quote(packId)},${quote(owner)},'server terms',7,2,999);`);
    const packArgs=[quote(packedRequest),quote(owner),"null",quote(wheel),quote("Packed fan"),"999","0","0","null","null",quote(packId)];
    const packed=await rpc("create_pass_grant",packArgs);check(packed.balance===9,"server pack overrides forged creator credit/price input");
    await sql(`update public.campaign_packs set spins=99,amount_cents=1 where id=${quote(packId)};`);
    check((await rpc("create_pass_grant",packArgs)).fanId===packed.fanId,"same request retains original pack purchase after edited terms");
    const qtyArgs=[quote(randomUUID()),quote(owner),"null",quote(wheel),quote("Quantity fan"),"999","0","0","null","null",quote(packId),"3"];
    const quantity=await rpc("create_pass_grant",qtyArgs);
    check(quantity.balance===303,"pack quantity uses current server terms for all units");
    check((await sql(`select spins||','||bonus_spins||','||amount_cents from public.grants where id=${qtyArgs[0]};`)).trim()==="303,6,3","quantity grant preserves total/bonus/revenue exactly");
    const overflow=await rpc("create_pass_grant",[quote(randomUUID()),quote(owner),"null",quote(wheel),quote("Too many"),"1","0","0","null","null",quote(packId),"1000000"]);
    check(overflow.status==="invalid"&&overflow.error==="invalid_pack","multiplied pack overflow rejected without clamping");
    await sql(`delete from public.campaign_packs where id=${quote(packId)};`);
    check((await rpc("create_pass_grant",packArgs)).balance===9,"same purchase recovers even after template deletion");
    // Referral both-side balances and cap serialize under sorted fan locks.
    const referrer=await addFan(),referred=await addFan();
    await sql(`update public.fans set referred_by_fan_id=${quote(referrer.fan)} where id=${quote(referred.fan)};
      insert into public.referrals(creator_id,referrer_fan_id,referred_fan_id) values(${quote(owner)},${quote(referrer.fan)},${quote(referred.fan)});`);
    await rpc("grant_pass_spins",[quote(randomUUID()),quote(owner),quote(referred.fan),quote(referred.pass),"1","0","100","null"]);
    const referrals=await Promise.all(Array.from({length:10},()=>rpc("award_fan_referral",[quote(owner),quote(referred.fan)])));
    check(referrals.filter(r=>r.status==="credited").length===1,"concurrent referral retries credit once");
    check((await sql(`select string_agg(spins_remaining::text,',' order by id=${quote(referrer.pass)}) from public.fan_passes where id in(${quote(referrer.pass)},${quote(referred.pass)});`)).trim()==="104,103","both referred/referrer pass bonuses land atomically");
    const retryReferral=await addFan();await sql(`update public.fans set referred_by_fan_id=${quote(referrer.fan)} where id=${quote(retryReferral.fan)};insert into public.referrals(creator_id,referrer_fan_id,referred_fan_id) values(${quote(owner)},${quote(referrer.fan)},${quote(retryReferral.fan)});`);
    await rpc("grant_pass_spins",[quote(randomUUID()),quote(owner),quote(retryReferral.fan),quote(retryReferral.pass),"1","0","100","null"]);
    await sql(`create function public._focus_probe_reject_referral() returns trigger language plpgsql as $$ begin raise exception 'injected referral receipt failure';end $$;create trigger zz_focus_probe_reject_referral before update of credited_at on public.referrals for each row execute function public._focus_probe_reject_referral();`);
    denied=false;try{await rpc("award_fan_referral",[quote(owner),quote(retryReferral.fan)])}catch(e){denied=/injected referral receipt failure/.test(e.message)}
    check(denied,"injected referral final-write fault aborts entire award");
    check((await sql(`select (select spins_remaining from public.fan_passes where id=${quote(referrer.pass)})||','||(select spins_remaining from public.fan_passes where id=${quote(retryReferral.pass)})||','||(select referral_credited from public.fans where id=${quote(retryReferral.fan)});`)).trim()==="103,101,false","referral final-write failure rolls both balances and flag back");
    await sql(`drop trigger zz_focus_probe_reject_referral on public.referrals;drop function public._focus_probe_reject_referral();`);
    check((await rpc("award_fan_referral",[quote(owner),quote(retryReferral.fan)])).status==="credited","failed referral can recover later exactly once");
    const cappedFans=await Promise.all(Array.from({length:3},()=>addFan()));for(const q of cappedFans){await sql(`update public.fans set referred_by_fan_id=${quote(referrer.fan)} where id=${quote(q.fan)};insert into public.referrals(creator_id,referrer_fan_id,referred_fan_id) values(${quote(owner)},${quote(referrer.fan)},${quote(q.fan)});`);await rpc("grant_pass_spins",[quote(randomUUID()),quote(owner),quote(q.fan),quote(q.pass),"1","0","100","null"]);}
    const capRace=await Promise.all(cappedFans.map(q=>rpc("award_fan_referral",[quote(owner),quote(q.fan)])));
    check(capRace.filter(r=>r.status==="credited").length===1&&capRace.filter(r=>r.status==="capped").length===2,"concurrent referral cap credits only the third permitted referral");
    check((await sql(`select count(*) from public.referrals where referrer_fan_id=${quote(referrer.fan)} and credited_at is not null;`)).trim()==="3","referrer cap is durable under concurrent awards");
    // Eight committed plays (rate cap), over two passes, consume only three
    // remaining focused spins despite ten simultaneous fresh contexts.
    const multi=await addFan(),secondPass=randomUUID(),secondToken=`focus-${randomUUID()}`;
    await sql(`insert into public.fan_passes(id,token,creator_id,fan_id,wheel_id) values(${quote(secondPass)},${quote(secondToken)},${quote(owner)},${quote(multi.fan)},${quote(wheel)});`);
    await rpc("grant_pass_spins",[quote(randomUUID()),quote(owner),quote(multi.fan),quote(secondPass),"100","0","0","null"]);
    await sql(`update public.prizes set delivery='manual',stock=null where id=${quote(target)};`);
    const multiFocus=await grant(multi,pack);await sql(`update public.fan_focus set spins_left=3 where id=${quote(multiFocus.focus.id)};`);
    const playOne=async(who)=>{const id=randomUUID(),binding=hash(id);for(let i=0;i<30;i++){const a=await prep(who,id,binding);if(a.status!=="ready")return a;const r=await commit(who,a,await build(a,normal));if(r.status!=="retry_context")return r;}throw Error("too much context contention");};
    const plays=await Promise.all(Array.from({length:10},(_,i)=>playOne(i%2?{...multi,pass:secondPass,token:secondToken}:multi)));
    check(plays.filter(r=>r.status==="committed").length===8&&plays.filter(r=>r.error==="rate_limited").length===2,"per-fan atomic rate window covers two passes");
    check(plays.filter(r=>r.focusConsumed).length===3,"ten racing intents consume exactly three remaining focus spins");
    check((await sql(`select sum(spins_remaining) from public.fan_passes where fan_id=${quote(multi.fan)} and is_active;`)).trim()==="202","eight commits debit exactly eight of 210 total credits");
    // Independent sessions race the same focus grant: one purchase owns the promise.
    await sql(`update public.prizes set delivery='codes' where id=${quote(target)};`);
    const raced=await addFan(), grantRaces=await Promise.all(Array.from({length:10},()=>grant(raced,chasePack)));
    check(grantRaces.filter(r=>r.status==="granted").length===1,"ten concurrent purchase requests create exactly one focus");
    check((await sql(`select spins_remaining from public.fan_passes where id=${quote(raced.pass)};`)).trim()==="110","losing grant races never credit");
    const block=await Promise.all([sql(`update public.fans set blocked_at=now() where id=${quote(raced.fan)};`),rpc("cancel_fan_focus",[quote(owner),quote(raced.fan),quote(grantRaces.find(r=>r.status==="granted").focus.id)])]);
    check(block.length===2&&(await sql(`select stock from public.prizes where id=${quote(target)};`)).trim()==="2","block/cancel race releases exactly once");
    // All-spin0059 path: twenty independently prepared fans compete for five
    // code units. Stale candidates retry the same prize/context, never spend.
    const extraCodes=Array.from({length:3},(_,i)=>({cipher:`race-cipher-${i}`,iv:`race-iv-${i}`,key_version:1,hint:`r${i}`,fingerprint:hash(`race-${owner}-${i}`)}));
    await rpc("add_reward_codes",[quote(target),quote(owner),json(extraCodes)]);
    const oldAssigned=Number((await sql(`select count(*) from public.prize_reward_codes where prize_id=${quote(target)} and spin_id is not null;`)).trim());
    const contenders=await Promise.all(Array.from({length:20},()=>addFan()));
    const allocate=async(who)=>{const a=await prep(who);for(let n=0;n<30;n++){const body=await build(a,target);if(!body){await rpc("cancel_spin_attempt",[quote(a.id),quote(who.token),quote(a.binding),quote("no_prizes")]);return {status:"sold_out"};}const r=await commit(who,a,body);if(r.status==="changed")continue;if(r.status==="sold_out"){await rpc("cancel_spin_attempt",[quote(a.id),quote(who.token),quote(a.binding),quote("no_prizes")]);return r;}if(r.status!=="committed")throw Error(`unexpected code allocation ${r.status}`);const again=await commit(who,a,body);if(again.shareId!==r.shareId||!again.replayed)throw Error("code replay mismatch");return {...r,codeId:body.expected.codeId};}throw Error("code contention exhausted");};
    const allocations=await Promise.all(contenders.map(allocate)),winners=allocations.filter(r=>r.status==="committed");
    check(winners.length===5&&new Set(winners.map(r=>r.codeId)).size===5,"twenty ledger intents allocate exactly five distinct codes");
    check(allocations.filter(r=>r.status==="sold_out").length===15,"fifteen code-race losers reach nonspending terminal declines");
    check((await sql(`select stock||','||((select count(*) from public.prize_reward_codes where prize_id=${quote(target)} and spin_id is not null)-${oldAssigned}) from public.prizes where id=${quote(target)};`)).trim()==="0,5","free stock and new code assignments finish at zero/five");
    check((await sql(`select sum(spins_remaining) from public.fan_passes where id in(${contenders.map(c=>quote(c.pass)).join(",")});`)).trim()==="1995","five code wins cost exactly five of 2000 credited spins");
    // Durable CSV intents bind all normalized raw slots, including validation
    // errors, before resolving any mutable campaign/wheel defaults.
    const batch=randomUUID(),rawRows=[
      {name:"CSV A",spins:3,amountCents:100,campaignId:null,wheelId:null,error:null},
      {name:"(blank)",spins:0,amountCents:0,campaignId:null,wheelId:null,error:"missing_name"},
      {name:"CSV C",spins:4,amountCents:200,campaignId:randomUUID(),wheelId:null,error:null},
    ];
    const importArgs=(id,rows,creator=owner)=>[quote(id),quote(creator),quote(hash(canonical(["fan-import-v1",rows]))),json(rows)];
    const unicodeRows=[{name:'Fan "A" 😃',spins:2,amountCents:100,campaignId:null,wheelId:null,error:null}],unicodeCanonical=canonical(["fan-import-v1",unicodeRows]);
    check((await sql(`select public._canonical_proof_json(${json(["fan-import-v1",unicodeRows])});`)).trim()===unicodeCanonical,"PG and independent JS canonical JSON agree for quotes, Unicode and null slots");
    check((await rpc("import_fans_durable",importArgs(randomUUID(),unicodeRows))).items[0].token,"Unicode CSV intent hash is independently verified and accepted in PG");
    // Regression for the retired legacy import: an actor-cancelled UUID must
    // not be bypassed by the old unjournaled INSERT gateway in any API role.
    const retiredBatch=randomUUID(),retiredRows=Array.from({length:2},(_,i)=>({fan_id:randomUUID(),pass_id:randomUUID(),token:`retired-import-${randomUUID()}`,wheel_id:wheel,campaign_id:null,name:`Retired bypass ${i}`,spins:5,amount_cents:0}));
    check((await rpc("reconcile_creator_request",[quote(retiredBatch),"null",quote(owner),quote("import"),"true","false"])).status==="cancelled","import intent is authoritatively cancelled before bypass attempt");
    for(const role of ["anon","authenticated","service_role"]) {
      let refused=false;try{await sql(`begin;set local role ${role};select set_config('request.jwt.claim.sub',${quote(owner)},true);select public.import_fans(${json(retiredRows)});rollback;`)}catch(e){refused=/permission denied for function import_fans/.test(e.message)}
      check(refused,`${role} cannot use legacy import to bypass an actor cancellation`);
    }
    const publicLegacy=(await sql(`select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where n.nspname='public' and p.proname='import_fans' and a.grantee=0 and a.privilege_type='EXECUTE');`)).trim();
    check(publicLegacy==="f","legacy import has no PUBLIC execute ACL");
    check((await sql(`select (select count(*) from public.fans where id in(${retiredRows.map(r=>quote(r.fan_id)).join(",")}))||','||(select coalesce(sum(spins_remaining),0) from public.fan_passes where id in(${retiredRows.map(r=>quote(r.pass_id)).join(",")}))||','||(select count(*) from public.creator_request_journal where id=${quote(retiredBatch)});`)).trim()==="0,0,0","retired bypass leaves zero fans, zero credits and no unjournaled business rows");
    check((await rpc("import_fans_durable",importArgs(retiredBatch,rawRows))).status==="cancelled","durable gateway honors the same cancelled import UUID");
    const imported=await rpc("import_fans_durable",importArgs(batch,rawRows));
    check(imported.status==="imported"&&imported.items.map(i=>i.ordinal).join(",")==="0,1,2"&&imported.items[1].error==="missing_name","CSV preserves valid/error slot ordering");
    check((await sql(`select campaign_id is null from public.fan_passes where id=${quote(imported.items[2].passId)};`)).trim()==="t","CSV unknown campaign falls back without a foreign reference");
    const importedAgain=await rpc("import_fans_durable",importArgs(batch,rawRows));
    check(importedAgain.replayed&&importedAgain.items[0].token===imported.items[0].token&&importedAgain.items[2].grantId===imported.items[2].grantId,"lost CSV response recovers identical links and accounting references");
    const changedRows=structuredClone(rawRows);changedRows[0].spins=9;
    check((await rpc("import_fans_durable",importArgs(batch,changedRows))).status==="conflict","same CSV UUID with changed raw content is refused");
    check((await rpc("import_fans_durable",importArgs(batch,rawRows,other))).status==="conflict","other creator cannot recover an import batch");
    const concurrentBatch=randomUUID(),batchReplies=await Promise.all(Array.from({length:10},()=>rpc("import_fans_durable",importArgs(concurrentBatch,rawRows))));
    check(batchReplies.filter(r=>!r.replayed).length===1&&new Set(batchReplies.map(r=>r.items[0].token)).size===1,"ten concurrent CSV retries create one valid subset");
    check((await sql(`select count(*) from public.fan_import_items where batch_id=${quote(concurrentBatch)};`)).trim()==="3","CSV concurrency stores three original ordinal slots only");
    const newDefault=randomUUID();await sql(`update public.wheels set is_active=false where creator_id=${quote(owner)};insert into public.wheels(id,creator_id,title,is_active) values(${quote(newDefault)},${quote(owner)},'Changed default',true);`);
    const replayAfterDefault=await rpc("import_fans_durable",importArgs(batch,rawRows));
    check(replayAfterDefault.items[0].passId===imported.items[0].passId,"CSV replay ignores changed default wheel");
    await sql(`delete from public.fans where id=${quote(imported.items[0].fanId)};`);
    const erasedImport=await rpc("import_fans_durable",importArgs(batch,rawRows));
    check(erasedImport.items[0].error==="gone"&&!erasedImport.items[0].token,"erased CSV fan is never recreated or returned as a link");
    // A later valid-row failure rolls back earlier valid rows and ledger slots.
    const faultBatch=randomUUID(),faultRows=[{name:"valid batch first",spins:2,amountCents:100,campaignId:null,wheelId:null,error:null},{name:"bad batch second",spins:3,amountCents:100,campaignId:null,wheelId:null,error:null}];
    const beforeBatchFault=(await sql(`select count(*) from public.fans where creator_id=${quote(owner)};`)).trim();
    await sql(`create function public._focus_probe_reject_import() returns trigger language plpgsql as $$begin if exists(select 1 from public.fans where id=new.fan_id and display_name='bad batch second') then raise exception 'injected import second-row failure';end if;return new;end $$;create trigger zz_focus_probe_reject_import before insert on public.grants for each row execute function public._focus_probe_reject_import();`);
    denied=false;try{await rpc("import_fans_durable",importArgs(faultBatch,faultRows))}catch(e){denied=/injected import second-row failure/.test(e.message)}check(denied,"CSV second valid-row fault reaches transaction");
    check((await sql(`select (select count(*) from public.fans where creator_id=${quote(owner)})||','||(select count(*) from public.fan_import_batches where id=${quote(faultBatch)})||','||(select count(*) from public.fan_import_items where batch_id=${quote(faultBatch)});`)).trim()===`${beforeBatchFault},0,0`,"CSV valid subset and batch ledger roll back together");
    await sql(`drop trigger zz_focus_probe_reject_import on public.grants;drop function public._focus_probe_reject_import();`);
    check((await rpc("import_fans_durable",importArgs(faultBatch,faultRows))).items.every(r=>r.token),"same failed CSV identity can safely recover once SQL fault is removed");
    for(const table of ["fan_import_batches","fan_import_items","creator_request_journal"]) {
      const own=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select count(*) from public.${table} where creator_id=${quote(owner)};rollback;`)).trim().split("\n").at(-1);
      const cross=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(other)},true);select count(*) from public.${table} where creator_id=${quote(owner)};rollback;`)).trim().split("\n").at(-1);
      check(Number(own)>0&&cross==="0",`${table} nonempty own metadata and no cross-tenant metadata`);
    }
    denied=false;try{await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select request_hash from public.fan_import_batches;rollback;`)}catch(e){denied=/permission denied/.test(e.message)}check(denied,"CSV private content hash is not creator-readable");
    // An unscheduled newer wheel cannot override the explicit active wheel.
    const blankWheel=randomUUID();await sql(`insert into public.wheels(id,creator_id,title,is_active) values(${quote(blankWheel)},${quote(owner)},'New blank',false);`);
    check((await sql(`select public._resolved_spin_wheel(${quote(one.pass)});`)).trim()===newDefault,"new blank wheel never preempts flagged live wheel");
    await sql(`update public.wheels set active_until=now()+interval '1 hour' where id=${quote(blankWheel)};`);
    check((await sql(`select public._resolved_spin_wheel(${quote(one.pass)});`)).trim()===blankWheel,"open-start scheduled wheel takes precedence when its one bound is live");
    // Release BEFORE archive/delete cascades or delivery changes erase bindings.
    const archivePrize=randomUUID();await sql(`insert into public.prizes(id,wheel_id,label,weight,stock,boostable) values(${quote(archivePrize)},${quote(blankWheel)},'archive target',1,1,true);`);
    const archiveFan=await addFan(),archiveGrant=await rpc("grant_focus_pack",[quote(randomUUID()),quote(owner),quote(archiveFan.fan),quote(archiveFan.pass),quote(chasePack),quote(archivePrize)]);
    check(archiveGrant.status==="granted","archive lifecycle fixture reserves its actual target");
    await sql(`update public.wheels set archived_at=now() where id=${quote(blankWheel)};`);
    check((await sql(`select stock||','||(select status from public.fan_focus where id=${quote(archiveGrant.focus.id)}) from public.prizes where id=${quote(archivePrize)};`)).trim()==="1,released","wheel archive restores one held unit and releases promise");
    const deletePrize=randomUUID();await sql(`insert into public.prizes(id,wheel_id,label,weight,stock,boostable) values(${quote(deletePrize)},${quote(newDefault)},'delete target',1,1,true);`);
    const deleteFan=await addFan(),deleteGrant=await rpc("grant_focus_pack",[quote(randomUUID()),quote(owner),quote(deleteFan.fan),quote(deleteFan.pass),quote(chasePack),quote(deletePrize)]);
    await sql(`delete from public.prizes where id=${quote(deletePrize)};`);
    check((await sql(`select status||','||(prize_id is null) from public.fan_focus where id=${quote(deleteGrant.focus.id)};`)).trim()==="released,true","prize deletion releases before foreign-key anonymization");
    const deliveryPrize=randomUUID();await sql(`insert into public.prizes(id,wheel_id,label,weight,boostable) values(${quote(deliveryPrize)},${quote(newDefault)},'delivery target',1,true);`);
    await rpc("add_reward_codes",[quote(deliveryPrize),quote(owner),json([{cipher:"delivery-c",iv:"delivery-iv",key_version:1,hint:"test",fingerprint:hash(`delivery-${owner}`)}])]);
    const deliveryFan=await addFan(),deliveryGrant=await rpc("grant_focus_pack",[quote(randomUUID()),quote(owner),quote(deliveryFan.fan),quote(deliveryFan.pass),quote(chasePack),quote(deliveryPrize)]);
    await rpc("set_prize_delivery",[quote(deliveryPrize),quote(owner),quote("text"),quote("new-text-cipher"),quote("new-text-iv"),"1::smallint"]);
    check((await sql(`select stock||','||delivery||','||(select status from public.fan_focus where id=${quote(deliveryGrant.focus.id)}) from public.prizes where id=${quote(deliveryPrize)};`)).trim()==="1,text,released","leaving codes returns held unit once before unused-code deletion");
    // Creator receipts survive metadata changes and fan/grant erasure. Their
    // shared lock is also a cancellation barrier for an uncommitted request.
    const reconcile=(id,kind,{actor=owner,creator=owner,cancel=false,authorized=true}={})=>rpc("reconcile_creator_request",[quote(id),creator==null?"null":quote(creator),quote(actor),quote(kind),String(cancel),String(authorized)]);
    const journalRequest=randomUUID(),journalArgs=[quote(journalRequest),quote(owner),"null",quote(newDefault),quote("Journal fan"),"5","0","100","null"];
    const journalGrant=await rpc("create_pass_grant",journalArgs);
    const journalCommit=await reconcile(journalRequest,"pass");
    check(journalCommit.status==="committed"&&journalCommit.requestId===journalRequest&&journalCommit.kind==="pass"&&journalCommit.receipt.token===journalGrant.token,"authorized creator reconciles the exact committed request");
    await sql(`update public.fans set break_until=now()+interval '1 day' where id=${quote(journalGrant.fanId)};`);
    check((await rpc("create_pass_grant",journalArgs)).replayed,"lost creator success can replay after a fan starts a break without another grant");
    await sql(`update public.profiles set approval_status='pending' where id=${quote(owner)};`);
    const noPermission=await reconcile(journalRequest,"pass",{creator:null,authorized:false,cancel:true});
    check(noPermission.status==="committed"&&!('receipt' in noPermission)&&!JSON.stringify(noPermission).includes(journalGrant.token),"permission loss returns a bare committed receipt and cannot cancel a win");
    const deniedRequest=randomUUID(),deniedArgs=[quote(deniedRequest),quote(owner),"null",quote(newDefault),quote("Must be rejected"),"5","0","100","null"];
    check((await rpc("create_pass_grant",deniedArgs)).status==="unavailable","fresh unapproved creator cannot obtain credit");
    check((await reconcile(deniedRequest,"pass",{authorized:false})).status==="rejected","the rejected creator action has a durable matching terminal receipt");
    const cancelledRequest=randomUUID(),cancelledArgs=[quote(cancelledRequest),quote(owner),"null",quote(newDefault),quote("Never created"),"5","0","100","null"];
    check((await reconcile(cancelledRequest,"pass",{authorized:false,cancel:true})).status==="cancelled","own-account absent request can be cancelled after approval changes");
    await sql(`update public.profiles set approval_status='approved' where id=${quote(owner)};`);
    check((await rpc("create_pass_grant",cancelledArgs)).status==="cancelled","late original cannot commit after the cancellation receipt");
    check((await sql(`select count(*) from public.grants where id=${quote(cancelledRequest)};`)).trim()==="0","confirmed creator cancellation never mints a grant");
    const collisionKind=await reconcile(journalRequest,"grant");check(collisionKind.status==="conflict"&&collisionKind.kind==="grant"&&collisionKind.requestId===journalRequest,"wrong operation kind never receives a terminal receipt for another operation");
    await sql(`delete from public.fans where id=${quote(journalGrant.fanId)};`);
    check((await reconcile(journalRequest,"pass")).status==="gone","erasure changes independent creator receipt to gone");
    check((await rpc("create_pass_grant",journalArgs)).status==="gone","stale ordinary bootstrap after fan erasure never recreates its fan");
    // EDIT transport retries are economic intents, not fresh absolute writes.
    // An old successful20 edit must not overwrite a later intentional12 edit.
    const editable=await addFan(10),editGrant=(await sql(`select id from public.grants where fan_id=${quote(editable.fan)};`)).trim();
    const edit=(id,patch,{actor=owner,creator=owner,grant=editGrant}={})=>rpc("edit_pass_grant",[quote(id),quote(creator),quote(grant),json(patch),quote(actor)]);
    const firstEdit=randomUUID(),laterEdit=randomUUID();
    const edited20=await edit(firstEdit,{spins:20});
    check(edited20.status==="updated"&&!edited20.replayed&&edited20.balance===20&&edited20.grant.spins===20,"first durable edit commits the absolute grant and credit delta");
    check((await edit(laterEdit,{spins:12})).balance===12,"a distinct new edit intentionally changes total20 to12");
    const oldEditRetry=await edit(firstEdit,{spins:20});
    check(oldEditRetry.status==="updated"&&oldEditRetry.replayed&&oldEditRetry.balance===12&&oldEditRetry.grant.spins===12,"lost old edit reply replays its receipt with current terms and never reapplies8 credits");
    check((await sql(`select spins_remaining||','||(select spins from public.grants where id=${quote(editGrant)}) from public.fan_passes where id=${quote(editable.pass)};`)).trim()==="12,12","stale replay leaves both pass and grant at12");
    check((await edit(firstEdit,{spins:21})).status==="conflict","same edit identity with changed supplied patch conflicts");
    check((await edit(firstEdit,{spins:20,amountCents:0})).status==="conflict","an explicitly supplied field differs from an omitted field in the bound patch");
    const editHash=hash(canonical(["edit-grant-v1",owner,editGrant,{spins:20}]));
    check((await sql(`select request_hash from public.creator_request_journal where id=${quote(firstEdit)} and creator_id=${quote(owner)};`)).trim()===editHash,"SQL edit hash exactly matches independent JS canonical presence-only vector");
    const campaign=randomUUID();await sql(`insert into public.campaigns(id,creator_id,name) values(${quote(campaign)},${quote(owner)},'Edit campaign');`);
    const campaignEdit=await edit(randomUUID(),{amountCents:123,campaignId:campaign});
    check(campaignEdit.status==="updated"&&campaignEdit.grant.spins===12&&campaignEdit.grant.amountCents===123&&campaignEdit.grant.campaignId===campaign,"amount and campaign edit preserve omitted credit terms");
    const partialEdit=await edit(randomUUID(),{spins:11});
    check(partialEdit.grant.amountCents===123&&partialEdit.grant.campaignId===campaign&&partialEdit.balance===11,"spins-only edit preserves latest omitted amount and campaign");
    const clearEdit=await edit(randomUUID(),{campaignId:null});
    check(clearEdit.grant.campaignId===null&&clearEdit.grant.amountCents===123&&clearEdit.grant.spins===11,"explicit null clears campaign without changing other terms");
    const emptyEdit=await edit(randomUUID(),{});
    check(emptyEdit.status==="updated"&&emptyEdit.balance===11,"present-only empty edit preserves all locked current terms");
    for(const patch of [{spins:-1},{spins:1.5},{spins:null},{amountCents:-1},{amountCents:100000001},{campaignId:"invalid"},{bonusSpins:999}]) {
      const badId=randomUUID(),bad=await edit(badId,patch);
      check(bad.status==="invalid"&&(await reconcile(badId,"edit")).status==="rejected","malformed edit is rejected durably before economic mutation");
    }
    check((await sql(`select spins_remaining from public.fan_passes where id=${quote(editable.pass)};`)).trim()==="11","invalid edits leave credit unchanged");
    const cancelledEdit=randomUUID();
    check((await reconcile(cancelledEdit,"edit",{cancel:true})).status==="cancelled","absent edit cancellation records an actor-bound fence");
    check((await edit(cancelledEdit,{spins:99})).status==="cancelled","delayed edit cannot execute after confirmed cancellation");
    const crossEdit=randomUUID();
    check((await edit(crossEdit,{spins:99},{actor:other})).status==="unavailable","actual unauthorized actor cannot edit creator credit through service gateway");
    check((await reconcile(crossEdit,"edit",{actor:other,authorized:false})).status==="rejected","refused actor has only its exact rejected edit outcome");
    let editDenied=false;try{await sql(`set role service_role;select public.edit_pass_grant(${quote(owner)},${quote(editGrant)},99,0,0);`)}catch(e){editDenied=/permission denied/.test(e.message)}
    check(editDenied,"service cannot bypass journal by calling the retired no-identity edit overload");
    check((await sql(`select has_function_privilege('service_role','public._edit_grant_patch_core(uuid,uuid,jsonb)','execute');`)).trim()==="f","service cannot bypass journal by calling private patch core");
    const raceEditId=randomUUID(),racePatch={spins:17};
    const editArgs=[quote(raceEditId),quote(owner),quote(editGrant),json(racePatch),quote(owner)];
    const editOriginal=sql(`begin;select public.edit_pass_grant(${editArgs.join(",")});select pg_sleep(0.4);commit;`);
    let editSleeping=false;for(let i=0;i<100;i++){if((await sql(`select count(*) from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like '%${raceEditId}%';`)).trim()==="1"){editSleeping=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
    check(editSleeping,"edit race barrier observes its original transaction after uncommitted mutation");
    const editWaited=await reconcile(raceEditId,"edit",{cancel:true});await editOriginal;
    check(editWaited.status==="committed"&&editWaited.receipt.grant.spins===17,"edit cancellation waits for original commit and never reports false cancellation");
    const simultaneousId=randomUUID(),simultaneous=await Promise.all(Array.from({length:8},()=>edit(simultaneousId,{spins:18})));
    check(simultaneous.every(v=>v.status==="updated")&&simultaneous.filter(v=>!v.replayed).length===1,"eight concurrent same-ID edits apply exactly one credit delta");
    check((await sql(`select spins_remaining from public.fan_passes where id=${quote(editable.pass)};`)).trim()==="18","concurrent edit replay preserves the correct absolute balance");
    await sql(`update public.profiles set approval_status='pending' where id=${quote(owner)};`);
    const editPermissionLost=await reconcile(firstEdit,"edit",{authorized:false});
    check(editPermissionLost.status==="committed"&&editPermissionLost.authorized===false&&!('receipt' in editPermissionLost),"lost edit permission returns bare committed outcome without mutable grant terms");
    check((await edit(firstEdit,{spins:20})).status==="unavailable","lost permission cannot fetch an edit receipt through original mutation");
    const deniedEditId=randomUUID();check((await edit(deniedEditId,{spins:99})).status==="unavailable","pending creator cannot accept a new grant edit");
    await sql(`update public.profiles set approval_status='approved' where id=${quote(owner)};`);
    check((await edit(deniedEditId,{spins:99})).status==="rejected","reapproval cannot resurrect a durably refused edit UUID");
    await sql(`delete from public.fans where id=${quote(editable.fan)};`);
    check((await reconcile(firstEdit,"edit")).status==="gone"&&(await edit(firstEdit,{spins:20})).status==="gone","fan erasure tombstones committed edits and stale retries never recreate credit");
    // Grant-capable agency actors bind to their accepted request. Revocation
    // preserves outcome metadata while preventing token/receipt disclosure.
    const org=randomUUID();await sql(`insert into public.orgs(id,name,owner_id) values(${quote(org)},'journal org',${quote(owner)});update public.profiles set org_id=${quote(org)} where id=${quote(owner)};insert into public.org_members(org_id,profile_id,role) values(${quote(org)},${quote(other)},'manager');`);
    const agencyRequest=randomUUID(),agencyArgs=[quote(agencyRequest),quote(owner),"null",quote(newDefault),quote("Agency fan"),"5","0","100","null","null","null","1",quote(other)];
    const agencyGrant=await rpc("create_pass_grant",agencyArgs);check(agencyGrant.status==="granted","current agency manager can create an accepted journaled grant");
    const agencyEditId=randomUUID(),agencyEdit=await edit(agencyEditId,{spins:7},{actor:other,grant:agencyGrant.grantId});
    check(agencyEdit.status==="updated"&&agencyEdit.balance===7,"currently authorized agency actor can execute an actor-bound edit");
    check((await edit(agencyEditId,{spins:7},{actor:owner,grant:agencyGrant.grantId})).status==="conflict","another authorized actor cannot replay a different actor's same UUID receipt");
    const cancelTarget=randomUUID(),cancelFan=await addFan();
    await sql(`insert into public.prizes(id,wheel_id,label,weight,boostable,stock) values(${quote(cancelTarget)},${quote(newDefault)},'Cancel reserved target',1,true,1);`);
    const cancelHeld=await rpc("grant_focus_pack",[quote(randomUUID()),quote(owner),quote(cancelFan.fan),quote(cancelFan.pass),quote(chasePack),quote(cancelTarget),quote(owner)]);
    check(cancelHeld.status==="granted"&&(await sql(`select state from public.chase_reservations where focus_id=${quote(cancelHeld.focus.id)};`)).trim()==="held","revocation fixture holds a real paid chase unit");
    check((await sql(`select public._creator_actor_grant_allowed(${quote(other)},${quote(owner)});`)).trim()==="t","agency actor had cancellation permission when its route began");
    // Hold the same fan row while revocation commits, so an already-dispatched
    // cancellation waits and must check permission AFTER acquiring that lock.
    const revoker=sql(`begin;select 1 from public.fans where id=${quote(cancelFan.fan)} for update;delete from public.org_members where org_id=${quote(org)} and profile_id=${quote(other)};select pg_sleep(0.4);commit;`);
    let revocationSleeping=false;for(let i=0;i<100;i++){if((await sql(`select count(*) from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like '%${cancelFan.fan}%';`)).trim()==="1"){revocationSleeping=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
    check(revocationSleeping,"focus cancellation race barrier observes pending agency revocation under fan lock");
    const revokedCancel=await rpc("cancel_fan_focus",[quote(owner),quote(cancelFan.fan),quote(cancelHeld.focus.id),quote(other)]);await revoker;
    check(revokedCancel.status==="unavailable","already-dispatched cancellation rechecks and refuses the now-revoked actual actor");
    check((await sql(`select state||','||(select stock from public.prizes where id=${quote(cancelTarget)}) from public.chase_reservations where focus_id=${quote(cancelHeld.focus.id)};`)).trim()==="held,0","revoked cancellation leaves reservation held and free stock unchanged");
    let oldCancelDenied=false;try{await sql(`set role service_role;select public.cancel_fan_focus(${quote(owner)},${quote(cancelFan.fan)},${quote(cancelHeld.focus.id)});`)}catch(e){oldCancelDenied=/permission denied/.test(e.message)}
    check(oldCancelDenied,"actorless service cancellation cannot bypass the transactional permission check");
    check((await rpc("cancel_fan_focus",[quote(owner),quote(cancelFan.fan),quote(cancelHeld.focus.id),quote(owner)])).status==="released","current owner can still cancel the exact paid promise");
    check((await rpc("cancel_fan_focus",[quote(owner),quote(cancelFan.fan),quote(cancelHeld.focus.id),quote(owner)])).status==="absent"&&(await sql(`select stock from public.prizes where id=${quote(cancelTarget)};`)).trim()==="1","authorized repeat cancellation returns the held stock exactly once");
    await sql(`delete from public.org_members where org_id=${quote(org)} and profile_id=${quote(other)};`);
    const agencyOutcome=await reconcile(agencyRequest,"pass",{actor:other,creator:null,authorized:true});
    check(agencyOutcome.status==="committed"&&agencyOutcome.authorized===false&&!('receipt' in agencyOutcome)&&!JSON.stringify(agencyOutcome).includes(agencyGrant.token),"revoked original agency actor sees only bare outcome even if service caller claims authorization");
    const foreignAbsent=randomUUID();check((await reconcile(foreignAbsent,"pass",{actor:other,creator:null,cancel:true,authorized:false})).status==="cancelled","revoked actor can withdraw only its own opaque UUID without a target");
    check((await sql(`select count(*) from public.creator_request_journal where id=${quote(foreignAbsent)};`)).trim()==="0","opaque actor cancellation creates no foreign creator journal row");
    const withdrawnArgs=[quote(foreignAbsent),quote(owner),"null",quote(newDefault),quote("Withdrawn agency fan"),"5","0","100","null","null","null","1",quote(other)];
    check((await rpc("create_pass_grant",withdrawnArgs)).status==="cancelled","actor fence rejects its delayed foreign-target original before any write");
    const anotherActor=await rpc("create_pass_grant",[quote(foreignAbsent),quote(owner),"null",quote(newDefault),quote("Different actor fan"),"5","0","100","null"]);
    check(anotherActor.status==="granted","one actor's withdrawal never blocks another actor's same UUID");
    const scopedId=randomUUID();check((await reconcile(scopedId,"pass",{actor:other,creator:other,cancel:true})).status==="cancelled","another account can cancel its own scoped UUID only");
    const scopedGrant=await rpc("create_pass_grant",[quote(scopedId),quote(owner),"null",quote(newDefault),quote("Independent creator scope"),"5","0","100","null"]);
    check(scopedGrant.status==="granted","own-account cancellation cannot block another creator using the same UUID");
    // Start an original TX, wait until its receipt is written but uncommitted,
    // then cancel from another session. Cancellation must wait, observe commit
    // and return committed, rather than reporting a false successful cancel.
    const lockedRequest=randomUUID(),lockedArgs=[quote(lockedRequest),quote(owner),"null",quote(newDefault),quote("Uncommitted creator fan"),"5","0","100","null"];
    const original=sql(`begin;select public.create_pass_grant(${lockedArgs.join(",")});select pg_sleep(0.4);commit;`);
    let sleeping=false;for(let i=0;i<100;i++){if((await sql(`select count(*) from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like '%${lockedRequest}%';`)).trim()==="1"){sleeping=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
    check(sleeping,"creator race barrier observes the original uncommitted transaction");
    const waited=await reconcile(lockedRequest,"pass",{cancel:true});await original;
    check(waited.status==="committed","cancellation waits on shared advisory lock and observes an in-flight commit");
    check((await rpc("create_pass_grant",lockedArgs)).replayed&&(await sql(`select count(*) from public.grants where id=${quote(lockedRequest)};`)).trim()==="1","late retry after reconciliation still recovers exactly one grant");
    denied=false;try{await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select request_hash,grant_id,batch_id from public.creator_request_journal;rollback;`)}catch(e){denied=/permission denied/.test(e.message)}check(denied,"creator journal hashes and business references are not browser-readable");
    const actorFences=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(other)},true);select count(*) from public.actor_request_cancellations where actor_id=${quote(other)};rollback;`)).trim().split("\n").at(-1);
    const foreignFences=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);select count(*) from public.actor_request_cancellations where actor_id=${quote(other)};rollback;`)).trim().split("\n").at(-1);
    check(Number(actorFences)>0&&foreignFences==="0","actor cancellation fences are readable only by their actor or an aal2 admin");
    const formerActor=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(other)},true);select state from public.creator_request_journal where id=${quote(agencyRequest)};rollback;`)).trim().split("\n").at(-1);
    check(formerActor==="committed","former agency actor can read only its accepted action metadata through RLS");
    check((await sql(`select bool_and(f.spins_remaining=(select coalesce(sum(p.spins_remaining),0) from public.fan_passes p where p.fan_id=f.id and p.is_active)) from public.fans f where creator_id=${quote(owner)};`)).trim()==="t","fan totals equal authoritative active-pass sums");
    console.log(`PASS 0059 ${checks} economic/RLS checks: prep, atomic manual/code receipts, replay, stale context, credit grants, focus/break, concrete chase reservation, erasure/dedup, concurrent grants and release`);
    return checks;
  } finally { await Promise.allSettled([...pending]); await sql(`delete from auth.users where id in(${quote(owner)},${quote(other)});`); }
}
