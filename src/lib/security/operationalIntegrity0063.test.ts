import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dirname, "../../..");
const sql = readFileSync(join(root, "supabase/migrations/0063_operational_integrity.sql"), "utf8");
const route = readFileSync(join(root, "src/app/api/admin/system-health/route.ts"), "utf8");
const ui = readFileSync(join(root, "src/components/admin/SystemHealthCard.tsx"), "utf8");
const canary = readFileSync(join(root, "src/lib/operations/canary.ts"), "utf8");
const startup = readFileSync(join(root, "src/lib/operations/startup.ts"), "utf8");
let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
for (const table of ["reward_crypto_canary", "system_health_checks", "chase_stock_evidence"]) {
  check(`${table} enables RLS`, sql.includes(`alter table public.${table} enable row level security`));
  check(`${table} revokes client mutations`, new RegExp(`revoke all on public\\.${table} from public,\\s*anon,\\s*authenticated`).test(sql));
}
check("immutable anchor cannot update or delete", /before update or delete on public.reward_crypto_canary/.test(sql) && /anchor is immutable/.test(sql));
check("service cannot bypass initialization with direct insert", /grant select on public.reward_crypto_canary to service_role/.test(sql) && !/grant [^;]*insert[^;]*reward_crypto_canary/i.test(sql));
check("empty startup and existing inventory bootstrap fenced", /pg_advisory_xact_lock\(/.test(sql) && /pg_advisory_xact_lock_shared\(/.test(sql) && /p_actor is null and v_count>0/.test(sql) && /inventory_changed/.test(sql));
check("tombstones require provenance recovery", /prize_reward_codes where erased_at is not null/.test(sql) && /recovery_required/.test(sql));
check("bounded inventory paging and diagnosis", /limit 25001/.test(sql) && /v_limit\+1/.test(sql) && /'incomplete'/.test(sql));
check("finite stock witness is same transaction and actual debit", /new.stock<old.stock/.test(sql) && /origin_transaction=pg_current_xact_id\(\)::text/.test(sql) && /limit v_units/.test(sql));
const initializer = sql.split("create or replace function public.initialize_reward_crypto_canary")[1].split("end $$;")[0];
check("admin revocation fence precedes inventory fence", initializer.indexOf("fanfunnel-active-admins") < initializer.indexOf("reward-crypto-canary-initialize"));
check("both HTTP actions authorize with shared guard", (route.match(/await requireAdminRoute\(\)/g) ?? []).length === 2);
check("UI receives only safe config types", !/supabase\/server|rewards\/crypto|operations\/(canary|runtime)/.test(ui) && /type SystemHealthStatus/.test(ui));
check("crypto check decrypts and validates stable fingerprint", /openReward\(/.test(canary) && /rewardCodeFingerprint\(/.test(canary) && /timingSafeEqual/.test(canary));
check("startup excludes build and runs once", /phase-production-build/.test(startup) && /__ffOperationalStartup/.test(startup));
console.log(`operational integrity security: ${passed} checks passed`);
