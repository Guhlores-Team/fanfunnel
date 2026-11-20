import assert from "node:assert/strict";
import { testOperationalIntegrityRuntime } from "../../../scripts/security/operational-integrity-runtime-fixture.mjs";
const inserts: {table:string;payload:Record<string,unknown>}[] = [];
const calls: {name:string;args:Record<string,unknown>|undefined}[] = [];
const denied = {error:{code:"42501"},data:null};
const client = {
  from: (table:string) => ({select: () => ({limit: async () => denied}),insert: async (payload:Record<string,unknown>) => {inserts.push({table,payload});return denied;}}),
  rpc: async (name:string,args:Record<string,unknown>|undefined) => {calls.push({name,args});return denied;},
};
let checks=0;
async function main() {
  await testOperationalIntegrityRuntime({a:client,anonymous:client,check:(value:unknown,label:string)=>{assert.ok(value,label);checks++;}});
  assert.equal(checks,22);
  assert.ok(inserts.filter(row=>row.table!=='chase_stock_evidence').every(row=>row.payload.singleton===false),"negative probes cannot create hosted singletons even if grants regress");
  assert.ok(calls.filter(row=>row.name==='record_system_health_check').every(row=>row.args?.p_source==='invalid-negative-probe'),"a privilege regression cannot acknowledge a hosted key failure");
  assert.ok(calls.filter(row=>row.name==='initialize_reward_crypto_canary').every(row=>Object.keys(row.args?.p_canary as object).length===0),"a privilege regression cannot initialize a new hosted anchor");
  console.log('operational hosted negative fixture: 22 denial expectations and3 no-write fences passed; no hosted calls');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
