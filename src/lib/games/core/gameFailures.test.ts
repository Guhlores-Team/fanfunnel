import assert from "node:assert/strict";
import { buildBingoPoolSnapshot,hashGamePoolSnapshot,primarySnapshot } from "./gameProof";
import { makeGameRngV3,MAX_GAME_RANDOM_DRAWS } from "./fairness";
import { finishGameWithFailures } from "./play";
import { drawFromSnapshot } from "../wheel/fairnessV3";
import { completedLines,safeCell } from "../bingo/engine";
import { replayGameV3 } from "./replay";
import type { WheelConfig } from "./types";
async function main(){
  const config:WheelConfig={id:"game",title:"Bingo",prizes:[...Array.from({length:9},(_,i)=>({id:`cell-${i}`,label:`Cell ${i}`,emoji:`${i}`,rarity:"common" as const,weight:1})),{id:"fallback",label:"Fallback",emoji:"🎁",rarity:"rare",weight:1},{id:"finite-code",label:"Finite selected code",emoji:"🔑",rarity:"epic",weight:0,stock:1,delivery:"codes"}]};
  const before={cells:config.prizes.slice(0,9).map(safeCell),markedMask:511^16,awardedLinesMask:completedLines(511^16),version:8};
  const snapshot=buildBingoPoolSnapshot(config,{pityCounter:0,happyHourMultiplier:null},{size:3,linePrizeId:"finite-code"},before),hash=await hashGamePoolSnapshot(snapshot);
  let seed="",draws=0;
  for(let i=0;i<1000;i++){const candidate=`seed-${i}`,rng=await makeGameRngV3(candidate,"client",0,hash);if(drawFromSnapshot(primarySnapshot(snapshot),new Set(),rng).prize.id==="cell-4"){seed=candidate;break;}}
  assert.ok(seed);
  const source=await makeGameRngV3(seed,"client",0,hash),rng=()=>{draws++;return source();},primary=drawFromSnapshot(primarySnapshot(snapshot),new Set(),rng);
  const result=finishGameWithFailures(snapshot,primary,{excluded:[],won:primary.prize.id},rng,[{line:4,excluded:["finite-code"]}]);
  assert.equal(result.presentation.kind,"bingo");if(result.presentation.kind!=="bingo")throw new Error("Wrong presentation");
  assert.deepEqual(result.presentation.newLines,[1,4,6,7]);
  assert.equal(result.bonuses[0].prize.id,"finite-code","earlier line retains its successful finite code");
  assert.ok(result.bonuses.slice(1).every(bonus=>bonus.prize.id==="fallback"),"only the exhausted line and later lines use fallback");
  assert.deepEqual(result.trace.bonuses.map(trace=>trace.excluded),[[],["finite-code"],[],[]]);
  assert.ok(draws<=MAX_GAME_RANDOM_DRAWS);
  const replay=await replayGameV3({serverSeed:seed,clientSeed:"client",nonce:0,snapshot,poolHash:hash,trace:result.trace,prizeId:primary.prize.id,prizeLabel:primary.prize.label,presentation:result.presentation});
  assert.ok(replay.ok,"complete output remains publicly replayable");
  assert.equal((await replayGameV3({serverSeed:seed,clientSeed:"client",nonce:0,snapshot,poolHash:hash,trace:{excluded:[],won:primary.prize.id,bonuses:[{line:4,excluded:["finite-code"]}]},prizeId:primary.prize.id,prizeLabel:primary.prize.label,presentation:result.presentation})).ok,false,"incomplete generation failures never verify as proof");
  const bad=await makeGameRngV3(seed,"client",0,hash),pick=drawFromSnapshot(primarySnapshot(snapshot),new Set(),bad);
  assert.throws(()=>finishGameWithFailures(snapshot,pick,{excluded:[],won:pick.prize.id},bad,[{line:4,excluded:["finite-code"]},{line:1,excluded:[]}]),/Invalid generation/);
  console.log("game allocation failures: 10 causal checks passed");
}
main().catch(error=>{console.error(error);process.exit(1);});
