import {probeCreatorActorRoute} from "./creatorActorRouteProbe.mjs";
// Real authenticated-session -> server-only gateway regressions. Local PG only.
import {randomUUID} from 'node:crypto';
import {mintActorContext,sqlQuote as q} from './actorContextFixture.mjs';
export async function probeCreatorActorContexts(sql) {
 let checks=0;const check=(ok,msg)=>{checks++;if(!ok)throw Error(`0062 actor context: ${msg}`);};
 const a=randomUUID(),b=randomUUID(),w=randomUUID(),fan=randomUUID(),pass=randomUUID();
 const contexts=[];const mint=async(actor=a,creator=a,scope='grant',aal='aal1')=>{const c=await mintActorContext(sql,actor,creator,scope,aal);contexts.push(c.context);return c;};
 const gateway=async(c,request=randomUUID(),actor=a,creator=a)=>JSON.parse((await sql(`begin;set local role service_role;select public.grant_pass_spins(${q(c)},${q(request)},${q(creator)},${q(fan)},${q(pass)},1,0,0,null,${q(actor)});commit;`)).trim());
 const balance=async()=>Number((await sql(`select spins_remaining from public.fan_passes where id=${q(pass)};`)).trim());
 const refused=async(statement,pattern=/permission denied|authenticated session required|actor context limit/)=>{try{await sql(statement);return false;}catch(e){if(!pattern.test(e.message))throw e;return true;}};
 const lowClaims=(actor,sid,exp=Math.floor(Date.now()/1000)+3600)=>JSON.stringify({sub:actor,role:'authenticated',aal:'aal1',session_id:sid,exp});
 const auth=(actor,claims,body)=>`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claim.sub',${q(actor)},true);perform set_config('request.jwt.claims',${q(claims)},true);end$$;${body};commit;`;
 try {
  await sql(`insert into auth.users(id,email) values(${q(a)},'context-${a}@example.test'),(${q(b)},'context-${b}@example.test');update public.profiles set is_active=true,approval_status='approved' where id in(${q(a)},${q(b)});insert into public.wheels(id,creator_id,title) values(${q(w)},${q(a)},'Context');insert into public.fans(id,creator_id,acked_at) values(${q(fan)},${q(a)},now());insert into public.fan_passes(id,creator_id,fan_id,wheel_id,token) values(${q(pass)},${q(a)},${q(fan)},${q(w)},'context-${pass}');`);
  let c=await mint();check((await gateway(c.context)).status==='granted'&&await balance()===1,'ordinary optional-MFA creator succeeds through authenticated mint and actual service gateway');
  await sql(`insert into auth.mfa_factors(user_id,status) values(${q(a)},'verified');`);
  c=await mint(a,a,'grant','aal2');const id=randomUUID();
  check((await gateway(c.context,id)).status==='granted'&&await balance()===2,'actual signed aal2 context survives separate service JWT and credits once');
  const fresh=await mint(a,a,'grant','aal2');check((await gateway(fresh.context,id)).replayed===true&&await balance()===2,'same economic UUID with freshly minted context replays without another award');
  let low=await mint();check((await gateway(low.context)).status==='unavailable'&&await balance()===2,'verified-factor aal1 context cannot authorize business mutation');
  await sql(`delete from auth.mfa_factors where user_id=${q(a)};`);low=await mint();await sql(`insert into auth.mfa_factors(user_id,status) values(${q(a)},'verified');`);
  check((await gateway(low.context)).status==='unavailable'&&await balance()===2,'factor verified after aal1 mint invalidates business authorization at mutation');
  for(const [label,context,actor,creator] of [['other actor',fresh.context,b,a],['other creator',fresh.context,a,b],['guessed capability',randomUUID(),a,a]])check((await gateway(context,randomUUID(),actor,creator)).status==='unavailable'&&await balance()===2,label+' refused before journal or credit');
  const wrongScope=await mint(a,a,'edit_wheel','aal2');check((await gateway(wrongScope.context)).status==='unavailable','edit-only capability cannot grant');
  await sql(`update auth.users set raw_user_meta_data='{"aal":"aal2","role":"admin","mfa_verified":true}' where id=${q(a)};`);
  check(JSON.parse((await sql(`begin;select set_config('request.jwt.claims','{"aal":"aal2","role":"service_role"}',true);select set_config('fanfunnel.mfa_authorized','true',true);set local role service_role;select public.grant_pass_spins(${q(low.context)},${q(randomUUID())},${q(a)},${q(fan)},${q(pass)},1,0,0,null,${q(a)});commit;`)).trim().split('\n').at(-1)).status==='unavailable','forged request claims/GUC/metadata cannot upgrade stored aal1 provenance');
  check((await sql(`select public._creator_actor_grant_allowed(${q(a)},${q(a)})||','||public._game_actor_edit_allowed(${q(a)},${q(a)});`)).trim()==='false,false','old private impersonation helpers always fail closed');
  for(const role of ['anon','authenticated','service_role']) {
   check(await refused(`begin;set local role ${role};select * from public.creator_actor_contexts;commit;`),'capability table read refused to '+role);
   check(await refused(`begin;set local role ${role};insert into public.creator_actor_contexts(actor_id,session_id,creator_id,permission,aal,expires_at) values(${q(a)},${q(fresh.sessionId)},${q(a)},'grant','aal2',now()+interval '1 hour');commit;`),'capability table insert refused to '+role);
   check(await refused(`begin;set local role ${role};select public._creator_actor_allowed(${q(fresh.context)},${q(a)},${q(a)},'grant','grant');commit;`),'private authorization helper refused to '+role);
   check(await refused(`begin;set local role ${role};select public.grant_pass_spins(${q(randomUUID())},${q(a)},${q(fan)},${q(pass)},1,0,0,null,${q(a)});commit;`),'retired service overload cannot be called by '+role);
  }
  const publicCalls={
   grant_pass_spins:`p_request=>${q(randomUUID())},p_creator=>${q(a)},p_fan=>${q(fan)},p_pass=>${q(pass)},p_spins=>1,p_bonus=>0,p_amount=>0,p_actor=>${q(a)}`,
   grant_focus_pack:`p_request=>${q(randomUUID())},p_creator=>${q(a)},p_fan=>${q(fan)},p_pass=>${q(pass)},p_pack=>${q(randomUUID())},p_prize=>${q(randomUUID())},p_actor=>${q(a)}`,
   create_pass_grant:`p_request=>${q(randomUUID())},p_creator=>${q(a)},p_fan=>null,p_wheel=>${q(w)},p_name=>'fixture',p_spins=>1,p_bonus=>0,p_amount=>0,p_campaign=>null,p_actor=>${q(a)}`,
   import_fans_durable:`p_batch=>${q(randomUUID())},p_creator=>${q(a)},p_request_hash=>repeat('a',64),p_rows=>'[]'::jsonb,p_actor=>${q(a)}`,
   edit_pass_grant:`p_request=>${q(randomUUID())},p_creator=>${q(a)},p_grant=>${q(id)},p_patch=>'{}'::jsonb,p_actor=>${q(a)}`,
   cancel_fan_focus:`p_creator=>${q(a)},p_fan=>${q(fan)},p_focus=>${q(randomUUID())},p_actor=>${q(a)}`,
   reconcile_creator_request:`p_request=>${q(id)},p_creator=>${q(a)},p_actor=>${q(a)},p_kind=>'grant',p_cancel=>false,p_authorized=>true`,
   save_game_wheel:`p_wheel=>${q(w)},p_creator=>${q(a)},p_prizes=>'[]'::jsonb,p_config=>'{}'::jsonb,p_actor=>${q(a)}`,
  };
  for(const role of ['anon','authenticated'])for(const [name,args] of Object.entries(publicCalls))check(await refused(`begin;set local role ${role};select public.${name}(p_context=>${q(fresh.context)},${args});commit;`),role+' cannot call new service-only '+name+' overload even with a real capability');
  const retired={reconcile_creator_request:'uuid,uuid,uuid,text,boolean,boolean',grant_pass_spins:'uuid,uuid,uuid,uuid,integer,integer,integer,uuid,uuid',grant_focus_pack:'uuid,uuid,uuid,uuid,uuid,uuid,uuid',create_pass_grant:'uuid,uuid,uuid,uuid,text,integer,integer,integer,uuid,text,uuid,integer,uuid',import_fans_durable:'uuid,uuid,text,jsonb,uuid',edit_pass_grant:'uuid,uuid,uuid,jsonb,uuid',cancel_fan_focus:'uuid,uuid,uuid,uuid',save_game_wheel:'uuid,uuid,jsonb,jsonb,uuid'};
  // 0073 (DB-14) dropped most of these overloads: a missing one is as good as a revoked one.
  for(const [name,args] of Object.entries(retired))check((await sql(`select coalesce(has_function_privilege('service_role',to_regprocedure('public.${name}(${args})'),'execute'),false);`)).trim()==='f','no legacy service overload for '+name);
  for(const role of ['anon','service_role'])check(await refused(`begin;set local role ${role};select public.issue_creator_actor_context(${q(a)},'grant');commit;`),'mint refused to '+role);
  for(const [label,actor,sid,exp] of [['unknown session',a,randomUUID()],['foreign session',b,fresh.sessionId],['expired JWT',a,fresh.sessionId,1]])check(await refused(auth(actor,lowClaims(actor,sid,exp),`select public.issue_creator_actor_context(${q(actor)},'grant')`)),label+' cannot mint');
  const normalHigh=JSON.stringify({...JSON.parse(lowClaims(a,fresh.sessionId)),aal:'aal2'});
  check(await refused(auth(a,normalHigh,`select public.issue_creator_actor_context(${q(a)},'system_health')`),/admin step-up required/),'normal creator cannot mint admin authority from signed aal2 or editable admin metadata');
  const shortSid=randomUUID();await sql(`insert into auth.sessions(id,user_id,not_after) values(${q(shortSid)},${q(a)},now()+interval '10 seconds');`);
  const shortContext=JSON.parse((await sql(auth(a,lowClaims(a,shortSid,Math.floor(Date.now()/1000)+5),`select to_json(public.issue_creator_actor_context(${q(a)},'grant'))`))).trim());
  check((await sql(`select (expires_at<=to_timestamp(${Math.floor(Date.now()/1000)+5})) from public.creator_actor_contexts where id=${q(shortContext)};`)).trim()==='t','issuance bound by signed JWT expiry earlier than60s or Auth session deadline');
  const expired=await mint(a,a,'grant','aal2');await sql(`update public.creator_actor_contexts set created_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where id=${q(expired.context)};`);check((await gateway(expired.context)).status==='unavailable','expired capability refused');
  const revoked=await mint(a,a,'grant','aal2');await sql(`delete from auth.sessions where id=${q(revoked.sessionId)};`);check((await gateway(revoked.context)).status==='unavailable','deleted Auth session invalidates already issued capability');
  const ended=await mint(a,a,'grant','aal2');await sql(`update auth.sessions set not_after=now()-interval '1 second' where id=${q(ended.sessionId)};`);check((await gateway(ended.context)).status==='unavailable','current Auth session deadline rechecked at mutation');
  check((await sql(`select bool_and(expires_at<=created_at+interval '60 seconds') from public.creator_actor_contexts where actor_id=${q(a)};`)).trim()==='t','all contexts have DB enforced60-second bound');
  // Reconcile identity is allowed after MFA loss but never private receipt data.
  const recovery=await mint(a,a,'reconcile','aal1');const receipt=JSON.parse((await sql(`begin;set local role service_role;select public.reconcile_creator_request(${q(recovery.context)},${q(id)},${q(a)},${q(a)},'grant',false,true);commit;`)).trim());
  check(receipt.status==='committed'&&receipt.authorized===false&&!receipt.receipt,'aal1 recovery returns bare known terminal state without business receipt');
  const highRecovery=await mint(a,a,'reconcile','aal2');const authorized=JSON.parse((await sql(`begin;set local role service_role;select public.reconcile_creator_request(${q(highRecovery.context)},${q(id)},${q(a)},${q(a)},'grant',false,true);commit;`)).trim());check(authorized.status==='committed'&&authorized.authorized===true&&!!authorized.receipt,'aal2 scoped recovery restores authorized private receipt');
  const sysClaims=level=>JSON.stringify({sub:a,role:'authenticated',session_id:fresh.sessionId,aal:level,exp:Math.floor(Date.now()/1000)+3600});
  const system=await sql(`begin;create function pg_temp.try_actor_context(p uuid,s text) returns text language plpgsql as $$begin perform public.issue_creator_actor_context(p,s);return 'allowed';exception when others then return sqlstate;end$$;
   update public.profiles set role='admin' where id in(${q(a)},${q(b)});
   set local role authenticated;do $$begin perform set_config('request.jwt.claim.sub',${q(a)},true);perform set_config('request.jwt.claims',${q(sysClaims('aal1'))},true);end$$;
   select 'low:'||pg_temp.try_actor_context(${q(a)},'system_health');
   do $$begin perform set_config('request.jwt.claims',${q(sysClaims('aal2'))},true);perform set_config('fixture.system_context',public.issue_creator_actor_context(${q(a)},'system_health')::text,true);end$$;
   select 'foreign:'||pg_temp.try_actor_context(${q(b)},'system_health');reset role;
   select 'high:'||public._creator_actor_allowed(current_setting('fixture.system_context')::uuid,${q(a)},${q(a)},'system_health','system_health');
   update public.profiles set role='creator' where id=${q(a)};
   select 'revoked:'||public._creator_actor_allowed(current_setting('fixture.system_context')::uuid,${q(a)},${q(a)},'system_health','system_health');rollback;`);
  check(system.includes('low:42501')&&system.includes('foreign:42501')&&system.includes('high:true')&&system.includes('revoked:false'),'system-health context requires actual current admin+aal2, own creator binding and fresh revocation check');
  await sql(`grant select on public.grants to authenticated;`);
  await probeCreatorActorRoute(sql,{actor:a,creator:a,grant:id,session:fresh.sessionId});
  await sql(`update public.profiles set is_active=false where id=${q(a)};`);check((await gateway(fresh.context)).status==='unavailable'&&await balance()===2,'current profile suspension defeats prior aal2 admission');
  await sql(`update public.profiles set is_active=true where id=${q(a)};delete from public.creator_actor_contexts where actor_id=${q(a)};`);
  await Promise.all(Array.from({length:32},()=>mint(a,a,'grant','aal2')));check(Number((await sql(`select count(*) from public.creator_actor_contexts where actor_id=${q(a)};`)).trim())===32,'concurrent direct mint grows to exactly32 contexts');
  let capped=false;try{await mint(a,a,'grant','aal2');}catch(e){if(!/actor context limit/.test(e.message))throw e;capped=true;}check(capped,'33rd direct mint fails even without HTTP rate limiting');
  await sql(`update public.creator_actor_contexts set created_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where actor_id=${q(a)};`);
  const renewed=await mint(a,a,'grant','aal2');check(Number((await sql(`select count(*) from public.creator_actor_contexts where actor_id=${q(a)};`)).trim())===1,'next direct mint removes expired contexts before bounded issuance');
  await sql(`update public.creator_actor_contexts set created_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where id=${q(renewed.context)};select public.run_retention_cleanup(365,90,365,90,90);`);
  check(Number((await sql(`select count(*) from public.creator_actor_contexts where actor_id=${q(a)};`)).trim())===0,'normal retention removes abandoned expired contexts');
 } finally {for(const u of[b,a])await sql(`delete from auth.users where id=${q(u)};`);}
 console.log(`PASS creator actor context: ${checks} causal PostgreSQL checks`);
}
