# /multi-review — whole-project security audit (Audit 2)

**Scope:** core security spine — RLS schema, auth middleware, server-authoritative
spin + provably-fair path, rate limiting. **Models:** Claude + Codex + Gemini (read-only).
**Method:** files embedded inline (hardened untrusted-data prompt); findings verified against the SQL.

## CRITICAL — fixed (migration 0027)
**PUBLIC-executable SECURITY DEFINER RPCs** (Codex + Gemini consensus; **verified**: grep found
zero `REVOKE` statements and explicit `grant execute` for only 6 self-service RPCs → all others default
to PUBLIC EXECUTE).
- `credit_pass_spins(uuid,int)` — anon/authenticated could call it via PostgREST to **mint spins** for any fan.
- `claim_spin(text)` — callable directly, bypassing the server-authoritative `/api/spin` (fairness/logging/limit).
- **Verified safe to lock:** both are only called server-side via `createServiceClient()` (`src/lib/data/index.ts`
  `spin()` line 527; referral credit ~1001). **Fix shipped:** migration `0027` revokes EXECUTE from
  public/anon/authenticated and grants `service_role`. ⚠️ Requires a live-DB runtime check (real spin + credit)
  before deploy.

## HIGH — documented (need design + live-DB work; not blindly patched)
1. **`claim_spin` rate-limit race** (Codex + Gemini). It counts recent `spins` rows, but the spin row is logged
   by the app *after* `claim_spin` returns → check-then-act; concurrent requests can burst past the 8/10s limit.
   **Fix:** make decrement + rate-limit + spin-row insert one transaction with `SELECT … FOR UPDATE` on the fan/pass.
2. **`org_add_creator` consent gap** (Gemini; verified it exists and only checks `_owns_org`). An org owner can
   force-add any creator by email (granting `can_act_for` over them) without the creator's consent.
   **Fix:** require the invite/accept flow (migration 0018) — remove or gate `org_add_creator`.
3. **Broad PUBLIC-execute posture** beyond the two locked here: self-service RPCs (`set_public_profile`,
   `set_creator_note`, …) are PUBLIC but self-scope via `auth.uid()`, so lower risk — still should be granted to
   `authenticated` only. Audit each definer fn's intended caller and lock down.

## MEDIUM / LOW — documented
- **Webhooks SSRF** (Gemini): creator-registered webhook URLs aren't validated → can target internal metadata/IPs.
  Fix: block private/link-local ranges + non-HTTPS at write + at send time.
- **Blocked/inactive creators** can still call `set_public_profile`/`set_creator_note`/`set_chat_settings`
  (no `is_active`/`blocked_at` check). Fix: add the guard inside those RPCs.

## Note
The earlier single-model security pass reported 0 crit/high; the multi-model audit caught the PUBLIC-execute
class it missed — concrete evidence the cross-model review adds coverage. All HIGH/MED items above are real but
need careful SQL + live-DB runtime testing, so they're filed as a prioritized backlog rather than blind patches.
