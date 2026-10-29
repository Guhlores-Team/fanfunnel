// Disposable TEST-only fixture, invoked by rls-runtime-test.mjs after its
// Production/expected-project guards. It receives the same scoped clients and
// user-cleanup registry; it never discovers credentials or contacts a new host.
import {spawn} from "node:child_process";
import {randomUUID,createHash} from "node:crypto";
const sha=s=>createHash("sha256").update(s).digest("hex");
async function proof(context,target){
 const child=spawn("npx",["tsx","scripts/db/bingoProofFixture.ts"],{cwd:new URL("../../",import.meta.url),stdio:["pipe","pipe","pipe"]});let out="";
 return await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill("SIGTERM");reject(Error("Bingo fixture timed out"));},45000);
  child.stdout.on("data",b=>out+=b);child.stderr.resume();child.on("error",e=>{clearTimeout(timer);reject(e);});
  child.on("close",code=>{clearTimeout(timer);try{if(code!==0)throw Error(`Bingo fixture failed (${code})`);const result=JSON.parse(out.trim());if(!result.ok)throw Error(result.error);resolve(result.value);}catch(e){reject(e);}});
  child.stdin.end(JSON.stringify({context,...(target?{target}:{})})+"\n");
 });
}
export async function testBingoRuntime({admin,a,anonymous,actorA,makeUser,signedClient,must,check}){
 const BG=await makeUser("bingo"),bg=await signedClient(BG.email);
 must(await admin.from("profiles").update({features:{wheel:true,bingo:true}}).eq("id",BG.id).select("id").single(),"enable disposable Bingo creator");
 const wheel=must(await admin.from("wheels").insert({creator_id:BG.id,title:"Bingo draft",game_kind:"bingo",game_config:{size:3,linePrizeId:null},game_ready:false,is_active:false}).select("id").single(),"seed inactive Bingo draft");
 const line=randomUUID(),rows=[...Array.from({length:9},(_,i)=>({id:randomUUID(),label:`Bingo ${i}`,rarity:i===0?"rare":"common",weight:1,emoji:["🍎","🍋","🍉","🍇","🍒","🍓","🥝","🍊","🍌"][i],stock:null,boostable:false})),{id:line,label:"Line reward",rarity:"rare",weight:0,emoji:"🏆",stock:null,boostable:false}];
 const config={title:"Runtime Bingo",game_kind:"bingo",game_config:{size:3,linePrizeId:line}},save={p_wheel:wheel.id,p_creator:BG.id,p_actor:BG.id,p_prizes:rows,p_config:config};
 const saved=await admin.rpc("save_game_wheel",save);if(saved.error)throw Error(`publish runtime Bingo: ${saved.error.message}`);
 const grant=must(await admin.rpc("create_pass_grant",{p_request:randomUUID(),p_creator:BG.id,p_fan:null,p_wheel:wheel.id,p_name:"Bingo fan",p_spins:20,p_bonus:0,p_amount:100,p_campaign:null,p_actor:BG.id}),"seed paid Bingo fan");
 if(grant.status!=="granted")throw Error(`Bingo grant refused ${grant.status}`);
 must(await admin.from("fans").update({acked_at:new Date().toISOString(),acked_terms_version:"2026-10-27"}).eq("id",grant.fanId).select("id").single(),"ack disposable Bingo fan");
 const play=async target=>{
  const id=randomUUID(),binding=sha(id),prepared=must(await admin.rpc("prepare_spin_attempt",{p_attempt:id,p_token:grant.token,p_request_hash:binding}),"prepare real runtime Bingo");
  if(prepared.status!=="ready")throw Error(`Bingo preparation refused ${prepared.status}`);
  const c=prepared.context,g=await proof(c,target),d=g.primary,p=c.prizes.find(x=>x.id===d.prize.id),next=randomUUID().replaceAll("-","").repeat(2);
  const bonuses=g.bonuses.map(b=>{const pr=c.prizes.find(x=>x.id===b.prize.id);return{id:randomUUID(),line:b.line,prize_id:pr.id,prize_label:pr.label,prize_rarity:pr.rarity,prize_image_url:pr.image_url,response_prize:{id:pr.id,label:pr.label,rarity:pr.rarity,weight:pr.weight},expected_reward:{delivery:"manual"}};});
  const spin={id,creator_id:c.creatorId,fan_id:c.fanId,fan_pass_id:c.passId,wheel_id:c.wheelId,campaign_id:c.campaignId,prize_id:p.id,prize_label:p.label,prize_rarity:p.rarity,prize_image_url:p.image_url,server_seed:c.serverSeed,server_seed_hash:c.serverSeedHash,nonce:c.nonce,client_seed:g.clientSeed,fair_version:3,pool_snapshot:g.snapshot,pool_hash:g.poolHash,fair_trace:g.trace,game_kind:"bingo",presentation:g.presentation,bonuses,
   next_pity_counter:d.nextPityCounter,focus_consumed:d.focusConsumed??false,chase_consumed:d.chaseConsumed??false,chase_completed:d.chaseCompleted??false,next_focus_spins_left:d.nextFocusSpinsLeft??null,next_chase_counter:d.nextChaseCounter??null,response_prize:{id:p.id,label:p.label,rarity:p.rarity,weight:p.weight},response_prize_index:c.prizes.findIndex(x=>x.id===p.id),response_show_stock:c.wheel.show_stock};
  const result=must(await admin.rpc("commit_spin_attempt",{p_attempt:id,p_token:grant.token,p_request_hash:binding,p_context:{contextHash:c.contextHash,cardId:c.bingoCard?.id??null,cardVersion:c.bingoCard?.version??null},p_spin:spin,p_expected_reward:{delivery:"manual"},p_next_seed:{seed:next,hash:sha(next)}}),"commit real runtime Bingo");
  if(result.status!=="committed")throw Error(`Bingo commit refused ${result.status}`);return result;
 };
 const first=await play(),cells=first.presentation.after.cells;
 for(const cell of cells.slice(0,3))if(cell.id!==first.prize.id)await play(cell.id);
 for(const table of["bingo_cards","bingo_line_awards"]){
  const own=await bg.from(table).select("creator_id").eq("fan_id",grant.fanId),cross=await a.from(table).select("creator_id").eq("creator_id",BG.id);
  check(!own.error&&own.data?.length>0,`Bingo owner reads real ${table} metadata`);
  check(!cross.error&&cross.data?.length===0,`another creator reads none of Bingo ${table}`);
  check((await bg.from(table).insert({creator_id:BG.id})).error?.code==="42501",`creator cannot insert ${table} directly`);
  const hidden=await anonymous.from(table).select("creator_id").eq("creator_id",BG.id);
  check(!!hidden.error||hidden.data?.length===0,`anon cannot read private ${table}`);
 }
 check((await admin.from("bingo_cards").update({version:999}).eq("fan_id",grant.fanId)).error?.code==="42501","service cannot forge a card outside the sole paid attempt");
 check((await a.rpc("get_bingo_card_state",{p_token:grant.token})).error?.code==="42501","creator role cannot execute token-card service RPC");
 check((await a.rpc("save_game_wheel",save)).error?.code==="42501","creator role cannot execute atomic game saver");
 check((await anonymous.rpc("get_bingo_card_state",{p_token:grant.token})).error?.code==="42501","anon cannot execute token-card RPC");
 check((await anonymous.rpc("save_game_wheel",save)).error?.code==="42501","anon cannot execute atomic game saver");
 check((await admin.rpc("save_game_wheel",{...save,p_actor:actorA})).error?.code==="42501","game saver refuses a forged/missing actual actor");
 const publicCard=must(await admin.rpc("get_bingo_card_state",{p_token:grant.token}),"read safe runtime card");
 check(publicCard.status==="ok"&&publicCard.card&&!("id"in publicCard.card)&&!("fanId"in publicCard.card),"fan DTO excludes database card/fan identity");
 check(must(await admin.rpc("get_bingo_card_state",{p_token:`unknown-${randomUUID()}`}),"unknown token refusal").status==="unavailable","unknown bearer reveals no private Bingo state");
 check((await admin.from("prizes").update({stock:1}).eq("id",cells[0].id)).error?.code==="22023","direct service cannot make a paid active cell finite");
 check((await admin.from("wheels").update({archived_at:new Date().toISOString()}).eq("id",wheel.id)).error?.code==="22023","direct archive cannot discard incomplete paid progress");
 // All rows belong to makeUser's registered UUID; the caller's finally deletes
 // that user and the database cascades cards/awards/spins with it.
}
