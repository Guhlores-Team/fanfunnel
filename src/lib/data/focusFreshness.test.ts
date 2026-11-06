import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mock } from "node:test";
import { sealReward } from "@/lib/rewards/crypto";
import type { createServiceClient } from "@/lib/supabase/server";
process.env.REWARD_ENCRYPTION_KEY=randomBytes(32).toString("base64");delete process.env.REWARD_ENCRYPTION_KEY_VERSION;
const id=crypto.randomUUID(),focus={kind:"focus",prize_id:"promised-prize",prize_label:"Saved promise",multiplier:3,total_spins:10,spins_left:9,status:"active"},sealed=sealReward("PRIVATE-KNOWN-PROMISE","creator");
let mode:"error"|"active"|"absent"|"malformed"|"unavailable"|"throws"="error",logs=0;
const receipt=()=>({status:"committed",id,shareId:"same-share",balance:2,nextServerSeedHash:"a".repeat(64),focus,spin:{id,creator_id:"creator",fan_id:"fan",prize_id:"won",prize_label:"Actual win",prize_rarity:"common"},prize:{id:"won",label:"Actual win",rarity:"common",weight:1},reward:{kind:"text",...sealed}});
function from(table:string){const q:Record<string,unknown>={};for(const method of["select","eq","gte","lte","is"])q[method]=()=>q;q.maybeSingle=async()=>({data:table==="fan_passes"?{is_active:true,self_excluded_at:null,fan:{blocked_at:null}}:null,error:null});q.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[],count:1,error:null}).then(resolve);return q;}
const client={from,rpc:async(name:string,args:Record<string,unknown>)=>{
 if(name==="get_spin_attempt_status"||name==="prepare_spin_attempt"){assert.equal(args.p_attempt,id);return {data:receipt(),error:null};}
 if(name==="get_fan_focus_state"){if(mode==="throws")throw new Error("temporary focus failure");return mode==="error"?{data:null,error:{code:"PGRST000"}}:{data:mode==="malformed"?{status:"ok"}:mode==="unavailable"?{status:"unavailable"}:{status:"ok",focus:mode==="absent"?null:focus},error:null};}
 if(name==="record_fan_reward_views"){logs++;assert.deepEqual(args,{p_spins:[id],p_token:"token"});return {data:1,error:null};}
 throw new Error(`unexpected economic writer ${name}`);
}} as unknown as ReturnType<typeof createServiceClient>;
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createClient:async()=>client,createServiceClient:()=>client}});
mock.module("@/lib/api/fanToken",{namedExports:{withFanToken:async(_req:Request,_options:unknown,work:(token:string)=>Promise<Response>)=>work("token")}});
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){const {readSpinAttempt,commitSpinAttempt}=await import("./spinAttempts"),{getFanFocusDisplay,getFanFocusState}=await import("./focus"),intent={requestId:id};
 check("unknown fresh focus cannot overwrite a saved nine-spin promise",(await readSpinAttempt("token",intent,client)).status==="pending");
 check("unknown focus releases no plaintext and records no disclosure",logs===0);
 const attempt=await commitSpinAttempt("token",intent,client);check("same-UUID commit recovery remains pending without any new award","error"in attempt&&attempt.error==="spin_pending"&&logs===0);
 await assert.rejects(()=>getFanFocusDisplay("token",client));passed++;
 check("polling reports explicit unavailable instead of authoritative absence","error"in await getFanFocusState("token"));
 mock.module("@/lib/data",{namedExports:{getFanFocusState}});const {POST}=await import("@/app/api/fan/focus/route");
 const response=await POST(new Request("http://localhost/api/fan/focus",{method:"POST",body:JSON.stringify({token:"token"})}));const body=await response.json();
 check("polling HTTP response is503/no-store and does not clear focus",response.status===503&&body.error==="db_error"&&!Object.hasOwn(body,"focus")&&response.headers.get("Cache-Control")==="no-store");
 mode="active";const recovered=await readSpinAttempt("token",intent,client);
 check("successful retry returns the same immutable receipt and real promise",recovered.status==="committed"&&recovered.result.attemptId===id&&recovered.result.shareId==="same-share"&&recovered.result.focus?.spinsLeft===9&&recovered.result.reward?.value==="PRIVATE-KNOWN-PROMISE"&&logs===1);
 mode="absent";const absent=await readSpinAttempt("token",intent,client);check("only explicit successful focus:null authorizes clearing",absent.status==="committed"&&absent.result.focus===null&&logs===2);
 mode="malformed";check("missing focus field is unknown rather than absence",(await readSpinAttempt("token",intent,client)).status==="pending"&&logs===2);
 mode="unavailable";const unavailable=await getFanFocusState("token");check("closed or raced focus resolution remains a controlled failure","error"in unavailable&&unavailable.error==="db_error");
 mode="throws";check("thrown transport failure retains the same attempt",(await readSpinAttempt("token",intent,client)).status==="pending"&&logs===2);
 console.log(`focus freshness: ${passed} causal checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
