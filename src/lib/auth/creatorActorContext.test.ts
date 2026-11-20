import assert from "node:assert/strict";
import {issueCreatorActorContext} from "./creatorActorContext";
import type {createClient} from "@/lib/supabase/server";
const creator="11111111-1111-4111-8111-111111111111",context="22222222-2222-4222-8222-222222222222";
let checks=0;const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks++;};
async function main(){
 for(const scope of ["grant","edit_wheel","reconcile","system_health"] as const){
  const session={rpc:async(name:string,args:unknown)=>{assert.equal(name,"issue_creator_actor_context");assert.deepEqual(args,{p_creator:creator,p_permission:scope});return{data:context,error:null};}} as unknown as Awaited<ReturnType<typeof createClient>>;
  check(await issueCreatorActorContext(session,creator,scope)===context,"actual authenticated RPC provides scoped capability without actor/aal hints");
 }
 for(const data of [null,false,{},[],"bad",{id:context},{aal:"aal2",actor:creator}]){
  const session={rpc:async()=>({data,error:null})} as unknown as Awaited<ReturnType<typeof createClient>>;
  check(await issueCreatorActorContext(session,creator,"grant")===null,"malformed response fails closed");
 }
 const denied={rpc:async()=>({data:context,error:{code:"42501"}})} as unknown as Awaited<ReturnType<typeof createClient>>;
 check(await issueCreatorActorContext(denied,creator,"grant")===null,"RPC failure cannot use an apparent capability");
 const failed={rpc:async()=>{throw Error("PRIVATE transport failure");}} as unknown as Awaited<ReturnType<typeof createClient>>;
 check(await issueCreatorActorContext(failed,creator,"grant")===null,"transport error is controlled without sensitive output");
 console.log(`creator actor context helper: ${checks} checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
