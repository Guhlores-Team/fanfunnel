# /multi-review — Phase 9 audit

**Scope:** `branch` — `feat/phase9-ux-and-hardening` vs `main` (base 790a6a1 → head 77b7887; 4,219-line diff).
**Models:** Claude (opus-4.8) + GPT (Codex CLI 0.132, read-only). Gemini pending login (auto-included once authed).
**Mode:** report-only (all findings touch protected paths or are below the High auto-apply bar).
**Method:** diff fed inline to Codex (its Windows sandbox blocks file reads); Claude reviewed independently; consensus below.

## Consensus findings

### 1. HIGH — Email change lacks re-authentication
`src/app/api/account/email/route.ts` calls `sb.auth.updateUser({ email })` for any active session. The password route
re-authenticates with the current password first; the email route does not. If Supabase "secure email change"
(confirm-on-both-addresses) is disabled/misconfigured, a hijacked or left-open session can move account ownership.
**Models:** Codex + Claude. **Fix:** require current-password (or step-up) reauth before the email update — mirror
`password/route.ts`'s throwaway-verifier pattern.

### 2. HIGH — Admin hard-delete "last admin" check is a TOCTOU race
`src/app/api/admin/account/delete/route.ts` counts admins in JS then deletes. Two concurrent deletes of the final
two admins can both observe `count==2`, both pass, and leave **zero** admins.
**Models:** Codex + Claude. **Fix:** make the last-admin guard + delete atomic in the DB (a `SECURITY DEFINER`
function that deletes the auth user only if it is not the last admin, under one transaction), instead of a JS check.

### 3. MEDIUM — Pack stacking only works on the 2nd click
`src/components/dashboard/packHelpers.ts` (`findMatchingPack`) compares a fresh draft's economics against the saved
pack's **accumulated** totals. After one stack (10→20 spins), a third add of the original 10-spin pack no longer
matches, so it creates a duplicate instead of continuing to stack.
**Models:** Codex + Claude. **Fix:** match on stable per-unit identity (label + per-unit economics), not the
already-accumulated totals; add a 3rd-click regression test.

## Disposition
All report-only (no auto-apply): #1/#2 are in `protectedPaths` (auth/admin/account), #3 is below the High bar.
Orchestrator will fix all three manually with re-verification (tsc + tests), since this is a guided audit.
