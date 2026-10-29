// Disposable PostgreSQL probe. Real pure engine generation comes through a
// bounded stdin bridge; this test does not duplicate production RNG/math.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {readFileSync} from "node:fs";
const quote=s=>`'${String(s).replaceAll("'","''")}'`,json=v=>`${quote(JSON.stringify(v))}::jsonb`;
const hash=s=>createHash("sha256").update(s).digest("hex");
export async function probeScratchGames(sql) {
 let checks=0;const check=(v,label)=>{checks++;if(!v)throw Error(`0060 ${label}`);};
 const pending=new Set();const query=q=>{const p=sql(q);pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
 const rpc=async(name,args)=>JSON.parse((await query(`select public.${name}(${args.join(",")});`)).trim()||"null");
 const root=join(import.meta.dirname,"../.."),fixture=spawn("npx",["tsx","scripts/db/scratchProofFixture.ts"],{cwd:root,stdio:["pipe","pipe","pipe"]});
 const waiters=[];let fixtureError="";fixture.stderr.on("data",b=>fixtureError+=b);
 fixture.on("error",e=>{for(const w of waiters.splice(0))w.reject(e);});
 fixture.on("exit",code=>{for(const w of waiters.splice(0))w.reject(Error(`Scratch fixture exited ${code}: ${fixtureError}`));});
 const lines=createInterface({input:fixture.stdout});lines.on("line",line=>{const w=waiters.shift();if(!w)return;try{const v=JSON.parse(line);if(!v.ok)throw Error(v.error);w.resolve(v.value);}catch(e){w.reject(e);}});
 const generate=(context,excluded=[])=>new Promise((resolve,reject)=>{waiters.push({resolve,reject});fixture.stdin.write(JSON.stringify({context,excluded})+"\n");});
 const owner=randomUUID(),other=randomUUID(),wheel=randomUUID(),prize=randomUUID(),plain=randomUUID();
 const refused=async(q,pattern)=>{try{await query(q);return false;}catch(e){if(pattern&&!pattern.test(e.message))throw Error(`Unexpected SQL refusal: ${e.message}`);return true;}};
 try {
  const vectors=JSON.parse(readFileSync(new URL("../../src/lib/games/scratch/visibleIdentity.vectors.json",import.meta.url),"utf8"));
  const actual=JSON.parse((await query(`select jsonb_agg(public._scratch_visible(x->>'input') order by n) from jsonb_array_elements(${json(vectors)}) with ordinality v(x,n);`)).trim());
  for(let i=0;i<vectors.length;i++)check(actual[i]===vectors[i].expected,`JS/SQL pinned visible identity vector ${i}`);
  // Vanilla stub omits Supabase default table grants: reproduce them here so
  // these negatives exercise RLS/feature guards rather than missing privilege.
  await query(`grant select,insert,update,delete on public.wheels,public.wheel_templates to authenticated,anon;`);
  await query(`insert into auth.users(id,email) values(${quote(owner)},'scratch-a-${owner}@example.test'),(${quote(other)},'scratch-b-${other}@example.test');update public.profiles set is_active=true,approval_status='approved' where id in(${quote(owner)},${quote(other)});`);
  check(await refused(`insert into public.wheels(creator_id,game_kind,game_config) values(${quote(owner)},'scratch','{"style":"classic"}');`,/feature_disabled/),"service-level INSERT cannot bypass disabled scratch feature");
  check(await refused(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(owner)},true);insert into public.wheels(creator_id,game_kind,game_config) values(${quote(owner)},'scratch','{"style":"classic"}');commit;`,/feature_disabled/),"approved creator cannot insert scratch before server feature enablement");
  check(await refused(`insert into public.wheel_templates(creator_id,name,game_kind,game_config) values(${quote(owner)},'forged','scratch','{"style":"classic"}');`,/feature_disabled/),"templates and imported configuration cannot bypass disabled feature");
  await query(`update public.profiles set features=features||'{"scratch":true,"bingo":true}'::jsonb where id=${quote(owner)};
   insert into public.wheels(id,creator_id,title,game_kind,game_config,is_active) values(${quote(wheel)},${quote(owner)},'Scratch PG','scratch','{"style":"classic"}',true);
   insert into public.prizes(id,wheel_id,label,rarity,weight,emoji,sort_order) values(${quote(prize)},${quote(wheel)},'İ','common',1,'🎁',0),(${quote(plain)},${quote(wheel)},'i','common',0,'🟦',1);`);
  for(const config of ['{}','{"style":"other"}','{"style":"classic","secret":"bad"}'])check(await refused(`update public.wheels set game_config=${quote(config)}::jsonb where id=${quote(wheel)};`,/invalid_game_config/),"unknown/extra scratch config fails closed");
  check(await refused(`insert into public.wheels(creator_id,game_kind,game_config) values(${quote(owner)},'bingo','{"size":3,"linePrizeId":null}');`,/game_unavailable/),"bingo unavailable in0060 even with server feature true");
  check(await refused(`insert into public.wheels(creator_id,game_kind) values(${quote(owner)},'unknown');`,/invalid_game_config/),"unknown game kind refused at SQL boundary");
  check(await refused(`update public.wheels set game_ready=false where id=${quote(wheel)};`,/invalid_game_config/),"wheel/scratch cannot masquerade as an inactive bingo draft");
  await query(`insert into public.wheel_templates(creator_id,name,game_kind,game_config) values(${quote(owner)},'valid scratch','scratch','{"style":"classic"}');`);
  const addFan=async(spins=10)=>{
   const id=randomUUID(),out=await rpc("create_pass_grant",[quote(id),quote(owner),"null",quote(wheel),quote("Scratch fixture"),String(spins),"0","0","null"]);
   check(out.status==="granted","fixture fan credited through real durable bootstrap");
   await query(`update public.fans set acked_at=now(),acked_terms_version='2026-10-27' where id=${quote(out.fanId)};`);
   return{fan:out.fanId,pass:out.passId,token:out.token};
  };
  const prep=async who=>{const id=randomUUID(),binding=hash(id),v=await rpc("prepare_spin_attempt",[quote(id),quote(who.token),quote(binding)]);check(v.status==="ready"&&v.context.wheel.game_kind==="scratch","prepare derives scratch from authoritative wheel");return{id,binding,...v};};
  const build=async(a,excluded=[])=>{
   const g=await generate(a.context,excluded),d=g.primary,p=a.context.prizes.find(x=>x.id===d.prize.id),n=randomUUID().replaceAll("-","").repeat(2);
   const spin={id:a.id,fan_id:a.context.fanId,fan_pass_id:a.context.passId,creator_id:owner,wheel_id:wheel,campaign_id:a.context.campaignId,server_seed:a.context.serverSeed,server_seed_hash:a.context.serverSeedHash,nonce:a.context.nonce,client_seed:"scratch-pg-fixture",fair_version:3,game_kind:"scratch",presentation:g.presentation,pool_snapshot:g.snapshot,pool_hash:g.poolHash,fair_trace:g.trace,
    prize_id:p.id,prize_label:p.label,prize_rarity:p.rarity,prize_image_url:p.image_url,next_pity_counter:d.nextPityCounter,focus_consumed:d.focusConsumed??false,chase_consumed:d.chaseConsumed??false,chase_completed:d.chaseCompleted??false,next_focus_spins_left:d.nextFocusSpinsLeft??null,next_chase_counter:d.nextChaseCounter??null,response_prize:{id:p.id,label:p.label,rarity:p.rarity,weight:p.weight},response_prize_index:a.context.prizes.findIndex(x=>x.id===p.id),response_show_stock:a.context.wheel.show_stock};
   let expected={delivery:p.delivery};
   if(p.delivery==="codes")expected=JSON.parse((await query(`select jsonb_build_object('delivery','codes','codeId',id,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_reward_codes where prize_id=${quote(p.id)} and spin_id is null and reserved_focus_id is null order by id limit1;`.replace('limit1','limit 1'))).trim()||"null");
   else if(["text","link"].includes(p.delivery))expected=JSON.parse((await query(`select jsonb_build_object('delivery',kind,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_rewards where prize_id=${quote(p.id)};`)).trim());
   return{spin,expected,next:{seed:n,hash:hash(n)},context:{contextHash:a.context.contextHash},generated:g};
  };
  const commit=(who,a,b)=>rpc("commit_spin_attempt",[quote(a.id),quote(who.token),quote(a.binding),json(b.context),json(b.spin),json(b.expected),json(b.next)]);
  const fan=await addFan(),a=await prep(fan),b=await build(a);
  check(b.generated.trace.bonuses.length===0&&b.generated.presentation.cells.filter(x=>x.id===prize).length===3,"actual full-hash pure RNG yields the single winning triple");
  check(b.generated.presentation.cells.some(c=>c.label==="İ")&&b.generated.presentation.cells.some(c=>c.label==="i"),"pinned Unicode preserves dotted-I and ASCII-i in an actual paid face");
  const race=await Promise.all(Array.from({length:20},()=>commit(fan,a,b)));
  check(race.every(x=>x.status==="committed")&&race.filter(x=>!x.replayed).length===1,"twenty same-attempt scratch retries commit only one paid play");
  check(new Set(race.map(x=>JSON.stringify(x.presentation))).size===1&&race.every(x=>x.gameKind==="scratch"&&x.bonusWins.length===0),"all retries return the exact immutable scratch face and no bonuses");
  check((await query(`select spins_remaining||','||next_spin_nonce||','||(select count(*) from public.spins where fan_id=${quote(fan.fan)})||','||(select count(*) from public.redemptions where spin_id=${quote(a.id)}) from public.fan_passes where id=${quote(fan.pass)};`)).trim()==="9,1,1,1","one debit/nonce/spin/redemption for twenty retries");
  check(await refused(`update public.wheels set game_kind='wheel',game_config='{}' where id=${quote(wheel)};`,/game_kind_locked/),"game kind cannot change after first credited play");
  check(await refused(`update public.spins set presentation='{}' where id=${quote(a.id)};`,/immutable/),"service cannot mutate an already committed scratch face");
  check(await refused(`update public.spins set pool_hash=repeat('0',64) where id=${quote(a.id)};`,/immutable/),"service cannot rewrite a committed scratch proof fingerprint");
  const recovered=await rpc("get_spin_attempt_status",[quote(a.id),quote(fan.token),quote(a.binding)]);
  check(recovered.replayed&&JSON.stringify(recovered.presentation)===JSON.stringify(race[0].presentation),"lost response status recovers exact face with no second allocation");
  const broken=await addFan(),ba=await prep(broken),bb=await build(ba);
  for(const mutate of [s=>{s.game_kind="wheel";},s=>{s.pool_snapshot.gameConfig={style:"other"};},s=>{s.presentation.cells[0].label="Forged";},s=>{const i=s.presentation.cells.findIndex(x=>x.id!==s.prize_id);s.presentation.cells[i]={...s.presentation.cells.find(x=>x.id===s.prize_id)};},s=>{s.fair_trace.bonuses=[{line:0,won:prize,excluded:[]}];}]) {
   const bad=structuredClone(bb);mutate(bad.spin);
   check(await refused(`select public.commit_spin_attempt(${[quote(ba.id),quote(broken.token),quote(ba.binding),json(bad.context),json(bad.spin),json(bad.expected),json(bad.next)].join(",")});`),"forged game context/config/face/bonus rejected before debit");
  }
  check((await query(`select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${quote(broken.pass)};`)).trim()==="10,0","all malformed scratch attempts preserve credit and seed nonce");
  await query(`create function public._scratch_probe_fault() returns trigger language plpgsql as $$begin raise exception 'injected scratch redemption failure';end $$;create trigger zz_scratch_probe_fault before insert on public.redemptions for each row execute function public._scratch_probe_fault();`);
  check(await refused(`select public.commit_spin_attempt(${[quote(ba.id),quote(broken.token),quote(ba.binding),json(bb.context),json(bb.spin),json(bb.expected),json(bb.next)].join(",")});`,/injected scratch redemption failure/),"injected last receipt failure reaches real scratch transaction");
  check((await query(`select spins_remaining||','||next_spin_nonce||','||(select count(*) from public.spins where id=${quote(ba.id)})||','||(select state from public.spin_attempts where id=${quote(ba.id)}) from public.fan_passes where id=${quote(broken.pass)};`)).trim()==="10,0,0,pending","receipt failure rolls debit/nonce/face back to wholly pending");
  await query(`drop trigger zz_scratch_probe_fault on public.redemptions;drop function public._scratch_probe_fault();`);
  check((await commit(broken,ba,bb)).status==="committed","same failed identity recovers once SQL fault is removed");
  // Codes use the same scratch commit, including rollback after assignment
  // and actual concurrent allocation of the last five encrypted stock rows.
  const codes=Array.from({length:5},(_,i)=>({cipher:`scratch-cipher-${i}`,iv:`scratch-iv-${i}`,key_version:1,hint:`s${i}`,fingerprint:hash(`scratch-${owner}-${i}`)}));
  check(await rpc("add_reward_codes",[quote(prize),quote(owner),json(codes)])===5,"scratch code fixture has five encrypted unique stock units");
  const codeFaultFan=await addFan(),codeFaultAttempt=await prep(codeFaultFan),codeFaultBody=await build(codeFaultAttempt);
  await query(`create function public._scratch_probe_fault() returns trigger language plpgsql as $$begin raise exception 'injected scratch redemption failure';end $$;create trigger zz_scratch_probe_fault before insert on public.redemptions for each row execute function public._scratch_probe_fault();`);
  check(await refused(`select public.commit_spin_attempt(${[quote(codeFaultAttempt.id),quote(codeFaultFan.token),quote(codeFaultAttempt.binding),json(codeFaultBody.context),json(codeFaultBody.spin),json(codeFaultBody.expected),json(codeFaultBody.next)].join(",")});`,/injected scratch redemption failure/),"instant scratch failure occurs after concrete code allocation");
  check((await query(`select stock||','||(select count(*) from public.prize_reward_codes where prize_id=${quote(prize)} and spin_id is null)||','||(select spins_remaining from public.fan_passes where id=${quote(codeFaultFan.pass)})||','||(select count(*) from public.spins where id=${quote(codeFaultAttempt.id)}) from public.prizes where id=${quote(prize)};`)).trim()==="5,5,10,0","instant fault rolls back code assignment/free stock/credit/proof together");
  await query(`drop trigger zz_scratch_probe_fault on public.redemptions;drop function public._scratch_probe_fault();`);
  const contenders=[];for(let i=0;i<12;i++){const who=await addFan(),attempt=await prep(who);contenders.push({who,attempt,body:await build(attempt)});}
  const codeReplies=await Promise.all(contenders.map(async c=>{
   for(let round=0;round<8;round++){
    const reply=await commit(c.who,c.attempt,c.body);
    if(reply.status!=="changed")return reply;
    const candidate=JSON.parse((await query(`select jsonb_build_object('delivery','codes','codeId',id,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_reward_codes where prize_id=${quote(prize)} and spin_id is null and reserved_focus_id is null order by id limit 1;`)).trim()||"null");
    if(candidate)c.body.expected=candidate;
   }
   throw Error("bounded scratch code allocation did not settle");
  }));
  check(codeReplies.filter(x=>x.status==="committed").length===5&&codeReplies.filter(x=>x.status==="sold_out").length===7,"twelve actual scratch proofs compete for five codes with exactly five commits");
  check((await query(`select stock||','||(select count(distinct spin_id) from public.prize_reward_codes where prize_id=${quote(prize)} and spin_id is not null)||','||(select sum(spins_remaining) from public.fan_passes where id in(${contenders.map(c=>quote(c.who.pass)).join(",")})) from public.prizes where id=${quote(prize)};`)).trim()==="0,5,115","five distinct instant scratch wins cost exactly five of120 credited spins");
  const winnerIndex=codeReplies.findIndex(x=>x.status==="committed"),won=contenders[winnerIndex],wonReply=codeReplies[winnerIndex];
  check(wonReply.reward.kind==="code"&&wonReply.stockAfter>=0&&isDeepStrictEqual(wonReply.presentation,won.body.spin.presentation),"code winner receives its exact same immutable scratch face and private reward receipt");
  check((await commit(won.who,won.attempt,won.body)).replayed,"instant code scratch replay cannot allocate a second code");
  // Once free stock disappears, rebuild the same proof from preparation after
  // the context retry. The zero-weight unlimited fallback remains a valid win.
  await query(`update public.profiles set features=features||'{"scratch":false}'::jsonb where id=${quote(owner)};update public.wheels set title='Still editable',game_config='{"style":"classic"}' where id=${quote(wheel)};`);
  const grandfather=await addFan(),ga=await prep(grandfather),gb=await build(ga);
  check((await commit(grandfather,ga,gb)).status==="committed","feature removal preserves existing paid scratch links and same-kind edits");
  check(await refused(`insert into public.wheels(creator_id,title,game_kind,game_config) select creator_id,title,game_kind,game_config from public.wheels where id=${quote(wheel)};`,/feature_disabled/),"duplicating a grandfathered game cannot create a new disabled feature");
  check(await refused(`insert into public.wheel_templates(creator_id,name,game_kind,game_config) select creator_id,'new disabled template',game_kind,game_config from public.wheels where id=${quote(wheel)};`,/feature_disabled/),"new templates cannot smuggle grandfathered disabled feature");
  for(const state of ["pending","rejected","inactive"]){
   await query(`update public.profiles set approval_status=${quote(state==="inactive"?"approved":state)},is_active=${state!=="inactive"} where id=${quote(owner)};`);
   check(await refused(`update public.wheels set game_config='{"style":"classic"}' where id=${quote(wheel)};`,/creator_unavailable/),"pending/rejected/inactive owners cannot write scratch settings through service bypass");
  }
  await query(`update public.profiles set approval_status='approved',is_active=true,features=features||'{"scratch":"true"}'::jsonb where id=${quote(owner)};`);
  check(await refused(`insert into public.wheels(creator_id,game_kind,game_config) values(${quote(owner)},'scratch','{"style":"classic"}');`,/feature_disabled/),"string-valued feature metadata never authorizes a scratch game");
  await query(`update public.profiles set features=features||'{"scratch":false}'::jsonb where id=${quote(owner)};`);
  check(await refused(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${quote(other)},true);insert into public.wheels(creator_id,game_kind,game_config) values(${quote(owner)},'scratch','{"style":"classic"}');commit;`),"cross-tenant creator cannot create another owner's game");
  check(await refused(`begin;set local role anon;insert into public.wheels(creator_id) values(${quote(owner)});commit;`),"anonymous game creation refused");
  for(const name of ["_game_feature_allowed","_guard_game_settings","_scratch_visible","_valid_scratch_presentation","_guard_immutable_game_proof"])check((await query(`select bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('service_role',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${quote(name)};`)).trim()==="t",`${name} is private to the atomic/trigger boundary`);
  await query(`delete from public.fans where id=${quote(fan.fan)};`);
  check((await query(`select (fan_id is null)::text||','||game_kind||','||(presentation is not null)::text from public.spins where id=${quote(a.id)};`)).trim()==="true,scratch,true","erasure retains anonymous public scratch proof without personal fan binding");
  console.log(`PASS 0060 ${checks} scratch checks: actual pure RNG proof/face, atomic20-retry replay, negatives, immutable proof, feature gates/templates, rollback, grandfathered links and erasure`);
 }finally{
  fixture.stdin.end();await Promise.allSettled([...pending]);
  await query(`drop trigger if exists zz_scratch_probe_fault on public.redemptions;drop function if exists public._scratch_probe_fault();delete from auth.users where id in(${quote(owner)},${quote(other)});`);
 }
}
