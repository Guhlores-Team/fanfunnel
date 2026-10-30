// Called only after the parent runtime runner's TEST-project and nonproduction
// guards. Read/denial probes only: NEVER initialize or replace a hosted anchor,
// send alerts, create reward inventory, or alter the global health singleton.
export async function testOperationalIntegrityRuntime({a, anonymous, check}) {
  for (const [label, client] of [["creator",a],["anonymous",anonymous]]) {
    for (const table of ["reward_crypto_canary","chase_stock_evidence"]) {
      const result = await client.from(table).select("*",{head:true,count:"exact"}).limit(1);
      check(result.error?.code === "42501", `${label} cannot read private ${table}`);
    }
    const status = await client.from("system_health_checks").select("singleton").limit(1);
    check(status.error?.code === "42501" || (!status.error && status.data?.length === 0), `${label} cannot read admin system health`);
    const calls = [
      ["read_reward_crypto_canary",undefined],
      ["reward_crypto_inventory_page",{p_after:"x".repeat(65),p_limit:1}],
      ["initialize_reward_crypto_canary",{p_canary:{},p_inventory_digest:"0".repeat(64),p_actor:null}],
      ["run_reward_ledger_invariants",{}],
      ["record_system_health_check",{p_source:"invalid-negative-probe",p_canary_status:"healthy"}],
    ];
    for (const [name,args] of calls) {
      const denied = await client.rpc(name,args);
      check(denied.error?.code === "42501", `${label} cannot execute operational ${name}`);
    }
    // Valid column names, with impossible constraints/FKs as a second fence:
    // even a privilege regression must never poison a real global singleton.
    const impossible="00000000-0000-0000-0000-000000000000";
    for (const [table,payload] of [
      ["reward_crypto_canary",{singleton:false,cipher:"a".repeat(32),iv:"b".repeat(16),key_version:1,fingerprint:"c".repeat(64)}],
      ["system_health_checks",{singleton:false}],
      ["chase_stock_evidence",{reservation_id:impossible,creator_id:impossible,prize_id:impossible}],
    ]) {
      const denied = await client.from(table).insert(payload);
      check(denied.error?.code === "42501", `${label} cannot insert operational ${table}`);
    }
  }
}
