import assert from "node:assert/strict";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { creatorMfaStepUpResponse } from "./stepUp";
const token=(aal:unknown)=>`h.${Buffer.from(JSON.stringify({aal})).toString("base64url")}.s`;
let checks=0;
const check=(value:unknown,label:string)=>{assert.ok(value,label);checks++;};
async function main(){
 let reads=0;let aal:unknown="aal1";let error=false;let throws=false;
 const client={auth:{getSession:async()=>{reads++;if(throws)throw Error("offline");return{data:{session:{access_token:token(aal)}},error:error?{message:"offline"}:null};}}} as unknown as Pick<SupabaseClient,"auth">;
 const user=(verified:boolean)=>({factors:verified?[{status:"verified"}]:[{status:"unverified"}]}) as Pick<User,"factors">;
 check(await creatorMfaStepUpResponse(client,user(false))===null,"unenrolled/unverified factors keep optional MFA");
 check(reads===0,"optional path does not read a second session");
 const response=await creatorMfaStepUpResponse(client,user(true));
 check(response?.status===403,"verified factor plus password-only session refuses");
 check((await response?.json()).error==="mfa_required","refusal tells the caller how to recover");
 check(response?.headers.get("cache-control")?.includes("no-store"),"MFA refusal cannot be cached");
 aal="aal2";check(await creatorMfaStepUpResponse(client,user(true))===null,"verified challenge allows current session");
 aal="unknown";check((await creatorMfaStepUpResponse(client,user(true)))?.status===403,"unknown assurance refuses");
 error=true;check((await creatorMfaStepUpResponse(client,user(true)))?.status===403,"session read error fails closed");
 throws=true;check((await creatorMfaStepUpResponse(client,user(true)))?.status===403,"session transport failure fails closed");
 console.log(`creator MFA: ${checks} checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
