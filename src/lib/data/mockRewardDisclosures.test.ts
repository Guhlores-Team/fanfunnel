import assert from "node:assert/strict";
import { mockAckFan,mockCreatePass,mockExportCreatorData,mockExportFanData,mockGetFanPass,mockGetWheel,mockReadSpinAttempt,mockSaveWheel,mockSetFanBlocked,mockSetPrizeDelivery,mockSpin,mockTakeBreak } from "./mock";
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){
 const wheel=mockGetWheel();mockSaveWheel({...wheel,prizes:[{id:"private-prize",label:"Private",rarity:"common",weight:1},{id:"manual",label:"Manual",rarity:"common",weight:0}]});
 mockSetPrizeDelivery("private-prize","text","PRIVATE-VIEW-BOUNDARY");const fan=mockCreatePass("Viewer",3);mockAckFan(fan.token);
 const before=(await mockGetFanPass(fan.token))!,intent={requestId:crypto.randomUUID(),clientSeed:"view",publishedSeedHash:before.nextSpinHash!};
 const win=await mockSpin(fan.token,intent.clientSeed,intent.requestId,intent.publishedSeedHash);assert.ok(!("error"in win));
 const count=()=>mockExportFanData(fan.token)!.instantReceipts.find(receipt=>receipt.spinId===win.shareId)!.views;
 check("initial plaintext response records one view",win.reward?.value==="PRIVATE-VIEW-BOUNDARY"&&count()===1);
 const retry=await mockSpin(fan.token,intent.clientSeed,intent.requestId,intent.publishedSeedHash);check("exact retry logs its actual disclosure without another debit",!("error"in retry)&&retry.reward?.value==="PRIVATE-VIEW-BOUNDARY"&&retry.spinsRemaining===2&&count()===2);
 const status=await mockReadSpinAttempt(fan.token,intent);check("status disclosure is logged once",status.status==="committed"&&status.result.reward?.value==="PRIVATE-VIEW-BOUNDARY"&&count()===3);
 await mockGetFanPass(fan.token);mockExportCreatorData();mockExportFanData(fan.token);check("metadata/history/export reads do not log value views",count()===3);
 mockTakeBreak(fan.token,24*60*60*1000);const duringBreak=await mockReadSpinAttempt(fan.token,intent);check("private recovery remains readable and logged during a break",duringBreak.status==="committed"&&count()===4);
 const global=globalThis as unknown as {__ffRewards:{deliveries:Map<string,{value:string;views:number}>}};
 const deliveries=global.__ffRewards.deliveries,originalGet=deliveries.get;
 deliveries.get=()=>{throw new Error("view log unavailable");};const unknown=await mockReadSpinAttempt(fan.token,intent);deliveries.get=originalGet;
 check("failed view logging withholds plaintext and preserves recovery",unknown.status==="pending"&&count()===4&&(await mockGetFanPass(fan.token))!.spinsRemaining===2);
 const recovered=await mockReadSpinAttempt(fan.token,intent);check("same saved attempt recovers after logging returns",recovered.status==="committed"&&recovered.result.shareId===win.shareId&&count()===5);
 mockSetFanBlocked(fan.fanId,true);check("blocked links reveal and log nothing",(await mockReadSpinAttempt(fan.token,intent)).status==="unavailable"&&count()===5);
 console.log(`mock reward disclosures: ${passed} checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
