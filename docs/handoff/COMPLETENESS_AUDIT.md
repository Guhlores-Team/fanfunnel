# Completeness audit (orch/fixes @ 8a9a7c6)

## A. Open work NOT covered by the 11 roadmap items
1. Terms/Privacy are placeholders (LegalPage.tsx:5,15) — OWNER (final text).
2. Agency/org isolation has no automated runtime test (e2e/supabase.mjs only mentions org at :186; docs/archive/ROADMAP.md:133-141; SECURITY.md:48-49 says 0014 RLS must be runtime-verified before staff seats are relied on).
3. No Dependabot config (.github/ has 4 workflows, no dependabot.yml); secret scanning is a GitHub setting (SECURITY.md:46-47).
4. No error monitoring (no Sentry/analytics/log drain) — OWNER DECISION pending.
5. Supabase Redirect URL allow-list + Site URL undocumented, though every auth email link depends on it (LoginForm.tsx:62, forgot-password/page.tsx:21, api/account/email/route.ts:68).
6. Small leftovers: wheel-config read not cached (RELEASE_CHECKLIST.md:65); no `>= 0` CHECK on fan_passes.spins_granted_total (RELEASE_CHECKLIST.md:90; 0039 skipped it); mixed data-layer error convention (DESLOPPIFY N11 :165).
7. Stale docs: RELEASE_CHECKLIST.md all unticked though done; DEPLOY.md:162-176 (merge "Phases 3–5" PR, manual admin role; omits Upstash + NEXT_PUBLIC_ENABLE_DEBUG); SECURITY.md:43-45 (says rate limit in-memory only); README.md:143-149; DEPLOY.md:88 ("Phase 6").

## C. Owner-only
Decisions (PROPOSALS §2 items 3-7, 9-15; TEAM_CHECKLIST §3 sign-off on readableInk dark button text, nav labels, icons); legal text + break/reminder copy review; all of e2e/MANUAL-CHECKLIST.md; MFA on admin + leaked-password protection; confirm-email ON; GitHub branch protection on main + required reviewer on `production` environment; secret scanning setting.

## D. Go-live ops
- Prod migrations 0039–0048 now + 0049+ later, before/at merge. `production` job needs SUPABASE_ACCESS_TOKEN, SUPABASE_PROD_PROJECT_REF, SUPABASE_PROD_DB_PASSWORD (TEAM_CHECKLIST.md:79-83); docs/auto-migration-reconcile.sql once per project if not done.
- Vercel env (docs/ENVIRONMENTS.md:18-21): Production = prod Supabase URL/keys, ADMIN_EMAILS, FF_REQUIRE_SUPABASE=1; Preview = test keys + NEXT_PUBLIC_ENABLE_DEBUG=1; GitHub test secrets so e2e:supabase doesn't skip.
- Upstash (KV_REST_API_* set by integration on Preview+Production — verify).
- Later keys: REWARD_ENCRYPTION_KEY (#26), VAPID (push).
- Supabase Site URL = https://fanfunnel.vercel.app (prod) and the Preview URL (test); Redirect URLs: prod /** and preview wildcard /** (both ALREADY added by owner today).
- Re-enable Vercel Deployment Protection (ssoProtection was turned OFF today for owner testing; prior value: all_except_custom_domains).
- Optional data carry-over from test → prod (owner picks accounts; dry run first).
- Post-merge: prod DB healthy, no env badge on prod, MANUAL-CHECKLIST §4 smoke, rollback = revert merge commit (TEAM_CHECKLIST.md:120).
