// Invoked ONLY by the disposable local PostgreSQL probe. Every mocked transport
// operation executes real RLS/SQL through the parent bridge; no hosted target.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const actor=process.env.FF_FIXTURE_ACTOR!,creator=process.env.FF_FIXTURE_CREATOR!,grant=process.env.FF_FIXTURE_GRANT!,sid=process.env.FF_FIXTURE_SESSION!;
if(!actor||!creator||!grant||!sid)throw Error("local actor fixture identifiers required");
let seq=0;const pending=new Map<number,{resolve:(v:string)=>void;reject:(e:Error)=>void}>();
createInterface({input:process.stdin}).on("line",line=>{const result=JSON.parse(line),p=pending.get(result.id);if(!p)return;pending.delete(result.id);if(result.error)p.reject(Error(result.error));else p.resolve(result.data);});
const sql=(statement:string)=>new Promise<string>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});process.stdout.write(JSON.stringify({id,sql:statement})+"\n");});
const q=(v:unknown)=>v===null?"null":typeof v==="number"?String(v):typeof v==="object"?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:`'${String(v).replaceAll("'","''")}'`;
let aal="aal2",calls=0,revoke=false,lost=0;const contexts:string[]=[];const requests:string[]=[];
const authSql=(body:string)=>`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claim.sub',${q(actor)},true);perform set_config('request.jwt.claims',${q(JSON.stringify({sub:actor,role:'authenticated',aal,session_id:sid,exp:Math.floor(Date.now()/1000)+3600}))},true);end$$;${body};commit;`;
const result=(out:string)=>JSON.parse(out.trim().split('\n').at(-1)||"null");
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createClient:async()=>({
 auth:{getUser:async()=>({data:{user:{id:actor,user_metadata:{role:"admin",aal:"aal2",mfa_verified:true}}},error:null})},
 from:(table:string)=>{assert.equal(table,"grants");let id="";const chain={select:()=>chain,eq:(_name:string,value:string)=>{id=value;return chain;},maybeSingle:async()=>({data:result(await sql(authSql(`select row_to_json(x) from(select id,creator_id from public.grants where id=${q(id)})x`))),error:null})};return chain;},
 rpc:async(name:string,args:Record<string,unknown>)=>{assert.ok(["can_act_for","issue_creator_actor_context"].includes(name));const body=name==="can_act_for"?`select to_json(public.can_act_for(${q(args.target_creator)},${q(args.perm)}))`:`select to_json(public.issue_creator_actor_context(${q(args.p_creator)},${q(args.p_permission)}))`;try{return{data:result(await sql(authSql(body))),error:null};}catch{return{data:null,error:{code:"42501"}};}}
 }),createServiceClient:()=>({rpc:async(name:string,args:Record<string,unknown>)=>{
 assert.equal(name,"edit_pass_grant");calls++;contexts.push(String(args.p_context));requests.push(String(args.p_request));
 if(revoke){revoke=false;await sql(`update public.profiles set is_active=false where id=${q(actor)};`);}
 const statement=`begin;set local role service_role;select public.edit_pass_grant(${Object.entries(args).map(([k,v])=>`${k}=>${q(v)}`).join(',')});commit;`;
 const data=result(await sql(statement));if(lost-->0)throw Error("local simulated lost transport reply");return{data,error:null};
 }})}});
mock.module("@/lib/data",{namedExports:{editGrant:async(id:string,patch:Record<string,unknown>,requestId:string)=>(await import("../../src/lib/data/fans")).editGrant(id,patch,requestId)}});
let checks=0;const check=(ok:unknown,message:string)=>{assert.ok(ok,message);checks++;};
async function main(){
 const {PATCH}=await import("../../src/app/api/grants/[id]/route");
 const send=(id:string,spins:number,extra:Record<string,unknown>={})=>PATCH(new Request("http://localhost/api/grants/local",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:id,spins,...extra})}),{params:Promise.resolve({id:grant})});
 const id=randomUUID();lost=1;let response=await send(id,3,{p_context:randomUUID(),actorId:randomUUID(),aal:"aal2"});let body=await response.json();
 check(response.status===200&&body.replayed===true,"actual aal2 route and data helper reach real service gateway; lost reply replays");
 check(calls===2&&contexts[0]===contexts[1]&&requests.every(value=>value===id),"transport retry preserves context, economic UUID and payload");
 const first=contexts[0];response=await send(id,3);body=await response.json();check(response.status===200&&body.replayed===true&&contexts.at(-1)!==first,"new HTTP retry mints fresh context while original economic UUID remains committed");
 check(body.requestId===id&&Object.keys(body).sort().join()==="grantId,ok,replayed,requestId","safe HTTP receipt contains no capability/session/token or obsolete grant terms");
 aal="aal1";const before=calls;response=await send(randomUUID(),4,{aal:"aal2",mfaVerified:true});check(response.status!==200&&calls===before,"verified-factor AAL1 route cannot reach service even with forged browser flags/metadata");
 aal="aal2";revoke=true;response=await send(randomUUID(),4);check(response.status===403,"permission revoked after route admission is refused by actual gateway");
 await sql(`update public.profiles set is_active=true where id=${q(actor)};`);
 response=await send(randomUUID(),1);check(response.status===200,"legitimate new edit after permission restoration remains available");
 process.stdout.write(JSON.stringify({done:true,checks})+"\n");process.exit(0);
}
main().catch(()=>{process.stdout.write(JSON.stringify({failed:true})+"\n");process.exit(1);});
