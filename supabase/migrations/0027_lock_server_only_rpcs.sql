-- 0027 Lock down server-only balance RPCs (multi-review Audit 2 — CRITICAL/HIGH).
--
-- FINDING (Codex + Gemini consensus, verified): every SECURITY DEFINER function
-- except the 6 explicitly granted self-service RPCs had NO GRANT/REVOKE, so it
-- defaulted to PUBLIC EXECUTE — i.e. an anon/authenticated Supabase client could
-- call it directly via PostgREST `rpc()`. For `credit_pass_spins` that means
-- MINTING SPINS for any fan; for `claim_spin` it means bypassing the
-- server-authoritative /api/spin path (fairness/logging/rate-limit).
--
-- Both are ONLY ever invoked server-side via the service-role client
-- (src/lib/data/index.ts `spin()` and the referral-credit path:
-- `createServiceClient()` → `sb.rpc(...)`). So restricting EXECUTE to
-- `service_role` is safe and closes the hole. service_role bypasses these grants
-- only with an explicit grant after revoking PUBLIC, so we re-grant it.
--
-- ⚠️ Run the live-DB runtime check before relying on this: perform a real fan
-- spin and a referral credit against a configured Supabase project, plus
-- `node scripts/security/rls-runtime-test.mjs`.

revoke execute on function public.claim_spin(text) from public, anon, authenticated;
grant  execute on function public.claim_spin(text) to service_role;

revoke execute on function public.credit_pass_spins(uuid, int) from public, anon, authenticated;
grant  execute on function public.credit_pass_spins(uuid, int) to service_role;
