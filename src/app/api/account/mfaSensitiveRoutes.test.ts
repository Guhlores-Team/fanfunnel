import assert from "node:assert/strict";
import { mock } from "node:test";
let verified=true;let aal="aal1";let mutations=0;let serviceCalls=0;let resets=0;
const token=()=>`h.${Buffer.from(JSON.stringify({aal})).toString("base64url")}.s`;
const user=()=>({id:"creator",email:"creator@example.test",factors:verified?[{status:"verified"}]:[]});
const client={auth:{getUser:async()=>({data:{user:user()}}),getSession:async()=>({data:{session:{access_token:token()}},error:null}),updateUser:async()=>{mutations++;return{data:{},error:null};}}};
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createClient:async()=>client,createServiceClient:()=>{serviceCalls++;throw Error("unexpected privileged write");}}});
mock.module("@/lib/api/limit",{namedExports:{rateLimitOr429:async()=>null}});
globalThis.fetch = (async (input: RequestInfo | URL) => {
 const url=String(input instanceof Request ? input.url : input);
 if(!url.includes("example.supabase.co/auth/v1/token")) throw Error("unexpected network destination");
 return Response.json({access_token:"fixture",refresh_token:"fixture",expires_in:3600,token_type:"bearer",user:{id:"creator",aud:"authenticated",email:"creator@example.test"}});
}) as typeof fetch;
mock.module("@/lib/data",{namedExports:{clearMyData:async()=>{resets++;return{ok:true};}}});
process.env.NEXT_PUBLIC_SUPABASE_URL="https://example.supabase.co";process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY="fixture";
let checks=0;const check=(value:unknown,label:string)=>{assert.ok(value,label);checks++;};
const req=(path:string,body:unknown)=>new Request(`https://example.test${path}`,{method:"POST",body:JSON.stringify(body)});
async function main(){
 const email=await import("./email/route");const password=await import("./password/route");const reset=await import("./reset/route");
 const requests=[()=>email.POST(req("/api/account/email",{email:"new@example.test",currentPassword:"Password123456"})),()=>password.POST(req("/api/account/password",{currentPassword:"Password123456",newPassword:"ChangedPassword123456"})),()=>reset.POST(req("/api/account/reset",{confirm:"RESET"}))];
 for(const call of requests){const response=await call();check(response.status===403,"enrolled aal1 sensitive mutation refuses");check((await response.json()).error==="mfa_required","refusal is explicit step-up");}
 process.env.ADMIN_EMAILS="creator@example.test";
 const {claimAdmin}=await import("@/lib/data/admin");
 check((await claimAdmin() as {error?:string}).error==="mfa_required","bootstrap service path honors enrolled MFA");
 check(mutations===0&&resets===0&&serviceCalls===0,"no Auth, reset or privileged mutation occurs before challenge");
 aal="aal2";for(const call of requests)check((await call()).status===200,"enrolled aal2 mutation succeeds");
 check(mutations===2&&resets===1,"challenged session performs intended writes exactly once");
 verified=false;aal="aal1";for(const call of requests)check((await call()).status===200,"unenrolled creator preserves optional MFA flow");
 console.log(`sensitive creator MFA routes: ${checks} checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
