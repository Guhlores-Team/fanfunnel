import assert from "node:assert/strict";
import { mockAckFan,mockClearMyData,mockCreatePass,mockDeleteFan,mockGetPrizeRoi,mockGetProfitSummary,mockGetWheel,mockSaveWheel,mockSpin } from "./mock";
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){
 mockClearMyData();const wheel=mockGetWheel(),cheap=crypto.randomUUID(),costly=crypto.randomUUID();
 const prizes=[{id:cheap,label:"Gift",rarity:"common" as const,weight:1,cost:1000},{id:costly,label:"Gift",rarity:"common" as const,weight:0,cost:5000}];
 mockSaveWheel({...wheel,prizes});const fan=mockCreatePass("Cost identity",3,undefined,undefined,20000);mockAckFan(fan.token);
 const first=await mockSpin(fan.token);assert.ok(!("error"in first)&&first.prize.id===cheap);
 mockSaveWheel({...mockGetWheel(),prizes:prizes.map(prize=>({...prize,weight:prize.id===costly?1:0}))});
 const second=await mockSpin(fan.token);assert.ok(!("error"in second)&&second.prize.id===costly);
 let profit=mockGetProfitSummary(1),rows=mockGetPrizeRoi(1);
 check("different immutable IDs with the same label keep1000and5000costs",profit.revenueCents===20000&&profit.costCents===6000&&profit.profitCents===14000&&profit.costsComplete&&rows.length===2&&rows.find(row=>row.prizeId===cheap)?.costCents===1000&&rows.find(row=>row.prizeId===costly)?.costCents===5000);
 check("known current estimates never claim stored historical costs",profit.costBasis==="current_prize_cost"&&profit.historicalCostsKnown===false&&rows.every(row=>row.costBasis==="current_prize_cost"&&row.historicalCostsKnown===false));
 mockSaveWheel({...mockGetWheel(),prizes:mockGetWheel().prizes.map(prize=>prize.id===cheap?{...prize,label:"Renamed gift"}:prize)});
 profit=mockGetProfitSummary(1);rows=mockGetPrizeRoi(1);check("renamed prize keeps old win joined by ID",profit.costCents===6000&&profit.costsComplete&&rows.find(row=>row.prizeId===cheap)?.label==="Renamed gift");
 mockSaveWheel({...mockGetWheel(),prizes:mockGetWheel().prizes.map(prize=>prize.id===cheap?{...prize,cost:1200}:prize)});
 check("current cost changes only an explicitly current-cost estimate",mockGetProfitSummary(1).costCents===6200&&mockGetPrizeRoi(1).find(row=>row.prizeId===cheap)?.totalCostCents===1200);
 mockSaveWheel({...mockGetWheel(),prizes:mockGetWheel().prizes.map(prize=>prize.id===cheap?{...prize,cost:0}:prize)});
 check("a real zero current cost remains known",mockGetProfitSummary(1).costCents===5000&&mockGetProfitSummary(1).costsComplete&&mockGetPrizeRoi(1).find(row=>row.prizeId===cheap)?.costCents===0);
 mockSaveWheel({...mockGetWheel(),prizes:mockGetWheel().prizes.map(prize=>prize.id===cheap?{...prize,cost:null}:prize)});
 check("a missing configured current cost is incomplete",!mockGetProfitSummary(1).costsComplete&&mockGetPrizeRoi(1).find(row=>row.prizeId===cheap)?.costCents===null);
 mockSaveWheel({...mockGetWheel(),prizes:mockGetWheel().prizes.filter(prize=>prize.id!==cheap)});
 profit=mockGetProfitSummary(1);rows=mockGetPrizeRoi(1);check("deleted prize cannot borrow the surviving same-label cost",profit.costCents===5000&&!profit.costsComplete&&rows.find(row=>row.prizeId===cheap)?.timesWon===1&&rows.find(row=>row.prizeId===cheap)?.costCents===null);
 const state=globalThis as unknown as {__ffStore:{fans:Map<string,{wins:{shareId:string;prizeId:string|null}[]}>}};
 state.__ffStore.fans.get(fan.fanId)!.wins.find(win=>win.shareId===first.shareId)!.prizeId=null;
 check("NULL legacy/deleted identity remains unknown without label fallback",mockGetPrizeRoi(1).find(row=>row.prizeId===null)?.costCents===null&&!mockGetProfitSummary(1).costsComplete);
 mockDeleteFan(fan.fanId);profit=mockGetProfitSummary(1);rows=mockGetPrizeRoi(1);
 check("anonymous retained reward accounting keeps both award costs/status",profit.costCents===5000&&!profit.costsComplete&&rows.reduce((total,row)=>total+row.timesWon,0)===2&&rows.find(row=>row.prizeId===costly)?.costCents===5000);
 console.log(`mock financial identity: ${passed} causal checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
