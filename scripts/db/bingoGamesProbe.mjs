// Local disposable SQL tests with actual frozen pure-engine Bingo proofs.
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {createHash,randomUUID} from "node:crypto";
import {join} from "node:path";
import {isDeepStrictEqual} from "node:util";
const q=s=>`'${String(s).replaceAll("'","''")}'`,j=v=>`${q(JSON.stringify(v))}::jsonb`,hash=s=>createHash("sha256").update(s).digest("hex");
export async function probeBingoGames(sqlInput){
 let checks=0;const check=(v,msg)=>{checks++;if(!v)throw Error(`0061 ${msg}`);};
 const pending=new Set(),sql=s=>{const p=sqlInput(s);pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
 const rpc=async(name,args)=>JSON.parse((await sql(`select public.${name}(${args.join(",")});`)).trim()||"null");
 const refused=async(s,pattern)=>{try{await sql(s);return false;}catch(e){if(pattern&&!pattern.test(e.message))throw Error(`Unexpected Bingo refusal: ${e.message}`);return true;}};
 const root=join(import.meta.dirname,"../.."),bridge=spawn("npx",["tsx","scripts/db/bingoProofFixture.ts"],{cwd:root,stdio:["pipe","pipe","pipe"]}),waiters=[];let stderr="";
 bridge.stderr.on("data",b=>stderr+=b);bridge.on("error",e=>{for(const w of waiters.splice(0))w.reject(e);});bridge.on("exit",code=>{for(const w of waiters.splice(0))w.reject(Error(`Bingo fixture exited ${code}: ${stderr}`));});
 createInterface({input:bridge.stdout}).on("line",line=>{const w=waiters.shift();if(!w)return;try{const out=JSON.parse(line);if(!out.ok)throw Error(out.error);w.resolve(out.value);}catch(e){w.reject(e);}});
 const generate=input=>new Promise((resolve,reject)=>{waiters.push({resolve,reject});bridge.stdin.write(JSON.stringify(input)+"\n");}).catch(e=>{throw Error(`${e.message} for ${JSON.stringify({...input,context:{card:input.context.bingoCard?.marked_mask??null,focus:input.context.focus?.kind??null,prizes:input.context.prizes.map(p=>[p.label,p.weight,p.stock,p.delivery])}})}`);});
 const owner=randomUUID(),other=randomUUID(),wheel=randomUUID(),linePrize=randomUUID();let primaryPlays=0;
 const makeRows=(id=wheel,line=linePrize)=>[...Array.from({length:10},(_,i)=>({id:randomUUID(),label:`Cell ${i}`,emoji:["🍎","🍋","🍉","🍇","🍒","🍓","🥝","🍊","🍌","🍐"][i],rarity:i===0?"rare":"common",weight:1,stock:null,sort_order:i,delivery:"manual",boostable:true})),{id:line,label:"Zero-weight line prize",emoji:"🏆",rarity:"rare",weight:0,stock:null,sort_order:10,delivery:"manual",boostable:true}];
 const publish=async(id,rows,line,actor=owner)=>rpc("save_game_wheel",[q(id),q(owner),j(rows),j({game_kind:"bingo",game_config:{size:3,linePrizeId:line},title:"Published Bingo"}),q(actor)]);
 const addFan=async(id=wheel,credit=100)=>{
  const out=await rpc("create_pass_grant",[q(randomUUID()),q(owner),"null",q(id),q("Bingo fixture"),String(credit),"0","100","null"]);check(out.status==="granted","fixture paid fan uses the durable bootstrap");
  await sql(`update public.fans set acked_at=now(),acked_terms_version='2026-10-27' where id=${q(out.fanId)};`);return{fan:out.fanId,pass:out.passId,token:out.token,wheel:id};
 };
 const prep=async(who,id=randomUUID())=>{
  // Simulate a new throttle window between synthetic ordered fixture plays;
  // production limits remain enabled and retain their independent regressions.
  await sql(`update public.fans set rl_window_start=now()-interval '20 seconds' where id=${q(who.fan)};`);
  const binding=hash(id),out=await rpc("prepare_spin_attempt",[q(id),q(who.token),q(binding)]);check(out.status==="ready"&&out.context.wheel.game_kind==="bingo","prepare derives ready Bingo and private card from token");return{id,binding,...out};
 };
 const reward=async(pr,used=[])=>{
  if(pr.delivery==="codes")return JSON.parse((await sql(`select jsonb_build_object('delivery','codes','codeId',id,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_reward_codes where prize_id=${q(pr.id)} and spin_id is null and reserved_focus_id is null ${used.length?`and id not in(${used.map(q).join(",")})`:""} order by id limit 1;`)).trim()||"null");
  if(["link","text"].includes(pr.delivery))return JSON.parse((await sql(`select jsonb_build_object('delivery',kind,'cipher',cipher,'iv',iv,'keyVersion',key_version) from public.prize_rewards where prize_id=${q(pr.id)};`)).trim());return{delivery:"manual"};
 };
 const build=async(a,options={})=>{
  const generated=await generate({context:a.context,...options}),d=generated.primary,c=a.context,p=c.prizes.find(p=>p.id===d.prize.id),next=randomUUID().replaceAll("-","").repeat(2),used=[];
  const expected=await reward(p);if(expected?.codeId)used.push(expected.codeId);
  const bonuses=[];for(const bonus of generated.bonuses){const row=c.prizes.find(p=>p.id===bonus.prize.id),candidate=await reward(row,used);if(candidate?.codeId)used.push(candidate.codeId);bonuses.push({id:randomUUID(),line:bonus.line,prize_id:row.id,prize_label:row.label,prize_rarity:row.rarity,prize_image_url:row.image_url,response_prize:{id:row.id,label:row.label,rarity:row.rarity,weight:row.weight},expected_reward:candidate??{delivery:row.delivery,codeId:used[0]}});}
  return{generated,context:{contextHash:c.contextHash,cardId:c.bingoCard?.id??null,cardVersion:c.bingoCard?.version??null},expected,next:{seed:next,hash:hash(next)},spin:{id:a.id,fan_id:c.fanId,fan_pass_id:c.passId,creator_id:c.creatorId,wheel_id:c.wheelId,campaign_id:c.campaignId,prize_id:p.id,prize_label:p.label,prize_rarity:p.rarity,prize_image_url:p.image_url,server_seed:c.serverSeed,server_seed_hash:c.serverSeedHash,nonce:c.nonce,client_seed:generated.clientSeed,fair_version:3,game_kind:"bingo",presentation:generated.presentation,pool_snapshot:generated.snapshot,pool_hash:generated.poolHash,fair_trace:generated.trace,bonuses,
   next_pity_counter:d.nextPityCounter,focus_consumed:d.focusConsumed??false,chase_consumed:d.chaseConsumed??false,chase_completed:d.chaseCompleted??false,next_focus_spins_left:d.nextFocusSpinsLeft??null,next_chase_counter:d.nextChaseCounter??null,response_prize:{id:p.id,label:p.label,rarity:p.rarity,weight:p.weight},response_prize_index:c.prizes.findIndex(p2=>p2.id===p.id),response_show_stock:c.wheel.show_stock}};
 };
 const commit=(who,a,b)=>rpc("commit_spin_attempt",[q(a.id),q(who.token),q(a.binding),j(b.context),j(b.spin),j(b.expected),j(b.next)]);
 const card=who=>rpc("get_bingo_card_state",[q(who.token)]);
 const play=async(who,options={})=>{const a=await prep(who),b=await build(a,options),out=await commit(who,a,b);check(out.status==="committed",`actual Bingo primary/marks/bonuses commit (${out.status})`);return{a,b,out};};
 try{
  await sql(`insert into auth.users(id,email) values(${q(owner)},'bingo-a-${owner}@example.test'),(${q(other)},'bingo-b-${other}@example.test');update public.profiles set is_active=true,approval_status='approved' where id in(${q(owner)},${q(other)});`);
  check(await refused(`insert into public.wheels(creator_id,game_kind,game_config,game_ready,is_active) values(${q(owner)},'bingo','{"size":3,"linePrizeId":null}',false,false);`,/feature_disabled/),"disabled Bingo feature refuses even an inactive draft");
  await sql(`update public.profiles set features=features||'{"bingo":true}'::jsonb where id=${q(owner)};insert into public.wheels(id,creator_id,title,game_kind,game_config,game_ready,is_active) values(${q(wheel)},${q(owner)},'Bingo draft','bingo','{"size":3,"linePrizeId":null}',false,false);`);
  const unavailable=await rpc("create_pass_grant",[q(randomUUID()),q(owner),"null",q(wheel),q("No draft sale"),"5","0","100","null"]);check(unavailable.status==="invalid"&&unavailable.error==="no_wheel","draft cannot mint a paid fan/link");
  check(await refused(`update public.wheels set game_ready=true where id=${q(wheel)};`,/invalid_game_config/),"direct readiness write cannot publish a missing line prize");
  check(await refused(`update public.wheels set is_active=true where id=${q(wheel)};`,/game_not_ready/),"direct active flag cannot publish an incomplete Bingo draft");
  const rows=makeRows();
  check(await refused(`select public.save_game_wheel(${[q(wheel),q(owner),j(rows),j({game_kind:"bingo",game_config:{size:3,linePrizeId:linePrize}}),q(other)].join(",")});`,/forbidden/),"actual unauthorized actor cannot publish another creator's game");
  const revokedDraft=randomUUID(),revokedLine=randomUUID(),revokedRows=makeRows(revokedDraft,revokedLine);
  await sql(`insert into public.wheels(id,creator_id,title,game_kind,game_config,game_ready,is_active) values(${q(revokedDraft)},${q(owner)},'Revoked draft','bingo','{"size":3,"linePrizeId":null}',false,false);update public.profiles set features=features||'{"bingo":false}'::jsonb where id=${q(owner)};`);
  check(await refused(`select public.save_game_wheel(${[q(revokedDraft),q(owner),j(revokedRows),j({game_kind:"bingo",game_config:{size:3,linePrizeId:revokedLine}}),q(owner)].join(",")});`,/feature_disabled/),"first publication rechecks feature removed after draft creation");
  check((await sql(`select game_ready||','||(select count(*) from public.prizes where wheel_id=${q(revokedDraft)}) from public.wheels where id=${q(revokedDraft)};`)).trim()==="false,0","revoked draft publication leaves no partial inventory or readiness");
  await sql(`update public.profiles set features=features||'{"bingo":true}'::jsonb where id=${q(owner)};`);
  const faultWheel=randomUUID(),faultLine=randomUUID(),faultRows=makeRows(faultWheel,faultLine);faultRows[1].label="Injected publish failure";
  await sql(`insert into public.wheels(id,creator_id,title,game_kind,game_config,game_ready,is_active) values(${q(faultWheel)},${q(owner)},'Unpublished','bingo','{"size":3,"linePrizeId":null}',false,false);
   create function public._bingo_publish_fault() returns trigger language plpgsql as $$begin if new.label='Injected publish failure' then raise exception 'injected Bingo publish failure';end if;return new;end $$;create trigger zz_bingo_publish_fault before insert or update on public.prizes for each row execute function public._bingo_publish_fault();`);
  check(await refused(`select public.save_game_wheel(${[q(faultWheel),q(owner),j(faultRows),j({game_kind:"bingo",game_config:{size:3,linePrizeId:faultLine},title:"Must roll back"}),q(owner)].join(",")});`,/injected Bingo publish failure/),"publication fault occurs after an earlier real prize insertion");
  check((await sql(`select game_ready||','||title||','||(select count(*) from public.prizes where wheel_id=${q(faultWheel)}) from public.wheels where id=${q(faultWheel)};`)).trim()==="false,Unpublished,0","failed publication rolls metadata/prize IDs/readiness back together");
  await sql(`drop trigger zz_bingo_publish_fault on public.prizes;drop function public._bingo_publish_fault();`);
  await publish(wheel,rows,linePrize);await sql(`update public.wheels set is_active=true where id=${q(wheel)};`);
  check((await sql(`select game_ready||','||(select count(*) from public.prizes where wheel_id=${q(wheel)}) from public.wheels where id=${q(wheel)};`)).trim()==="true,11","one save publishes real prize IDs/config/readiness atomically");
  const fan=await addFan(),first=await prep(fan),body=await build(first,{notCenter:true,centerCommon:true});
  const replies=await Promise.all(Array.from({length:20},()=>commit(fan,first,body)));
  check(replies.every(r=>r.status==="committed")&&replies.filter(r=>!r.replayed).length===1,"twenty retries debit one Bingo play and create one card");primaryPlays++;
  let state=(await card(fan)).card;check(state&&state.version===1&&state.markedMask!==0,"token read returns own safe card after first commit");
  check(!JSON.stringify(await card(fan)).includes('creator_id')&&!JSON.stringify(await card(fan)).includes(fan.fan),"fan card DTO excludes database card/creator/fan identity");
  check(replies.every(r=>isDeepStrictEqual(r.presentation,body.spin.presentation)),"same UUID recovers the exact immutable initial card/presentation");
  const initialCardId=(await sql(`select id from public.bingo_cards where fan_id=${q(fan.fan)};`)).trim(),firstPrize=body.spin.prize_id,centerId=state.cells[4].id;
  const repeated=await play(fan,{target:firstPrize});primaryPlays++;check(repeated.out.presentation.after.markedMask===state.markedMask&&repeated.out.bonusWins.length===0,"repeat primary still awards normally without a duplicate mark or line");
  const outside=rows.find(r=>r.weight>0&&!state.cells.some(c=>c.id===r.id));const outsideWin=await play(fan,{target:outside.id});primaryPlays++;check(outsideWin.out.presentation.markedIndex===null&&outsideWin.out.presentation.after.markedMask===state.markedMask,"outside-card primary awards its prize without false progress");
  check(await refused(`update public.prizes set stock=1 where id=${q(centerId)};`,/bingo_active_card/),"active cell cannot become finite");
  check(await refused(`update public.prizes set weight=0 where id=${q(centerId)};`,/bingo_active_card/),"active cell cannot lose ordinary positive weight");
  check(await refused(`delete from public.prizes where id=${q(centerId)};`,/bingo_active_card/),"active card cell cannot be deleted");
  // Retirement: archiving keeps the paid card, stops serving the game, and unarchiving restores play.
  const retiredVersion=(await card(fan)).card.version;
  await sql(`update public.wheels set archived_at=now() where id=${q(wheel)};`);
  check((await card(fan)).status==="ok"&&(await card(fan)).card===null&&(await sql(`select count(*) from public.bingo_cards where wheel_id=${q(wheel)} and status='active';`)).trim()==="1","archiving a game with active cards keeps the paid card and stops showing the retired game");
  const retired=await rpc("prepare_spin_attempt",[q(randomUUID()),q(fan.token),q(hash("bingo-archived"))]);check(retired.status==="declined"&&retired.error==="no_wheel","an archived Bingo game is no longer served");
  await sql(`update public.wheels set archived_at=null where id=${q(wheel)};`);
  check((await card(fan)).card?.version===retiredVersion,"unarchiving shows the same card again");
  const restored=await prep(fan);check(restored.context.bingoCard?.version===retiredVersion,"unarchiving restores play on the same card");await rpc("cancel_spin_attempt",[q(restored.id),q(fan.token),q(restored.binding)]);
  check(await refused(`delete from public.wheels where id=${q(wheel)};`,/bingo_active_card/),"deleting a game with active cards is still refused");
  check(await refused(`update public.wheels set game_ready=false where id=${q(wheel)};`,/bingo_active_card|game_not_ready/),"un-publishing a game with active cards is still refused");
  // A blocked fan keeps the same read-only card page as on wheel/scratch; only play is refused.
  const blockedFan=await addFan();await play(blockedFan,{notCenter:true});
  await sql(`update public.fans set blocked_at=now() where id=${q(blockedFan.fan)};`);
  const blockedRead=await card(blockedFan);check(blockedRead.status==="ok"&&blockedRead.card?.version===1,"a blocked fan can still read their own card");
  check((await rpc("prepare_spin_attempt",[q(randomUUID()),q(blockedFan.token),q(hash("bingo-blocked"))])).status==="unavailable","a blocked fan cannot start a new paid attempt");
  await sql(`update public.profiles set approval_status='pending' where id=${q(owner)};`);
  check((await card(blockedFan)).status==="ok","the card read does not depend on creator approval");
  await sql(`update public.profiles set approval_status='approved' where id=${q(owner)};update public.fans set blocked_at=null where id=${q(blockedFan.fan)};`);
  // Two sessions in commit's lock order (wheel -> prize) against a prize-first creator edit: never 40P01.
  const lockRace=async(label,wheelId,prizeId,editor)=>{
   const holder=sql(`begin;select 1 from public.wheels where id=${q(wheelId)} for update;select pg_sleep(0.5);update public.prizes set label=label where id=${q(prizeId)};commit;`);
   let sleeping=false;for(let i=0;i<200;i++){if((await sql(`select count(*) from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like '%${wheelId}%';`)).trim()==="1"){sleeping=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   check(sleeping,`${label}: the play holds the game lock before the creator edit starts`);
   const settled=await Promise.allSettled([holder,editor()]);
   check(settled.every(r=>r.status==="fulfilled"),`${label}: a creator edit racing a credited play never deadlocks (${settled.find(r=>r.status==="rejected")?.reason?.message?.trim()??""})`);
   return settled[1].value;
  };
  await lockRace("bingo set_prize_delivery",wheel,centerId,()=>sql(`select public.set_prize_delivery(${q(centerId)},${q(owner)},'manual');`));
  const plainWheel=randomUUID();await sql(`insert into public.wheels(id,creator_id,title,is_active) values(${q(plainWheel)},${q(owner)},'Plain wheel',false);insert into public.prizes(wheel_id,label,weight,emoji,sort_order) values(${q(plainWheel)},'Plain',1,'🟦',0),(${q(plainWheel)},'Other',1,'🟥',1);`);
  const plainPrize=(await sql(`select id from public.prizes where wheel_id=${q(plainWheel)} and label='Plain';`)).trim();
  await lockRace("wheel set_prize_delivery",plainWheel,plainPrize,()=>sql(`select public.set_prize_delivery(${q(plainPrize)},${q(owner)},'text','plain-cipher','plain-iv');`));
  await lockRace("wheel add_reward_codes",plainWheel,plainPrize,()=>sql(`select public.add_reward_codes(${q(plainPrize)},${q(owner)},${j([{cipher:"plain-code",iv:"plain-code-iv",key_version:1,hint:"p",fingerprint:hash("plain-code")}])});`));
  // A creator's focus-pack grant on a wheel game: its fan_focus insert needs the wheel, so it must lock the wheel first.
  const plainCampaign=randomUUID();await sql(`insert into public.campaigns(id,creator_id,name,pinned_wheel_id) values(${q(plainCampaign)},${q(owner)},'Plain pin',${q(plainWheel)});update public.prizes set boostable=true where id=${q(plainPrize)};`);
  const plainFan=await rpc("create_pass_grant",[q(randomUUID()),q(owner),"null",q(plainWheel),q("Plain fan"),"10","0","100",q(plainCampaign)]);
  check(plainFan.status==="granted"&&(await sql(`select public._resolved_spin_wheel(${q(plainFan.passId)});`)).trim()===plainWheel,"a pinned campaign link resolves to the plain wheel game");
  const plainPack=randomUUID();await sql(`insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,focus_multiplier,focus_spins) values(${q(plainPack)},${q(owner)},'Plain focus',5,'focus',3,5);`);
  const plainFocus=await lockRace("wheel _grant_focus_pack_core",plainWheel,plainPrize,()=>rpc("grant_focus_pack",[q(randomUUID()),q(owner),q(plainFan.fanId),q(plainFan.passId),q(plainPack),q(plainPrize),q(owner)]));
  check(plainFocus.status==="granted","the wheel focus grant settles once the racing play releases the game");
  check((await rpc("cancel_fan_focus",[q(owner),q(plainFan.fanId),q(plainFocus.focus.id),q(owner)])).status==="released","the raced wheel focus is released again");
  // The real race: a credited Bingo play and a delivery edit on the same game, concurrently.
  // Its own fan, so the main fixture fan's pity sequence (tuned below) is untouched.
  { const raceFan=await addFan(),a=await prep(raceFan),b=await build(a);
   const settled=await Promise.allSettled([commit(raceFan,a,b),sql(`select public.set_prize_delivery(${q(centerId)},${q(owner)},'manual');`)]);
   check(settled.every(r=>r.status==="fulfilled"),`concurrent commit and set_prize_delivery on one Bingo game never raise (${settled.find(r=>r.status==="rejected")?.reason?.message?.trim()??""})`);
   let out=settled[0].value;if(out.status==="retry_context"){const again=await prep(raceFan,a.id);out=await commit(raceFan,again,await build(again));}
   check(out.status==="committed","the racing play settles as a committed play"); }
  check(await refused(`update public.wheels set game_config=jsonb_build_object('size',3,'linePrizeId',${q(centerId)}) where id=${q(wheel)};`,/bingo_active_card/),"line reward promise cannot change while a card is incomplete");
  const oldLabel=state.cells[4].label;await sql(`update public.prizes set label='Renamed future prize' where id=${q(centerId)};`);
  check((await card(fan)).card.cells[4].label===oldLabel,"ordinary label edits never rewrite an existing card's immutable label");
  for(const cell of state.cells){if(cell.id===centerId||cell.id===firstPrize)continue;await play(fan,{target:cell.id});primaryPlays++;}
  const beforeCenter=(await card(fan)).card;check(beforeCenter.markedMask===495&&beforeCenter.awardedLinesMask===45,"eight non-center marks retain four already paid outer lines");
  const final=await prep(fan),finalBody=await build(final,{target:centerId});check(finalBody.generated.presentation.newLines.length===4,"actual same-stream engine completes four new lines on center mark");
  const tampered=structuredClone(finalBody);tampered.context.cardVersion--;
  check((await commit(fan,final,tampered)).status==="retry_context","forged/stale private card version refuses before debit");
  const omitted=structuredClone(finalBody);omitted.spin.bonuses.pop();check(await refused(`select public.commit_spin_attempt(${[q(final.id),q(fan.token),q(final.binding),j(omitted.context),j(omitted.spin),j(omitted.expected),j(omitted.next)].join(",")});`,/missing or extra bingo bonuses/),"owed line bonuses cannot be omitted");
  for(const mutate of [x=>{x.spin.presentation.before.markedMask=0;},x=>{x.spin.presentation.after.cells[0].label="Forged card";},x=>{x.spin.presentation.after.markedMask=0;},x=>{x.spin.pool_snapshot.bingo.catalog[0].label="Forged catalog";},x=>{x.spin.fair_trace.bonuses[0].won=randomUUID();},x=>{x.spin.bonuses[0].id=x.spin.id;}]){
   const bad=structuredClone(finalBody);mutate(bad);
   check(await refused(`select public.commit_spin_attempt(${[q(final.id),q(fan.token),q(final.binding),j(bad.context),j(bad.spin),j(bad.expected),j(bad.next)].join(",")});`),"tampered card/catalog/marks/bonus trace/parent identity cannot commit");
  }
  await sql(`create function public._bingo_probe_fault() returns trigger language plpgsql as $$begin if new.line_index=7 then raise exception 'injected last line failure';end if;return new;end $$;create trigger zz_bingo_probe_fault before insert on public.bingo_line_awards for each row execute function public._bingo_probe_fault();`);
  check(await refused(`select public.commit_spin_attempt(${[q(final.id),q(fan.token),q(final.binding),j(finalBody.context),j(finalBody.spin),j(finalBody.expected),j(finalBody.next)].join(",")});`,/injected last line failure/),"injected fourth-line failure reaches the real transaction");
  check((await card(fan)).card.markedMask===495&&(await sql(`select count(*) from public.spins where id=${q(final.id)} or parent_spin_id=${q(final.id)};`)).trim()==="0","last line fault rolls primary/card/all four rewards back together");
  await sql(`drop trigger zz_bingo_probe_fault on public.bingo_line_awards;drop function public._bingo_probe_fault();`);
  const full=await commit(fan,final,finalBody);check(full.status==="committed"&&full.bonusWins.length===4,"same failed UUID recovers one primary and all four ordered bonuses");primaryPlays++;
  check(full.bonusWins.every((r,i)=>r.line===finalBody.generated.presentation.newLines[i]&&r.prize.id===linePrize),"zero-weight configured line prize pays deterministically in fixed line order");
  check((await card(fan)).card.markedMask===511&&(await card(fan)).card.version===primaryPlays,"full card remains visible through its reveal");
  check((await sql(`select (select count(*) from public.spins where fan_id=${q(fan.fan)} and kind='play')||','||(select count(*) from public.spins where fan_id=${q(fan.fan)} and kind='bonus')||','||(select next_spin_nonce from public.fan_passes where id=${q(fan.pass)})||','||(select spins_remaining from public.fan_passes where id=${q(fan.pass)});`)).trim()===`${primaryPlays},8,${primaryPlays},${100-primaryPlays}`,"eight bonuses consume no extra credit, nonce or paid-play count");
  check((await sql(`select pity_counter from public.fans where id=${q(fan.fan)};`)).trim()===String(finalBody.generated.primary.nextPityCounter),"rare line bonuses never reset the primary common pity counter");
  const recovered=await rpc("get_spin_attempt_status",[q(final.id),q(fan.token),q(final.binding)]);check(recovered.replayed&&isDeepStrictEqual(recovered.bonusWins,full.bonusWins)&&isDeepStrictEqual(recovered.presentation,full.presentation),"lost multi-line response/status returns every immutable bonus and the same face");
  const next=await play(fan);check(next.out.presentation.newCard&&next.out.presentation.before.markedMask===511&&next.out.presentation.after.version===1,"new card begins only on the next credited primary play");
  check((await sql(`select count(*) from public.bingo_cards where fan_id=${q(fan.fan)};`)).trim()==="2"&&(await sql(`select id from public.bingo_cards where fan_id=${q(fan.fan)} and status='active';`)).trim()!==initialCardId,"completed historical card is retained and a separate active card starts once");
  // Five contenders across two passes share ONE fan/card lock. Stale prepared
  // versions retry the same request identity rather than losing a mark.
  const racing=await addFan(),racingFirst=await play(racing,{notCenter:true});
  const otherPass=randomUUID(),otherToken=`bingo-${randomUUID()}`;
  await sql(`insert into public.fan_passes(id,creator_id,fan_id,wheel_id,token) values(${q(otherPass)},${q(owner)},${q(racing.fan)},${q(wheel)},${q(otherToken)});`);
  check((await rpc("grant_pass_spins",[q(randomUUID()),q(owner),q(racing.fan),q(otherPass),"100","0","0","null",q(owner)])).status==="granted","second pass receives credit through authoritative grant gateway");
  const alternate={...racing,pass:otherPass,token:otherToken},racingState=(await card(racing)).card;
  const targets=racingState.cells.filter(c=>c.id!==racingFirst.out.prize.id).slice(0,5).map(c=>c.id),raceInputs=[];
  for(let i=0;i<targets.length;i++){const who=i%2?alternate:racing,a=await prep(who);raceInputs.push({who,a,b:await build(a,{target:targets[i]}),target:targets[i]});}
  let staleVersions=0;
  const raceResults=await Promise.all(raceInputs.map(async c=>{
   for(let attempt=0;attempt<8;attempt++){const out=await commit(c.who,c.a,c.b);if(out.status==="committed")return out;if(out.status!=="retry_context")throw Error(`card race refused ${out.status}`);staleVersions++;c.a=await prep(c.who,c.a.id);c.b=await build(c.a,{target:c.target});}
   throw Error("bounded same-card version retries exhausted");
  }));
  check(raceResults.length===5&&staleVersions>=4,"parallel prepared card versions are fenced and all five same-ID retries settle once");
  const raceState=(await card(racing)).card;
  check(raceState.version===6&&raceState.markedMask.toString(2).replaceAll('0','').length===6,"five cross-pass plays add five distinct marks with no lost card update");
  check((await sql(`select (select count(*) from public.bingo_cards where fan_id=${q(racing.fan)} and status='active')||','||(select count(*) from public.spins where fan_id=${q(racing.fan)} and kind='play')||','||(select sum(next_spin_nonce) from public.fan_passes where fan_id=${q(racing.fan)})||','||(select spins_remaining from public.fans where id=${q(racing.fan)})||','||(select sum(spins_remaining) from public.fan_passes where fan_id=${q(racing.fan)} and is_active);`)).trim()==="1,6,6,194,194","one active card, six paid plays/nonces and fans==sum(two passes) survive concurrency");
  check((await sql(`select count(*)=count(distinct(card_id,line_index)) from public.bingo_line_awards where fan_id=${q(racing.fan)};`)).trim()==="t","concurrent primary plays never pay one card line twice");

  // A new game's selected CODE bonus can exhaust after an earlier successful
  // line in the same primary. Later exclusion must not rewind that earlier win.
  const codeWheel=randomUUID(),codeLine=randomUUID(),codeRows=makeRows(codeWheel,codeLine);
  await sql(`insert into public.wheels(id,creator_id,game_kind,game_config,game_ready,is_active) values(${q(codeWheel)},${q(owner)},'bingo','{"size":3,"linePrizeId":null}',false,false);`);
  await publish(codeWheel,codeRows,codeLine);
  await sql(`update public.wheels set is_active=false where creator_id=${q(owner)};update public.wheels set is_active=true where id=${q(codeWheel)};`);
  const codeValue=n=>({cipher:`bingo-code-${n}`,iv:`bingo-iv-${n}`,key_version:1,hint:`b${n}`,fingerprint:hash(`bingo-${owner}-${n}`)});
  await lockRace("bingo add_reward_codes",codeWheel,codeLine,()=>rpc("add_reward_codes",[q(codeLine),q(owner),j([codeValue(0)])]));
  const codeFan=await addFan(codeWheel),codeFirst=await play(codeFan,{notCenter:true,centerCommon:true}),codeState=(await card(codeFan)).card,codeCenter=codeState.cells[4].id;
  for(const cell of codeState.cells){if(cell.id===codeCenter||cell.id===codeFirst.out.prize.id)continue;await play(codeFan,{target:cell.id});}
  check((await card(codeFan)).card.markedMask===495,"code fixture reaches actual eight non-center marks through paid plays");
  await rpc("add_reward_codes",[q(codeLine),q(owner),j([codeValue(1)])]);
  await sql(`select public.set_prize_delivery(${q(codeCenter)},${q(owner)},'text','bingo-private-cipher','bingo-private-iv');`);
  const codeAttempt=await prep(codeFan),codeBody=await build(codeAttempt,{target:codeCenter});
  check(codeBody.generated.presentation.newLines.length===4&&codeBody.spin.bonuses.length===4,"same-stream four-line proposal initially selects configured code on every line");
  const codeBefore=(await sql(`select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${q(codeFan.pass)};`)).trim();
  const codeFailure=await commit(codeFan,codeAttempt,codeBody);
  check(codeFailure.status==="sold_out"&&codeFailure.prizeId===codeLine&&codeFailure.line===codeBody.generated.presentation.newLines[1],"second line reports exhaustion after first provisional code allocation");
  check((await sql(`select (select stock from public.prizes where id=${q(codeLine)})||','||(select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${q(codeFan.pass)})||','||(select count(*) from public.spins where id=${q(codeAttempt.id)} or parent_spin_id=${q(codeAttempt.id)});`)).trim()===`1,${codeBefore},0`&&(await card(codeFan)).card.markedMask===495,"recoverable code exhaustion rolls back primary/card/first code/prior bonuses before reply");
  const failedLine=codeFailure.line,forward=await build(codeAttempt,{target:codeCenter,clientSeed:codeBody.generated.clientSeed,failures:[{line:failedLine,excluded:[codeLine]}]});
  check(isDeepStrictEqual(forward.generated.trace.bonuses[0],codeBody.generated.trace.bonuses[0])&&forward.generated.trace.bonuses[1].excluded[0]===codeLine,"forward-only failure plan preserves earlier successful line selection");
  const codeWin=await commit(codeFan,codeAttempt,forward);
  check(codeWin.status==="committed"&&codeWin.bonusWins.length===4&&codeWin.bonusWins[0].reward?.kind==="code"&&codeWin.bonusWins.slice(1).every(x=>x.prize.id!==codeLine),"retry pays original first code and three base-weight rare fallbacks atomically");
  check((await sql(`select count(*) from public.prize_reward_codes where prize_id=${q(codeLine)} and spin_id in(select id from public.spins where parent_spin_id=${q(codeAttempt.id)});`)).trim()==="1","multi-line fallback never assigns one code to multiple wins");
  const codeReplay=await rpc("get_spin_attempt_status",[q(codeAttempt.id),q(codeFan.token),q(codeAttempt.binding)]);
  check(codeReplay.replayed&&isDeepStrictEqual(codeReplay.bonusWins,codeWin.bonusWins),"lost instant multi-line response reopens the exact same four private receipts");
  const disclosed=[codeAttempt.id,codeWin.bonusWins[0].spin.id];
  check((await sql(`select count(*) from public.spin_rewards where spin_id in(${disclosed.map(q).join(",")}) and views=0 and last_viewed_at is null;`)).trim()==="2","primary text and code bonus start unviewed until a valid value disclosure");
  check(await rpc("record_fan_reward_views",[`array[${disclosed.map(id=>q(id)+'::uuid').join(',')}]`,q(codeFan.token)])===2,"one token-bound batch logs the primary and bonus value response atomically");
  await rpc("get_spin_attempt_status",[q(codeAttempt.id),q(codeFan.token),q(codeAttempt.binding)]);
  check((await sql(`select count(*) from public.spin_rewards where spin_id in(${disclosed.map(q).join(",")}) and views=1;`)).trim()==="2","internal encrypted hydration alone adds no plaintext disclosure counts");

  check(await refused(`update public.prizes set wheel_id=${q(codeWheel)} where id=${q(centerId)};`,/bingo_active_card/),"moving a prize to another game cannot strand an existing active card");

  // A personal chase holds an actual code, while line bonuses use only free
  // inventory. No fallback may steal that personally reserved code.
  const heldFan=await addFan(codeWheel),heldFirst=await play(heldFan,{notCenter:true,centerCommon:true}),heldState=(await card(heldFan)).card,heldCenter=heldState.cells[4].id;
  for(const cell of heldState.cells){if(cell.id===heldCenter||cell.id===heldFirst.out.prize.id)continue;await play(heldFan,{target:cell.id});}
  await rpc("add_reward_codes",[q(codeLine),q(owner),j([codeValue(2)])]);
  await sql(`insert into public.focus_creator_config(creator_id,chase_enabled) values(${q(owner)},true) on conflict(creator_id) do update set chase_enabled=true;`);
  const chasePack=randomUUID();await sql(`insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,chase_within) values(${q(chasePack)},${q(owner)},'held code chase',5,'chase',5);`);
  const heldGrant=await rpc("grant_focus_pack",[q(randomUUID()),q(owner),q(heldFan.fan),q(heldFan.pass),q(chasePack),q(codeLine),q(owner)]);
  check(heldGrant.status==="granted"&&(await sql(`select stock from public.prizes where id=${q(codeLine)};`)).trim()==="0","chase reserves the last free concrete line-prize code");
  const heldAttempt=await prep(heldFan),heldBody=await build(heldAttempt,{target:heldCenter});
  check(heldBody.generated.snapshot.bingo.bonus.selected===null,"personally held primary code is absent from the ordinary bonus pool");
  const heldWin=await commit(heldFan,heldAttempt,heldBody);
  check(heldWin.status==="committed"&&heldWin.bonusWins.length===4&&heldWin.bonusWins.every(x=>x.prize.id!==codeLine),"four new lines pay free rare fallback without stealing held primary code");
  check((await sql(`select state||','||(select count(*) from public.prize_reward_codes where reserved_focus_id=${q(heldGrant.focus.id)} and spin_id is null) from public.chase_reservations where focus_id=${q(heldGrant.focus.id)};`)).trim()==="held,1","held code identity remains reserved after all line bonuses");
  check((await sql(`select chase_counter from public.fan_focus where id=${q(heldGrant.focus.id)};`)).trim()==="1","primary advances chase once and four bonuses never advance it again");
  await lockRace("bingo _release_fan_focus",codeWheel,codeLine,()=>rpc("cancel_fan_focus",[q(owner),q(heldFan.fan),q(heldGrant.focus.id),q(owner)]));
  // A creator's chase grant on the Bingo game reserves the line prize, so it must lock the game first.
  const raceChaseFan=await addFan(codeWheel);
  const raceChase=await lockRace("bingo _grant_focus_pack_core",codeWheel,codeLine,()=>rpc("grant_focus_pack",[q(randomUUID()),q(owner),q(raceChaseFan.fan),q(raceChaseFan.pass),q(chasePack),q(codeLine),q(owner)]));
  check(raceChase.status==="granted"&&(await sql(`select stock from public.prizes where id=${q(codeLine)};`)).trim()==="0","the Bingo chase grant settles once the racing play releases the game");
  check((await rpc("cancel_fan_focus",[q(owner),q(raceChaseFan.fan),q(raceChase.focus.id),q(owner)])).status==="released"&&(await sql(`select stock from public.prizes where id=${q(codeLine)};`)).trim()==="1","the raced Bingo chase returns its code");

  // Permission revocation while a save waits on its game lock must be seen in
  // the transaction, not merely by a route check made before dispatch.
  const org=randomUUID();await sql(`insert into public.orgs(id,name,owner_id) values(${q(org)},'Bingo agency',${q(owner)});update public.profiles set org_id=${q(org)} where id=${q(owner)};insert into public.org_members(org_id,profile_id,role) values(${q(org)},${q(other)},'manager');`);
  check((await sql(`select public._game_actor_edit_allowed(${q(other)},${q(owner)});`)).trim()==="t","agency save actor had permission at route admission");
  const revoker=sql(`begin;select 1 from public.wheels where id=${q(codeWheel)} for update;delete from public.org_members where org_id=${q(org)} and profile_id=${q(other)};select pg_sleep(0.4);commit;`);
  let sleeping=false;for(let i=0;i<100;i++){if((await sql(`select count(*) from pg_stat_activity where pid<>pg_backend_pid() and wait_event='PgSleep' and query like '%${codeWheel}%';`)).trim()==="1"){sleeping=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
  check(sleeping,"Bingo save barrier observes uncommitted agency revocation under game lock");
  check(await refused(`select public.save_game_wheel(${[q(codeWheel),q(owner),j(codeRows),j({game_kind:"bingo",game_config:{size:3,linePrizeId:codeLine},title:"Forbidden overwrite"}),q(other)].join(",")});`,/forbidden/),"already-dispatched save rechecks and refuses the now-revoked actor");await revoker;
  check((await sql(`select title from public.wheels where id=${q(codeWheel)};`)).trim()==="Published Bingo","revoked save leaves metadata and inventory unchanged");
  check(await refused(`set role service_role;select public.save_wheel_prizes(${q(codeWheel)},${q(owner)},${j(codeRows)});`,/use actor-bound game saver/),"old generic saver cannot bypass actor-bound Bingo publication");
  await sql(`update public.profiles set features=features||'{"bingo":false}'::jsonb where id=${q(owner)};`);
  check((await play(heldFan)).out.status==="committed","feature removal preserves an already paid Bingo link");
  check(await refused(`insert into public.wheels(creator_id,game_kind,game_config,game_ready,is_active) values(${q(owner)},'bingo','{"size":3,"linePrizeId":null}',false,false);`,/feature_disabled/),"grandfathered links do not authorize disabled new Bingo games");
  await sql(`update public.fans set break_until=now()+interval '1 day' where id=${q(heldFan.fan)};`);
  const onBreak=await rpc("prepare_spin_attempt",[q(randomUUID()),q(heldFan.token),q(hash('bingo-break'))]);check(onBreak.status==="declined"&&onBreak.error==="on_break"&&(await card(heldFan)).status==="ok","break blocks new paid attempts while preserving read-only card visibility");

  {
  // Scalar last-stock replay with a focused/happy-hour primary. Line bonuses
  // retain base tickets and consume no extra credit, seed or focus use.
  await sql(`select public.set_prize_delivery(${q(codeLine)},${q(owner)},'manual');`);
  const scalarFan=await addFan(codeWheel),scalarFirst=await play(scalarFan,{notCenter:true,centerCommon:true}),scalarState=(await card(scalarFan)).card,scalarCenter=scalarState.cells[4].id;
  for(const cell of scalarState.cells){if(cell.id===scalarCenter||cell.id===scalarFirst.out.prize.id)continue;await play(scalarFan,{target:cell.id});}
  await sql(`update public.prizes set stock=1 where id=${q(codeLine)};insert into public.happy_hours(creator_id,wheel_id,multiplier,starts_at,ends_at) values(${q(owner)},${q(codeWheel)},5,now()-interval '1 minute',now()+interval '1 hour');`);
  const focusPack=randomUUID();await sql(`insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,focus_multiplier,focus_spins) values(${q(focusPack)},${q(owner)},'Bingo focus',5,'focus',3,5);`);
  const focused=await rpc("grant_focus_pack",[q(randomUUID()),q(owner),q(scalarFan.fan),q(scalarFan.pass),q(focusPack),q(scalarCenter),q(owner)]);
  check(focused.status==="granted","paid primary focus works on a grandfathered Bingo link");
  const attempt=await prep(scalarFan),body=await build(attempt,{target:scalarCenter});
  check(body.generated.snapshot.modifiers.happyHour.multiplier===5&&body.generated.snapshot.bingo.bonus.fallback.every(p=>p.w===1),"happy-hour primary retains ordinary base tickets for rare line fallback");
  const before=(await sql(`select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${q(scalarFan.pass)};`)).trim(),failure=await commit(scalarFan,attempt,body);
  check(failure.status==="sold_out"&&failure.prizeId===codeLine&&failure.line===body.generated.presentation.newLines[1],"second provisional scalar line reports last-stock exhaustion");
  check((await sql(`select (select stock from public.prizes where id=${q(codeLine)})||','||(select spins_remaining||','||next_spin_nonce from public.fan_passes where id=${q(scalarFan.pass)})||','||(select spins_left from public.fan_focus where id=${q(focused.focus.id)});`)).trim()===`1,${before},5`,"scalar failure rewinds stock/credit/nonce/focus before returning");
  const forward=await build(attempt,{target:scalarCenter,clientSeed:body.generated.clientSeed,failures:[{line:failure.line,excluded:[codeLine]}]}),win=await commit(scalarFan,attempt,forward);
  check(win.status==="committed"&&win.bonusWins.length===4&&win.bonusWins[0].prize.id===codeLine&&win.bonusWins.slice(1).every(x=>x.prize.id!==codeLine),"scalar retry preserves the first selected bonus and pays later rare fallbacks");
  check((await sql(`select spins_left from public.fan_focus where id=${q(focused.focus.id)};`)).trim()==="4","one primary plus four bonuses consumes exactly one purchased focus use");

  }
  // Real RLS reads are nonvacuous; direct writes cannot bypass the sole ledger.
  for(const table of["bingo_cards","bingo_line_awards"]){
   const own=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${q(owner)},true);select count(*) from public.${table} where creator_id=${q(owner)};rollback;`)).trim().split("\n").at(-1);
   const cross=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${q(other)},true);select count(*) from public.${table} where creator_id=${q(owner)};rollback;`)).trim().split("\n").at(-1);
   check(Number(own)>0&&cross==="0",`${table} has real own metadata and no cross-tenant read`);
   check(await refused(`set role anon;select * from public.${table};`,/permission denied/),`anon cannot read ${table}`);
   check(await refused(`set role authenticated;insert into public.${table} default values;`,/permission denied/),`creator cannot mutate ${table} directly`);
  }
  for(const name of ["_bingo_completed_lines","_bingo_cells_valid","_bingo_public_state","_bingo_ready_error","_guard_bingo_state_write","_guard_bingo_prize_change","_guard_bingo_wheel_lifecycle","_game_actor_edit_allowed","_validate_bingo_presentation","_validate_bingo_snapshot","_commit_bingo_bonus"]){
   check((await sql(`select bool_and(not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute') and not has_function_privilege('service_role',oid,'execute')) from pg_proc where pronamespace='public'::regnamespace and proname=${q(name)};`)).trim()==="t",`${name} cannot bypass the sole attempt/publish boundary`);
  }
  await sql(`grant select on public.spins to authenticated;`);
  const ownKinds=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${q(owner)},true);select count(*) from public.spins where creator_id=${q(owner)} and kind='bonus' and parent_spin_id is not null and bingo_line between 0 and 7;rollback;`)).trim().split("\n").at(-1);
  const crossKinds=(await sql(`begin;set local role authenticated;select set_config('request.jwt.claim.sub',${q(other)},true);select count(*) from public.spins where creator_id=${q(owner)} and kind='bonus';rollback;`)).trim().split("\n").at(-1);
  check(Number(ownKinds)>0&&crossKinds==='0',"creator analytics can read kind/parent/line only for its own real bonus rows");
  check((await rpc("get_bingo_card_state",[q("foreign-token")])).status==="unavailable","unknown token cannot read personal Bingo progress");
  for(const name of["save_game_wheel","get_bingo_card_state"]){check((await sql(`select bool_and(not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute')) from pg_proc where pronamespace='public'::regnamespace and proname=${q(name)};`)).trim()==="t",`${name} denies both browser roles`);}
  check(await refused(`update public.bingo_cards set marked_mask=511 where fan_id=${q(fan.fan)};`,/use atomic bingo attempt/),"service cannot directly forge paid card progress");
  await sql(`delete from public.fans where id=${q(fan.fan)};`);
  check((await sql(`select (select count(*) from public.bingo_cards where fan_id=${q(fan.fan)})||','||(select count(*) from public.bingo_line_awards where fan_id=${q(fan.fan)})||','||(select count(*) from public.spins where id=${q(final.id)} or parent_spin_id=${q(final.id)});`)).trim()==="0,0,5","fan erasure removes private card/award state and keeps anonymous parent plus four bonus proofs");
  await sql(`delete from public.fans where id=${q(codeFan.fan)};`);
  check((await sql(`select count(*) from public.spin_rewards where spin_id in(${disclosed.map(q).join(",")}) and cipher is null and iv is null and erased_at is not null and views=1;`)).trim()==="2","fan erasure clears primary/bonus values while retaining their truthful disclosure counts");
  console.log(`PASS0061 ${checks} Bingo checks: real pure RNG card/multi-line proofs, atomic retry/rollback, zero-weight line prize, lifecycle, RLS and erasure`);
 }finally{
  bridge.stdin.end();await Promise.allSettled([...pending]);
  await sql(`drop trigger if exists zz_bingo_probe_fault on public.bingo_line_awards;drop function if exists public._bingo_probe_fault();drop trigger if exists zz_bingo_publish_fault on public.prizes;drop function if exists public._bingo_publish_fault();delete from auth.users where id in(${q(owner)},${q(other)});`);
 }
}
