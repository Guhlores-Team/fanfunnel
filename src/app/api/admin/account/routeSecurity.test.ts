import assert from "node:assert/strict";
import { mock } from "node:test";
let mode:"last"|"pending"|"denied"|"missing"|"success"="last";
let signedIn=true;let adminAllowed=true;let writes=0;const audits:Record<string,unknown>[]=[];
const target="00000000-0000-4000-8000-0000000062aa";
const client={
 auth:{getUser:async()=>({data:{user:signedIn?{id:"real-admin"}:null}}),getSession:async()=>({data:{session:{access_token:`h.${Buffer.from(JSON.stringify({aal:"aal2"})).toString("base64url")}.s`}}})},
 rpc:async()=>({data:adminAllowed,error:null}),
 from:()=>{
  const query={update:()=>{writes++;return query;},eq:()=>query,select:()=>query,maybeSingle:async()=>({data:mode==="success"?{id:target}:null,error:mode==="last"?{code:"P0001",message:"last_active_admin"}:mode==="pending"?{code:"42501",message:"account cleanup pending"}:mode==="denied"?{code:"42501",message:"admin authorization changed"}:null})};
  return query;
 }
};
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createClient:async()=>client,createServiceClient:()=>{throw Error("no privileged service write in account update");}}});
let checks=0;const check=(value:unknown,message:string)=>{assert.ok(value,message);checks++;};
async function main(){
 const {updateAccount}=await import("@/lib/data/admin");
 mock.module("@/lib/data",{namedExports:{updateAccount,recordAudit:async(row:Record<string,unknown>)=>{audits.push(row);}}});
 const {POST}=await import("./route");
 const request=()=>new Request("https://example.test/api/admin/account",{method:"POST",body:JSON.stringify({id:target,isActive:false})});
 for(const [next,status,error] of [["last",409,"last_admin"],["pending",409,"account_cleanup_pending"],["denied",403,"forbidden"],["missing",404,"not_found"]] as const){
  mode=next;const response=await POST(request());check(response.status===status,`${next} has truthful HTTP status`);check((await response.json()).error===error,`${next} has stable error`);check(audits.length===0,"refusal never records success audit");
 }
 mode="success";const success=await POST(request());check(success.status===200,"confirmed updated row succeeds");check(audits.length===1&&audits[0].action==="account.suspend","only confirmed mutation records success audit");check(audits[0].actorId==="real-admin"&&audits[0].targetId===target,"audit uses verified actor and exact target");
 const before=writes;signedIn=false;check((await POST(request())).status===401,"anonymous request is refused before mutation");check(writes===before&&audits.length===1,"anonymous request has no mutation or audit");
 signedIn=true;adminAllowed=false;check((await POST(request())).status===403,"normal creator cannot use admin update");check(writes===before&&audits.length===1,"non-admin request has no mutation or audit");
 console.log(`admin account refusals/audit: ${checks} checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
