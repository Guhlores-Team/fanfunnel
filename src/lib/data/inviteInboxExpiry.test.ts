import assert from "node:assert/strict";
import { mock } from "node:test";
const now=Date.now();
const rows=[
 {id:"outgoing",org_id:"own-org",email:"other@example.test",status:"pending",expires_at:new Date(now+86400000).toISOString()},
 {id:"expired",org_id:"own-org",email:"owner@example.test",status:"pending",expires_at:new Date(now-86400000).toISOString()},
 {id:"incoming",org_id:"own-org",email:"owner@example.test",status:"pending",expires_at:new Date(now+86400000).toISOString(),org:{name:"Agency"}},
 {id:"accepted",org_id:"own-org",email:"owner@example.test",status:"accepted",expires_at:new Date(now+86400000).toISOString()},
 {id:"foreign-org",org_id:"other-org",email:"not-owner@example.test",status:"pending",expires_at:new Date(now+86400000).toISOString()},
];
class Query {
 filters: ((row: Record<string, unknown>)=>boolean)[]=[];
 constructor(readonly table:string){}
 select(){return this;}
 eq(key:string,value:unknown){this.filters.push(row=>row[key]===value);return this;}
 gt(key:string,value:unknown){this.filters.push(row=>String(row[key])>String(value));return this;}
 order(){return this;}
 limit(){return this;}
 data(){const base: Record<string,unknown>[]=this.table==="orgs"?[{id:"own-org",name:"Own",owner_id:"owner"}]:this.table==="org_invites"?rows:[];return base.filter(row=>this.filters.every(test=>test(row)));}
 maybeSingle(){return Promise.resolve({data:this.data()[0]??null,error:null});}
 then(resolve:(value:unknown)=>unknown){return Promise.resolve({data:this.data(),error:null}).then(resolve);}
}
const client={auth:{getUser:async()=>({data:{user:{id:"owner",email:"owner@example.test"}}})},from:(table:string)=>new Query(table),rpc:async()=>({data:[],error:null})};
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createClient:async()=>client,createServiceClient:()=>{throw Error("invite inboxes must use RLS");}}});
async function main(){
 const {getMyInvites,getAgencyOverview}=await import("./admin");
 const incoming=await getMyInvites();assert.deepEqual(incoming.map(row=>row.id),["incoming"]);
 const agency=await getAgencyOverview();assert.deepEqual(agency?.invites.map(row=>row.id).sort(),["expired","incoming","outgoing"]);
 assert.deepEqual(agency?.invites.filter(row=>row.expired).map(row=>row.id),["expired"],"WG-08: a lapsed invitation stays listed (flagged) so the owner can resend it");
 console.log("invitation inbox expiry: 2 causal filtering cases passed");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
