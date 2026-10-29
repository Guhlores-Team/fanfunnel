// Disposable PostgreSQL fixture only: actual pure game engine, bounded synthetic
// inputs and client-seed search. No server client, credential or network access.
import {createInterface} from "node:readline";
import {buildBingoPoolSnapshot,hashGamePoolSnapshot,primarySnapshot} from "../../src/lib/games/core/gameProof";
import {makeGameRngV3} from "../../src/lib/games/core/fairness";
import {finishGameWithFailures,type BonusFailurePlan} from "../../src/lib/games/core/play";
import {drawFromSnapshot} from "../../src/lib/games/wheel/fairnessV3";
import type {Prize,WheelConfig} from "../../src/lib/games/core/types";
import type {BingoState} from "../../src/lib/games/bingo/engine";
interface Context {
 wheel:{title:string;game_config:{size:3;linePrizeId:string}};wheelId:string;serverSeed:string;nonce:number;pityCounter:number;happyHourMultiplier:number|null;
 prizes:{id:string;label:string;rarity:Prize["rarity"];weight:number;emoji:string|null;delivery:Prize["delivery"];stock:number|null;image_url:string|null}[];
 focus:{kind:string;prize_id:string;multiplier:number;spins_left:number;total_spins:number;chase_counter:number}|null;
 reservation:{kind:string;prize_id:string}|null;bingoCard:{cells:BingoState["cells"];marked_mask:number;awarded_lines_mask:number;version:number}|null;
}
let requests=0;
async function fixture(raw:string){
 if(++requests>512||Buffer.byteLength(raw)>1048576)throw Error("Fixture bound exceeded");
 const input=JSON.parse(raw) as{context:Context;excluded?:string[];failures?:BonusFailurePlan[];target?:string;notCenter?:boolean;centerCommon?:boolean;clientSeed?:string};
 const c=input.context;if(!c||!Array.isArray(c.prizes)||c.prizes.length>50||!c.wheel?.game_config||!/^[a-f0-9]{64}$/.test(c.serverSeed)||(input.excluded?.length??0)>50||(input.failures?.length??0)>4)throw Error("Invalid synthetic Bingo context");
 const config:WheelConfig={id:c.wheelId,title:c.wheel.title,prizes:c.prizes.map(p=>({id:p.id,label:p.label,rarity:p.rarity,weight:p.weight,emoji:p.emoji??undefined,delivery:p.delivery,imageUrl:p.image_url,
  stock:p.stock==null?null:Math.max(0,p.stock-(c.reservation?.prize_id===p.id&&["stock","code"].includes(c.reservation.kind)?1:0))}))};
 const f=c.focus,options={happyHourMultiplier:c.happyHourMultiplier,pityCounter:c.pityCounter,
  ...(f?.kind==="focus"?{focus:{prizeId:f.prize_id,multiplier:f.multiplier,spinsLeft:f.spins_left,totalSpins:f.total_spins}}:{}),
  ...(f?.kind==="chase"?{chase:{prizeId:f.prize_id,counter:f.chase_counter,within:f.total_spins,reserved:!!c.reservation}}:{})};
 const before=c.bingoCard?{cells:c.bingoCard.cells,markedMask:c.bingoCard.marked_mask,awardedLinesMask:c.bingoCard.awarded_lines_mask,version:c.bingoCard.version}:null;
 const snapshot=buildBingoPoolSnapshot(config,options,c.wheel.game_config,before),poolHash=await hashGamePoolSnapshot(snapshot);
 for(let n=0;n<(input.clientSeed?1:5000);n++){
  const clientSeed=input.clientSeed??`bingo-pg-fixture:${n}`,rng=await makeGameRngV3(c.serverSeed,clientSeed,c.nonce,poolHash),excluded=new Set<string>();
  for(const id of input.excluded??[]){if(excluded.has(id)||drawFromSnapshot(primarySnapshot(snapshot),excluded,rng).prize.id!==id)throw Error("Invalid fixture primary exclusion");excluded.add(id);}
  const primary=drawFromSnapshot(primarySnapshot(snapshot),excluded,rng);
  if(input.target&&primary.prize.id!==input.target)continue;
  const played=finishGameWithFailures(snapshot,primary,{excluded:[...excluded],won:primary.prize.id},rng,input.failures??[]);
  if(input.notCenter&&(played.presentation.kind!=="bingo"||played.presentation.markedIndex===4||played.presentation.markedIndex===null))continue;
  if(input.centerCommon&&(played.presentation.kind!=="bingo"||played.presentation.after.cells[4].rarity!=="common"))continue;
  return{snapshot,poolHash,clientSeed,...played};
 }
 throw Error("Bounded client-seed fixture search exhausted");
}
async function main(){for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){try{process.stdout.write(JSON.stringify({ok:true,value:await fixture(line)})+"\n");}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e instanceof Error?e.message:"fixture_error"})+"\n");}}}
void main();
