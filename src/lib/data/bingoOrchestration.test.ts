import { randomBytes } from "node:crypto";
import { sealReward } from "@/lib/rewards/crypto";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import { buildBingoPoolSnapshot,hashGamePoolSnapshot,primarySnapshot } from "@/lib/games/core/gameProof";
import { drawFromSnapshot } from "@/lib/games/wheel/fairnessV3";
import { makeGameRngV3 } from "@/lib/games/core/fairness";
import { completedLines,safeCell,type BingoState } from "@/lib/games/bingo/engine";
import { replayGameV3 } from "@/lib/games/core/replay";
import { toWheelConfig,type DbWheelRow } from "./shared";
import type { createServiceClient } from "@/lib/supabase/server";
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createServiceClient:()=>{throw new Error("supplied client only");},createClient:async()=>{throw new Error("no session writer");}}});
mock.module("@/lib/afterResponse",{namedExports:{runAfterResponse:()=>{}}});
const prizes=[...Array.from({length:9},(_,i)=>({id:`cell-${i}`,label:`Cell ${i}`,emoji:String(i),rarity:"rare",weight:1,stock:null,delivery:"text",sort_order:i})),{id:"selected",label:"Selected finite",rarity:"epic",weight:0,stock:2,delivery:"text",sort_order:9}];
const wheel={id:"wheel",title:"Bingo",show_stock:true,game_kind:"bingo",game_config:{size:3,linePrizeId:"selected"},game_ready:true};
const before:BingoState={cells:toWheelConfig({...wheel,prizes} as DbWheelRow).prizes.slice(0,9).map(safeCell),markedMask:511^16,awardedLinesMask:completedLines(511^16),version:8};
process.env.REWARD_ENCRYPTION_KEY=randomBytes(32).toString("base64");
const sealed=sealReward("PRIVATE-RECEIPT-VALUE","creator");
let viewBatches=0,viewFailure=false;
let currentCard=structuredClone(before),balance=10,nonce=0,seed="",hash="",commits=0,lose=true,race=true,cardReadFails=false;
const receipts=new Map<string,Record<string,unknown>>(),calls:{name:string;args:Record<string,unknown>}[]=[],proposals:Record<string,unknown>[]=[];
const context=()=>({contextHash:String(nonce),creatorId:"creator",fanId:"fan",passId:"pass",wheelId:"wheel",campaignId:null,serverSeed:seed,serverSeedHash:hash,nonce,pityCounter:0,happyHourMultiplier:null,focus:null,reservation:null,commitment:"stored",wheel,prizes,
  bingoCard:{id:"PRIVATE-CARD-ID",version:currentCard.version,cells:currentCard.cells,marked_mask:currentCard.markedMask,awarded_lines_mask:currentCard.awardedLinesMask,status:currentCard.markedMask===511?"completed":"active"}});
function from(table:string){const q:Record<string,unknown>={};for(const method of["select","eq","gte","lte","is","order","limit"])q[method]=()=>q;q.maybeSingle=async()=>({data:table==="prize_rewards"?{kind:"text",cipher:sealed.cipher,iv:sealed.iv,key_version:sealed.keyVersion}:null,error:null});q.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[],count:commits,error:null}).then(resolve);q.update=q.insert=()=>{throw new Error("no split writer");};return q;}
const client={from,rpc:async(name:string,args:Record<string,unknown>)=>{
  calls.push({name,args:structuredClone(args)});const id=String(args.p_attempt),stored=receipts.get(id);
  const receipt=()=>({...stored,status:"committed",replayed:true,balance,nextServerSeedHash:hash});
  if(name==="record_fan_reward_views"){viewBatches++;assert.equal((args.p_spins as string[]).length,5);assert.ok(!JSON.stringify(args).includes("PRIVATE-RECEIPT-VALUE"));return {data:viewFailure?0:5,error:null};}
  if(name==="get_bingo_card_state")return {data:cardReadFails?null:{status:"ok",card:currentCard},error:cardReadFails?{code:"UNAVAILABLE"}:null};
  if(name==="get_fan_focus_state")return {data:{status:"ok",focus:null,context:{...context(),reserved:false}},error:null};
  if(name==="get_spin_attempt_status")return {data:args.p_token!=="token"?{status:"conflict"}:stored?receipt():{status:"absent"},error:null};
  if(stored)return {data:receipt(),error:null};
  if(name==="prepare_spin_attempt")return {data:{status:"ready",context:context()},error:null};
  if(name!=="commit_spin_attempt")throw new Error(`Unexpected writer ${name}`);
  const spin=args.p_spin as Record<string,unknown>;proposals.push(structuredClone(spin));
  assert.equal((args.p_context as Record<string,unknown>).cardId,"PRIVATE-CARD-ID");assert.equal((args.p_context as Record<string,unknown>).cardVersion,currentCard.version);
  if(race){race=false;return {data:{status:"sold_out",line:4,prizeId:"selected"},error:null};}
  commits++;balance--;nonce++;seed=String((args.p_next_seed as Record<string,unknown>).seed);hash=String((args.p_next_seed as Record<string,unknown>).hash);
  const presentation=spin.presentation as {after:BingoState};currentCard=structuredClone(presentation.after);
  const bonuses=(spin.bonuses as Record<string,unknown>[]).map(bonus=>({line:bonus.line,shareId:`bonus-${bonus.line}`,prize:bonus.response_prize,reward:{kind:"text",cipher:sealed.cipher,iv:sealed.iv,keyVersion:sealed.keyVersion},spin:{id:bonus.id,creator_id:"creator",fan_id:"fan",prize_id:bonus.prize_id,prize_label:bonus.prize_label,prize_rarity:bonus.prize_rarity,created_at:"2026-10-28T00:00:00Z",kind:"bonus",server_seed:null,nonce:null}}));
  const made={status:"committed",id,shareId:`parent-${id}`,spin:{...spin,created_at:"2026-10-28T00:00:00Z"},prize:spin.response_prize,prizeIndex:spin.response_prize_index,showStock:true,balance,nextServerSeedHash:hash,focus:null,reward:{kind:"text",cipher:sealed.cipher,iv:sealed.iv,keyVersion:sealed.keyVersion},gameKind:"bingo",presentation:spin.presentation,bonusWins:bonuses};receipts.set(id,structuredClone(made));
  if(lose){lose=false;return {data:null,error:{code:"LOST_ACK"}};}return {data:made,error:null};
}} as unknown as ReturnType<typeof createServiceClient>;
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){
 const config=toWheelConfig({...wheel,prizes} as DbWheelRow),snapshot=buildBingoPoolSnapshot(config,{pityCounter:0,happyHourMultiplier:null},{size:3,linePrizeId:"selected"},before),poolHash=await hashGamePoolSnapshot(snapshot);
 for(let i=0;i<1000;i++){const candidate=`server-${i}`,rng=await makeGameRngV3(candidate,"client",0,poolHash);if(drawFromSnapshot(primarySnapshot(snapshot),new Set(),rng).prize.id==="cell-4"){seed=candidate;break;}}assert.ok(seed);hash=await sha256Hex(seed);
 const {commitSpinAttempt,readSpinAttempt}=await import("./spinAttempts"),intent={requestId:crypto.randomUUID(),clientSeed:"client",publishedSeedHash:hash};
 const result=await commitSpinAttempt("token",intent,client);assert.ok(!("error"in result),JSON.stringify(result));
 check("one outgoing response logs all five decrypted values once",viewBatches===1&&result.reward?.value==="PRIVATE-RECEIPT-VALUE"&&result.bonusWins?.every(win=>win.reward?.value==="PRIVATE-RECEIPT-VALUE"));
 check("all four lines and primary commit once after a lost response",commits===1&&nonce===1&&balance===9&&result.bonusWins?.length===4&&result.replayed);
 check("stock race preserves the earlier finite winner and replaces only later lines",result.bonusWins![0].prize.id==="selected"&&result.bonusWins!.slice(1).every(win=>win.prize.id!=="selected"));
 const first=(proposals[0].fair_trace as {bonuses:{line:number;excluded:string[]}[]}).bonuses,last=(proposals[1].fair_trace as {bonuses:{line:number;excluded:string[]}[]}).bonuses;
 check("a new earlier failure discards only later generation plans",first.some(trace=>trace.line===6&&trace.excluded.includes("selected"))&&last.some(trace=>trace.line===4&&trace.excluded.includes("selected"))&&!last.find(trace=>trace.line===1)!.excluded.length);
 const spin=proposals[1];check("full immutable primary/card/bonus proof replays",(await replayGameV3({serverSeed:String(spin.server_seed),clientSeed:"client",nonce:0,snapshot:spin.pool_snapshot,poolHash:String(spin.pool_hash),trace:spin.fair_trace,prizeId:String(spin.prize_id),prizeLabel:String(spin.prize_label),presentation:spin.presentation})).ok);
 check("bonus proposals never carry independent seed/debit authority",(spin.bonuses as Record<string,unknown>[]).every(bonus=>!Object.hasOwn(bonus,"server_seed")&&!Object.hasOwn(bonus,"nonce")&&!Object.hasOwn(bonus,"pool_snapshot"))&&calls.filter(call=>call.name==="commit_spin_attempt").length===3);
 check("private card identity never enters public proof or result",!JSON.stringify(spin.pool_snapshot).includes("PRIVATE-CARD-ID")&&!JSON.stringify(result).includes("PRIVATE-CARD-ID"));
 const immutable=JSON.stringify(result.presentation);balance=19;currentCard={...structuredClone(before),version:1,markedMask:1,awardedLinesMask:0};
 const late=await readSpinAttempt("token",intent,client);check("late receipt retains old full presentation beside current card and balance",late.status==="committed"&&late.result.spinsRemaining===19&&JSON.stringify(late.result.presentation)===immutable&&late.result.bingoCard?.markedMask===1);
 const beforeCardFailure=viewBatches;cardReadFails=true;check("unknown current card keeps recovery pending instead of pretending empty",(await readSpinAttempt("token",intent,client)).status==="pending"&&viewBatches===beforeCardFailure);cardReadFails=false;
 check("another token cannot recover linked rewards",(await readSpinAttempt("foreign-token",intent,client)).status==="conflict");
 const stored=receipts.get(intent.requestId)!;const original=stored.bonusWins;stored.bonusWins=[];check("missing bonus receipts cannot acknowledge a multiline paid result",(await readSpinAttempt("token",intent,client)).status==="pending");stored.bonusWins=original;
 viewFailure=true;const failedLog=await readSpinAttempt("token",intent,client);check("failed atomic disclosure logging withholds every value and remains recoverable",failedLog.status==="pending"&&commits===1&&balance===19);viewFailure=false;
 const recovered=await readSpinAttempt("token",intent,client);check("logging recovery returns the same five values without another award",recovered.status==="committed"&&recovered.result.reward?.value==="PRIVATE-RECEIPT-VALUE"&&recovered.result.bonusWins?.length===4&&commits===1);
 const allBonuses=stored.bonusWins as {reward:{cipher:string}}[],savedCipher=allBonuses[0].reward.cipher,beforeDecryptFailure=viewBatches;
 allBonuses[0].reward.cipher="corrupt";check("all values must decrypt before any view batch is recorded",(await readSpinAttempt("token",intent,client)).status==="pending"&&viewBatches===beforeDecryptFailure);allBonuses[0].reward.cipher=savedCipher;
 const primaryReward=stored.reward;stored.reward=null;for(const bonus of allBonuses)(bonus as unknown as {reward:null}).reward=null;
 const beforeMetadata=viewBatches;check("metadata-only receipts do not record private views",(await readSpinAttempt("token",intent,client)).status==="committed"&&viewBatches===beforeMetadata);stored.reward=primaryReward;
 check("no independent card/refund/bonus economic writer is called",calls.every(call=>["prepare_spin_attempt","commit_spin_attempt","get_spin_attempt_status","get_fan_focus_state","get_bingo_card_state","record_fan_reward_views"].includes(call.name)));
 console.log(`Bingo configured orchestration: ${passed} causal checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
