import assert from "node:assert/strict";
import { mock } from "node:test";
const bonus:Record<string,unknown>={id:"bonus",share_id:"bonus-share",kind:"bonus",parent_spin_id:"primary",bingo_line:4,prize_id:"bonus-prize",prize_label:"Line prize",prize_rarity:"rare",created_at:"2026-10-28T00:00:00Z",fair_version:null,server_seed:null,server_seed_hash:null,nonce:null,fan_id:"PRIVATE-FAN",token:"PRIVATE-TOKEN",value:"PRIVATE-VALUE"};
const parent:Record<string,unknown>={id:"primary",share_id:"parent-share",kind:"play"};
let failed=false;
const client={from:(table:string)=>{assert.equal(table,"spins");const filters:((row:Record<string,unknown>)=>boolean)[]=[];const query:Record<string,unknown>={select:()=>query,eq:(key:string,value:unknown)=>{filters.push(row=>row[key]===value);return query;},maybeSingle:async()=>({data:failed?null:[bonus,parent].find(row=>filters.every(test=>test(row)))??null,error:failed?{message:"unavailable"}:null})};return query;}};
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createServiceClient:()=>client,createClient:async()=>{throw new Error("public proof must use service reader");}}});
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){const {getSpinVerification}=await import("./boosts");
 const view=await getSpinVerification("bonus-share");
 check("bonus with no independent seed resolves its paid parent's public proof",view?.parent?.shareId==="parent-share"&&view.parent.line===4&&view.parent.prizeId==="bonus-prize"&&!view.serverSeed&&!view.hashOk);
 check("public bonus projection excludes private row metadata",!JSON.stringify(view).includes("PRIVATE-"));
 bonus.parent_spin_id="missing";check("missing parent cannot claim verified linkage",await getSpinVerification("bonus-share")===null);bonus.parent_spin_id="primary";
 bonus.bingo_line=8;check("nonexistent Bingo line is refused",await getSpinVerification("bonus-share")===null);bonus.bingo_line=4;
 parent.kind="bonus";check("a bonus cannot recursively supply another bonus proof",await getSpinVerification("bonus-share")===null);parent.kind="play";
 bonus.kind="play";check("seedless historical play still has no independent proof",await getSpinVerification("bonus-share")===null);bonus.kind="bonus";
 failed=true;check("unavailable public proof remains unknown",await getSpinVerification("bonus-share")===null);
 console.log(`Bingo public verification: ${passed} checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
