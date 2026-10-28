// Local-only scope/atomicity tests for post-decryption disclosure logging.
import {randomUUID} from "node:crypto";
const q=s=>`'${String(s).replaceAll("'","''")}'`,j=v=>`${q(JSON.stringify(v))}::jsonb`;
export async function probeRewardViews(sql){
 let checks=0;const check=(v,m)=>{checks++;if(!v)throw Error(`reward views ${m}`);};
 const owner=randomUUID(),other=randomUUID(),wheel=randomUUID(),prize=randomUUID(),fan=randomUUID(),pass=randomUUID(),otherFan=randomUUID(),otherPass=randomUUID(),token=`views-${randomUUID()}`,foreignToken=`views-${randomUUID()}`,wins=[randomUUID(),randomUUID()];
 const rpc=async(name,args)=>JSON.parse((await sql(`select public.${name}(${args.join(",")});`)).trim()||"null");
 const array=ids=>`array[${ids.map(id=>id===null?'null::uuid':q(id)+'::uuid').join(',')}]::uuid[]`;
 const log=(ids,t=token)=>rpc('record_fan_reward_views',[array(ids),q(t)]);
 const counters=async()=>JSON.parse((await sql(`select jsonb_agg(jsonb_build_object('id',spin_id,'views',views,'at',last_viewed_at) order by spin_id) from public.spin_rewards where spin_id=any(${array(wins)});`)).trim());
 try{
  await sql(`insert into auth.users(id,email) values(${q(owner)},'views-a-${owner}@example.test'),(${q(other)},'views-b-${other}@example.test');update public.profiles set is_active=true,approval_status='approved' where id in(${q(owner)},${q(other)});insert into public.wheels(id,creator_id,title) values(${q(wheel)},${q(owner)},'View fixture');insert into public.prizes(id,wheel_id,label,weight,rarity) values(${q(prize)},${q(wheel)},'Private text',1,'common');
   insert into public.fans(id,creator_id) values(${q(fan)},${q(owner)}),(${q(otherFan)},${q(owner)});insert into public.fan_passes(id,creator_id,fan_id,wheel_id,token) values(${q(pass)},${q(owner)},${q(fan)},${q(wheel)},${q(token)}),(${q(otherPass)},${q(owner)},${q(otherFan)},${q(wheel)},${q(foreignToken)});`);
  await sql(`select public.set_prize_delivery(${q(prize)},${q(owner)},'text','fixture-cipher','fixture-iv');`);
  for(const id of wins){
   // Historical helper is owner-only after0059. This isolated fixture creates
   // a valid delivered receipt without claiming to test production RNG/debit.
   const spin={id,fan_id:fan,fan_pass_id:pass,creator_id:owner,wheel_id:wheel,prize_id:prize,prize_label:'Private text',prize_rarity:'common'};
   await sql(`begin;select set_config('fanfunnel.economic_write','on',true);select public.finalize_reward_spin(${j(spin)},${j({delivery:'text',cipher:'fixture-cipher',iv:'fixture-iv',keyVersion:1})});commit;`);
  }
  check((await counters()).every(r=>r.views===0&&r.at===null),'creation/internal hydration does not fabricate a value view');
  check(await log(wins,'unknown')===0&&await log(wins,foreignToken)===0,'unknown and another fan token cannot log/disclose owned values');
  check(await log([wins[0],randomUUID()])===0&&(await counters()).every(r=>r.views===0),'mixed missing/owned batch has zero partial increments');
  check(await log([wins[0],wins[0]])===0&&await log([])===0&&await log([wins[0],null])===0,'duplicates/empty/null identities are refused');
  check(await log([...wins,randomUUID(),randomUUID(),randomUUID(),randomUUID()])===0,'more than five reward identities refused');
  check(await log(wins)===2&&(await counters()).every(r=>r.views===1&&r.at),'first successful two-value disclosure is logged once per value');
  check(await log(wins)===2&&(await counters()).every(r=>r.views===2),'recovery/status value response logs a new disclosure without a new win');
  await sql(`create function public._reward_views_fault() returns trigger language plpgsql as $$begin if new.spin_id=${q(wins[1])}::uuid then raise exception 'injected view log failure';end if;return new;end $$;create trigger zz_reward_views_fault before update on public.spin_rewards for each row execute function public._reward_views_fault();`);
  let failed=false;try{await log(wins);}catch(e){failed=/injected view log failure/.test(e.message)}check(failed&&(await counters()).every(r=>r.views===2),'logging failure rolls every disclosure counter back before values can be released');
  await sql(`drop trigger zz_reward_views_fault on public.spin_rewards;drop function public._reward_views_fault();`);
  const concurrent=await Promise.all(Array.from({length:20},()=>log([wins[0]])));
  check(concurrent.every(n=>n===1)&&(await counters()).find(r=>r.id===wins[0]).views===22,'twenty concurrent disclosures increment one receipt exactly twenty times');
  await sql(`update public.fans set break_until=now()+interval '1 day' where id=${q(fan)};`);
  check(await log(wins)===2,'break still permits auditable reopening of existing wins');
  const before=(await counters()).map(r=>r.views).join(',');
  await sql(`update public.fans set blocked_at=now() where id=${q(fan)};`);
  check(await log(wins)===0&&(await counters()).map(r=>r.views).join(',')===before,'blocked fan cannot create a successful disclosure log');
  await sql(`update public.fans set blocked_at=null where id=${q(fan)};update public.profiles set approval_status='pending' where id=${q(owner)};`);
  check(await log(wins)===0,'pending creator cannot authorize reward disclosure');
  await sql(`update public.profiles set approval_status='approved',is_active=false where id=${q(owner)};`);
  check(await log(wins)===0,'inactive creator cannot authorize reward disclosure');
  await sql(`update public.profiles set is_active=true where id=${q(owner)};`);
  check((await sql(`select bool_and(not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute') and has_function_privilege('service_role',oid,'execute')) from pg_proc where pronamespace='public'::regnamespace and proname='record_fan_reward_views';`)).trim()==='t','batch logger is service-only');
  check((await sql(`select count(*) from public.spins where fan_id=${q(fan)};`)).trim()==='2'&&(await sql(`select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${q(pass)};`)).trim()==='0,0','logging never creates wins, debits credit or rotates seed/nonce');
  const eraser=sql(`begin;select 1 from public.fans where id=${q(fan)} for update;delete from public.fans where id=${q(fan)};select pg_sleep(0.4);commit;`);
  let sleeping=false;for(let i=0;i<100;i++){if((await sql(`select count(*) from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like '%${fan}%';`)).trim()==='1'){sleeping=true;break;}await new Promise(r=>setTimeout(r,5));}
  check(sleeping,'erasure race holds the fan lock after clearing values');
  const afterErase=await log(wins);await eraser;
  check(afterErase===0&&(await counters()).map(r=>r.views).join(',')===before,'disclosure waiting behind erasure returns zero and never logs cleared values');
  check((await sql(`select count(*) from public.spin_rewards where spin_id=any(${array(wins)}) and cipher is null and iv is null and erased_at is not null;`)).trim()==='2','erasure retains counts but no delivered secrets');
  console.log(`PASS reward views ${checks} authorization, atomic counters, no-economy, break and erasure-race checks`);
 }finally{await sql(`drop trigger if exists zz_reward_views_fault on public.spin_rewards;drop function if exists public._reward_views_fault();delete from auth.users where id in(${q(owner)},${q(other)});`);}
}
