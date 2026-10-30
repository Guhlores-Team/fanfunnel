// Static privilege regression supplements real local PostgreSQL races in
// scripts/db/focus-ledger-check.mjs; it does not claim to prove transactions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEGAL } from "@/lib/legal";
const source=readFileSync(new URL("../../../supabase/migrations/0059_focus_attempt_ledger.sql",import.meta.url),"utf8");
let checks=0;
const check=(value:unknown,message:string)=>{assert.ok(value,message);checks++;};
for(const table of ["focus_creator_config","fan_focus","chase_reservations","spin_attempts","fan_import_batches","fan_import_items","creator_request_journal","actor_request_cancellations"]) {
 check(source.includes(`alter table public.${table} enable row level security`),`${table} RLS`);
 check(new RegExp(`create policy \\w+ on public\\.${table} for select to authenticated`).test(source),`${table} scoped metadata policy`);
}
const rpc=["prepare_spin_attempt","commit_spin_attempt","get_spin_attempt_status","cancel_spin_attempt","grant_focus_pack","cancel_fan_focus","get_fan_focus_state","grant_pass_spins","edit_pass_grant","create_pass_grant","award_fan_referral","ensure_pass_commitment","import_fans_durable","reconcile_creator_request"];
for(const name of rpc) {
 check(new RegExp(`revoke execute on function public\\.${name}\\([^;]+from public,anon,authenticated;`).test(source),`${name} browser denied`);
 check(new RegExp(`grant execute on function public\\.${name}\\([^;]+to service_role;`).test(source),`${name} service allowed`);
}
for(const name of ["claim_spin","finalize_reward_spin","reserve_reward_code","release_reward_code","credit_pass_spins","import_fans"])check(new RegExp(`revoke execute on function public\\.${name}\\([^;]+from public,anon,authenticated,service_role;`).test(source),`${name} retired for service too`);
check(source.includes("revoke execute on function public.edit_pass_grant(uuid,uuid,integer,integer,integer,uuid,boolean,boolean,boolean) from public,anon,authenticated,service_role;"),"legacy non-durable edit writer retired for service role");
check(source.includes("revoke execute on function public._edit_grant_patch_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;"),"private patch core cannot bypass creator journal");
check(source.includes("j.actor_id is distinct from p_actor"),"committed receipt cannot be adopted by a different actor");
check(source.includes("revoke execute on function public.cancel_fan_focus(uuid,uuid,uuid) from public,anon,authenticated,service_role;"),"actorless focus cancellation retired for every API role");
check(source.includes("if not found or not public._creator_actor_grant_allowed(p_actor,p_creator)"),"focus cancellation checks current actor after fan lock");
const allowed=source.match(/grant select\(([^;]+)\) on public\.spin_attempts to authenticated;/)?.[1];
check(allowed&&!/\b(context|result|token_hash|request_hash)\b/.test(allowed),"attempt metadata SELECT excludes future seed and bindings");
check(source.includes("where status in ('active','paused')"),"one live OR paused promise constraint");
check(source.includes("where state in('held','consumed')"),"released code can be held again; active/consumed assignment stays unique");
check(source.includes("and reserved_focus_id is null"),"code free stock excludes concrete holds");
check(source.includes("context=null,result="),"fan erasure drops unrevealed attempt context");
check(source.includes(`acked_terms_version is distinct from '${LEGAL.version}'`),"SQL atomic gate matches current legal version");
check(source.includes("before insert or update on public.fans"),"nonzero fan INSERT cannot bypass aggregate gate");
check(source.includes("before insert or update on public.fan_passes"),"pass direct credit/seed writes gated");
check(source.includes("aa_atomic_spin_insert before insert on public.spins"),"manual insert cannot bypass durable attempt");
check(!/user_metadata|app_metadata/.test(source),"authorization never uses editable metadata");
console.log(`focusLedger.test: ${checks} privilege, erasure and legacy-writer guards passed`);
