import "server-only";
import { makeGameRngV3 } from "@/lib/games/core/fairness";
import { primarySnapshot,type GamePoolSnapshot } from "@/lib/games/core/gameProof";
import { finishGameWithFailures,type BonusFailurePlan,type GameDraw } from "@/lib/games/core/play";
import { drawFromSnapshot } from "@/lib/games/wheel/fairnessV3";
/** Reconstruct the same committed stream. Failed cosmetics never shift primary RNG. */
export async function gameProposal(snapshot:GamePoolSnapshot,seed:string,clientSeed:string,nonce:number,hash:string,excluded:readonly string[],failures:readonly BonusFailurePlan[]):Promise<GameDraw> {
  const rng=await makeGameRngV3(seed,clientSeed,nonce,hash),pool=primarySnapshot(snapshot),seen=new Set<string>();
  for(const id of excluded){if(seen.has(id)||drawFromSnapshot(pool,seen,rng).prize.id!==id)throw new Error("Invalid primary stock failure");seen.add(id);}
  const primary=drawFromSnapshot(pool,seen,rng);
  return finishGameWithFailures(snapshot,primary,{excluded:[...excluded],won:primary.prize.id},rng,failures);
}
export function addBonusFailure(plans:readonly BonusFailurePlan[],line:number,prizeId:string):BonusFailurePlan[] {
  // A newly observed failure can alter later RNG picks. Keep every earlier
  // line intact, but regenerate later proposals against the new failure.
  const next=plans.filter(plan=>plan.line<=line).map(plan=>({line:plan.line,excluded:[...plan.excluded]}));
  let plan=next.find(candidate=>candidate.line===line);if(!plan){plan={line,excluded:[]};next.push(plan);next.sort((a,b)=>a.line-b.line);}
  if(next.some(candidate=>candidate.excluded.includes(prizeId)))throw new Error("Repeated stock failure");
  plan.excluded.push(prizeId);return next;
}
