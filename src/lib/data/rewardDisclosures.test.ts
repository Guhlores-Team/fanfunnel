import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mock } from "node:test";
import { sealReward } from "@/lib/rewards/crypto";
import type { createServiceClient } from "@/lib/supabase/server";
process.env.REWARD_ENCRYPTION_KEY=randomBytes(32).toString("base64");delete process.env.REWARD_ENCRYPTION_KEY_VERSION;
const id=crypto.randomUUID(),sealed=sealReward("PRIVATE-DISCLOSURE-VALUE","creator");
let loggingFails=false,loggingThrows=false,attemptedBatches=0,successfulBatches=0;
const reward:{kind:"text";cipher:string;iv:string;keyVersion:number}={kind:"text",...sealed};
let currentReward:typeof reward|null=reward;
const names:string[]=[];
const reply=()=>({status:"committed",id,shareId:"private-share",balance:2,nextServerSeedHash:"a".repeat(64),focus:null,spin:{id,creator_id:"creator",fan_id:"fan",prize_id:"prize",prize_label:"Private prize",prize_rarity:"common",created_at:"2026-10-28T00:00:00Z"},prize:{id:"prize",label:"Private prize",rarity:"common",weight:1},reward:currentReward});
function from(){const q:Record<string,unknown>={};for(const method of["select","eq","gte","is"])q[method]=()=>q;q.maybeSingle=async()=>({data:null,error:null});q.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[],count:1,error:null}).then(resolve);return q;}
const client={from,rpc:async(name:string,args:Record<string,unknown>)=>{names.push(name);
 if(name==="get_fan_focus_state")return {data:{status:"ok",focus:null},error:null};
 if(name==="prepare_spin_attempt"||name==="get_spin_attempt_status")return {data:args.p_token==="token"?reply():{status:"unavailable"},error:null};
 if(name==="record_fan_reward_views"){attemptedBatches++;assert.deepEqual(args,{p_spins:[id],p_token:"token"});if(loggingThrows)throw new Error("log transport unknown");if(!loggingFails)successfulBatches++;return {data:loggingFails?0:1,error:null};}
 throw new Error(`Unexpected RPC ${name}`);
}} as unknown as ReturnType<typeof createServiceClient>;
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createServiceClient:()=>{throw new Error("supplied service only");},createClient:async()=>{throw new Error("no session writer");}}});
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){const {commitSpinAttempt,readSpinAttempt}=await import("./spinAttempts"),{recordRewardDisclosures}=await import("./rewardDisclosures"),intent={requestId:id,clientSeed:"client"};
 const first=await commitSpinAttempt("token",intent,client);check("commit recovery logs its decrypted value once before response",!("error"in first)&&first.reward?.value==="PRIVATE-DISCLOSURE-VALUE"&&successfulBatches===1);
 const status=await readSpinAttempt("token",intent,client);check("status disclosure adds one view with the same immutable receipt",status.status==="committed"&&status.result.shareId==="private-share"&&status.result.reward?.value==="PRIVATE-DISCLOSURE-VALUE"&&successfulBatches===2);
 loggingFails=true;const failed=await readSpinAttempt("token",intent,client);check("failed logging withholds values and keeps the saved attempt recoverable",failed.status==="pending"&&successfulBatches===2);loggingFails=false;
 const recovered=await readSpinAttempt("token",intent,client);check("recovery repeats no award or debit",recovered.status==="committed"&&recovered.result.spinsRemaining===2&&successfulBatches===3);
 const beforeBadCipher=attemptedBatches,saved=reward.cipher;reward.cipher="bad";check("decryption failure records no view and discloses no partial value",(await readSpinAttempt("token",intent,client)).status==="pending"&&attemptedBatches===beforeBadCipher);reward.cipher=saved;
 currentReward=null;const beforeMetadata=attemptedBatches;check("metadata-only receipt never calls the view logger",(await readSpinAttempt("token",intent,client)).status==="committed"&&attemptedBatches===beforeMetadata);currentReward=reward;
 check("foreign token cannot reveal or log a receipt",(await readSpinAttempt("foreign",intent,client)).status==="unavailable"&&attemptedBatches===beforeMetadata);
 loggingThrows=true;check("unknown logger transport also withholds plaintext",(await readSpinAttempt("token",intent,client)).status==="pending");loggingThrows=false;
 const beforeInvalid=attemptedBatches;check("empty value set is a metadata read",await recordRewardDisclosures(client,"token",[]));
 check("duplicates and over-wide batches fail before service access",!await recordRewardDisclosures(client,"token",[id,id])&&!await recordRewardDisclosures(client,"token",Array.from({length:6},()=>crypto.randomUUID()))&&!await recordRewardDisclosures(client,"token",["forged"])&&attemptedBatches===beforeInvalid);
 check("no new financial writer is invoked while logging views",names.every(name=>["prepare_spin_attempt","get_spin_attempt_status","get_fan_focus_state","record_fan_reward_views"].includes(name)));
 console.log(`configured reward disclosures: ${passed} checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
