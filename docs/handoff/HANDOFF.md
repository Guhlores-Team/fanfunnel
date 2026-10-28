# FanFunnel hand-off (2026-10-28)

Read this first, then `AGENTS.md` (binding), then the other files in `docs/handoff/`.
Everything below was true at the time of writing; verify with `git` before acting.

## 1. Where things stand

- **Integration branch:** `dashboard-redesign` (draft PR #78 → `main`). Last verified
  Preview commit `540f018` (0058). CI and TEST migration/history/type checks are
  green (verify, login-ui, supabase, schema-drift, test). Theming (0058) passed
  two full rounds (163 unit files, 151 browser checks, 92 accessibility states).
  All CI, TEST migration/history/exact types, runtime negatives and login UI
  passed at `540f018`; that exact commit is now on the stable TEST Preview.
  Focus (0059) is integrated locally; its full release rounds are next. The unit
  runner now accepts literal Next.js bracket paths and fails process errors.
- **Preview (TEST database `snmcrmhgevfqggxdiomu`):**
  https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app
  Vercel login protection is OFF for testing (`ssoProtection` was `all_except_custom_domains`;
  turn it back on at go-live).
- **Live:** https://fanfunnel.vercel.app (prod database `ttlogfmogcccwiraaoae`, us-east-2/Ohio).
  Still runs an old July build. **`main` = production. Never push or merge to `main`**
  without (a) green CI and (b) the owner's explicit "tested on Preview, go".
- **TEST database migrations applied:** 0001–0058 (confirmed by successful CI application,
  migration history and exact generated-type comparison). Prod is behind; prod gets migrations only
  at go-live, before or exactly at the merge.

## 2. Roadmap status (owner chose: build ALL before alpha)

| Item | Migration | Branch @ sha | State |
|---|---|---|---|
| RM-1 reveal theater, RM-2 stock, RM-4 PWA, Fairness v3 | 0045–0048 | in `dashboard-redesign` | done, on Preview |
| RM-6 spend guardrail (F5 `withFanToken`, F6 `fanEngagementAllowed`) | 0049 | merged | done, on Preview |
| RM-3 visit glow | 0050 | merged | done (glow gate now delegates to F6) |
| RM-5 win-back queue | 0051 | merged | done (`src/lib/engagement.ts` re-exports F6) |
| Go-live hardening (agency org RLS fix, Dependabot, docs/GO_LIVE.md) | 0052 | merged | done |
| Error monitoring + email alerts (Admin › Errors) | 0053 | merged | done |
| **Privacy & safety pack** | 0054 | merged as `612b606` | done; two full local verification rounds, green CI, on Preview / TEST |
| **Terms / Privacy + clickwrap** | 0055 | merged as `c1b4098` | done; two full local verification rounds, green CI, on Preview / TEST |
| **Web push (creators)** | 0056 | merged and hardened through `4431546` | done; two final full rounds (141 unit files, 130 browser checks, 69 accessibility states), green CI / TEST, deployed Preview |
| **#26 instant-delivery prizes** | 0057 | normal merge of `rm/26-instant-delivery`, finished through `2abae19` | on Preview/TEST; two full local rounds (151 unit files, 140 browser checks, 76 axe states), green CI and real TEST integration/RLS tests |
| **Per-creator theming** | 0058 | normally merged, verified through `540f018` | on Preview/TEST; two full local rounds, exact-SHA CI, history/types/runtime and real public mobile checks pass |
| **#25 focus pack → chase pity** | 0059 | integrated locally on `dashboard-redesign` | atomic ledger, request recovery and every-disclosure audit implemented; independent focus-read repair verified; full release rounds next; hosted Chase remains off |
| **RM-7 scratch tickets** | 0060 | source frozen separately | pure replay, SQL, data and UI prepared; integrated release verification remains after 0059 |
| **RM-7 personal bingo** | 0061 | in progress in isolated archive | must follow the frozen scratch release; no TEST application yet |
| **Account security follow-up** | 0062 | isolated preparation | enrolled creator MFA, invite expiry and last-active-admin safeguards; integrate only after 0061 |

All branches are pushed to origin. Branches other than `dashboard-redesign` are based on older
`dashboard-redesign` commits; bring them in with a normal `git merge` (never rebase/force-push
someone else's history).

## 3. Next steps, in order

### 3a. Merge the three finished branches, strictly in migration order
0054–0057 are complete on Preview and TEST. The owner confirmed enabling two-factor
login before 0054 was pushed. Continue with 0059; do not repeat earlier merges or MFA
enrolment. The 0057 type-only follow-up preserves the exact generator syntax;
its declarations and runtime behavior are unchanged from the twice-verified tree.

`supabase db push` (CI `test` job) rejects a migration numbered lower than the remote's latest,
so **0054 → 0055 → 0056 → 0057 → 0058 → …** must reach `dashboard-redesign` in that order.

1. `git merge --no-ff origin/ops/privacy-safety` (0054).
   - Its `run_retention_cleanup` skips `app_errors` via `to_regclass` until 0053 exists: 0053 now
     exists, so confirm the drift-check probe still passes and that resolved `app_errors` are cleaned.
   - Adds `vercel.json` (cron 04:17 UTC → `/api/cron/retention`); watch for conflicts.
   - **0054 makes `is_admin()` require an aal2 (2FA) session.** The owner must enrol 2FA on
     every admin account (Settings › Security › Two-factor) or loses admin access on Preview.
     Tell them before pushing.
2. `git merge --no-ff origin/legal/terms-privacy` (0055). Contact email lives only in
   `src/lib/legal.ts` (test-enforced). Fans who acked before 0055 see the age gate once more.
3. `git merge --no-ff origin/rm/web-push` (0056). New dependency `web-push@3.6.7` (allowed by spec).
   **Wire the F6 gate:** `pushAboutFanAllowed` in `src/lib/push/notify.ts` (~73, marked
   `// F6: wire to fanEngagementAllowed at merge`) must call `fanEngagementAllowed` from
   `src/lib/play/playGuard.ts` with `breakUntil` read from `fans.break_until`; add an on-break
   case to `src/lib/push/notify.test.ts` (both Supabase and mock paths).

   Integration also uncovered an approval bypass: pending/rejected creators could
   write their own business data and use agency/import paths. 0056
   tightens the shared authorization predicates without renumbering later
   features. The local regression has 106 assertions: 47 failures before the fix,
   zero after. Active legacy admins retain own-account operations; cross-account
   admin power still requires aal2. New TEST fixtures explicitly approve positive
   creator accounts and separately test pending/rejected refusals.

   Other integration hardening: public-upload cleanup before account deletion,
   avatar eligibility checks before and after upload, and deterministic daily
   push-log retention (including inactive accounts). Storage errors retain the
   account/metadata for retry. Durable tracking for in-flight uploads and deletion
   retries remains an explicit requirement of the 0058 storage work.

Expected conflicts (seen on every merge so far) are parallel appends in:
`e2e/a11y.mjs`, `e2e/run.mjs`, `scripts/db/schema-drift-check.mjs`,
`scripts/security/rls-runtime-test.mjs`, `supabase/schema.sql`, `supabase/migrations_combined.sql`,
`src/lib/data/db.types.ts`, `src/lib/data/mock.ts`, `src/lib/data/types.ts`, `src/lib/data/index.ts`.
Resolve by keeping both sides, in migration order. Watch for:
- a function body split across the conflict (the shared closing `}` / `};` sits after the marker);
- `db.types.ts` tables must stay alphabetical, exactly as `supabase gen types` emits;
- the drift-check `for (const db of ["ffa","ffb","ffc"]) { … }` loop: `src/lib/security/orgRlsLedger0052.test.ts`
  requires `probeGrants(db);` immediately followed by `probeOrgIsolation(db);` — append new probes after;
- **duplicate `const` names in `rls-runtime-test.mjs`** (all sections share one scope). After every
  merge run `for f in e2e/*.mjs scripts/*/*.mjs; do node --check "$f" || echo BAD $f; done`.

After each merge (or after all three): run the full verify (§5) twice, then
`git push origin HEAD:dashboard-redesign`. CI's `test` job applies the new migrations to TEST;
confirm with Supabase `list_migrations` on `snmcrmhgevfqggxdiomu`.
Then follow `docs/PREVIEW_DEPLOY.md`: automatic Git deployment is disabled only for
this branch, so deploy the exact checked SHA through the authenticated CLI after
TEST application/type/history checks and all CI jobs succeed. Never deploy an
uncommitted source directory or change a Production alias.

### 3b. Finish #26 and theming
0057 is complete on Preview. 0058 passed both full integrated rounds and has been
pushed only to `dashboard-redesign`. TEST migration/history/types/runtime and all
CI jobs pass, and the exact checked commit is on Preview. Continue with 0059. The historical WIP details below describe
what had to be completed; they are not the remaining task list.
- **#26** (`rm/26-instant-delivery`): last step in progress was the static migration guard test
  (`src/lib/security/instantRewards.test.ts`) and route authz test (`src/app/api/prizes/rewardAuthz.test.ts`).
  Reward codes are AES-256-GCM encrypted with server-only `REWARD_ENCRYPTION_KEY` (Node `crypto`).
  Codes must be reserved atomically with the spin claim (20-way race probe already in the drift check).
  Reinspection found the creator editor, fan reveal/re-view, Auto fulfilment UI,
  e2e and accessibility work were still missing; do not treat the two WIP tests as
  the only remaining tasks. Also verify atomic/idempotent finalization, cross-paste
  code uniqueness, immutable delivered values, full history beyond 50 wins,
  every-view logging, and erasure of delivered secrets when a fan deletes data.
- **Theming** (`rm/theming`): last step in progress was the Settings "Look & feel" card; then
  a11y states (themed fan page + link-in-bio, light/dark extremes), screenshots, verify.
  It uses `sharp` to re-encode uploads to WebP — confirm `sharp` is already a dependency
  (Next ships it); if it is newly added to package.json, flag it to the owner.
  The Settings card, admin controls and browser/accessibility coverage were absent
  on the saved branch. Integrate storage failure handling, audit hooks, exports,
  mock resets, closed-account media cleanup and durable upload/deletion recovery.

### 3c. Build #25 then RM-7
Specs: `docs/handoff/PROPOSALS.md` (#25 §, RM-7 §, §8 "riskiest three"). Rules:
`docs/handoff/ROADMAP_BUILD_BRIEF.md`. Migrations 0059 (#25), 0060+ (RM-7).
Never change odds outside the committed seed derivation (Fairness v3, 0047); keep `fans == SUM(passes)`.
Every "come back / keep going" surface must call F6 `fanEngagementAllowed`.

### 3d. Small fixes still open
- Malformed percent-encoded URLs return 500 (and aren't captured by monitoring).
- Server-side refusal of creator top-ups to a fan on a break (UI already disables it; owner call).
- Debug-build "PREVIEW · DEMO DATA" banner covers the top of the win-back queue buttons at 390px.
- Creator 2FA is enforced at login/proxy only, not in RLS (owner call; see privacy report below).
- Pending agency invites never expire (0062 preparation uses a seven-day default).
- Protect the last active admin against direct suspension/demotion/deletion and
  both deletion reservations; inactive admins must not satisfy that invariant.
- Hash fan bearer tokens/IPs before external rate-limit storage and bound the
  fallback map; isolated preparation exists, not yet integrated.

### 3e. Security audit, then go-live
- Run the audit per `docs/handoff/SEC_AUDIT_BRIEF.md` (two independent auditors + privacy-promise
  verification + outside-attacker pass) → `docs/security/AUDIT-2026-10.md`; fix Critical/High.
- Then the owner tests on Preview (`e2e/MANUAL-CHECKLIST.md`) and works through
  `docs/handoff/OWNER_STEPS.md`. Go-live steps: `docs/GO_LIVE.md`.

## 4. Owner (do not lose these)

- Owner: Stephen + partner, the only users today. Non-technical; wants **step-by-step instructions
  with clickable links, one step at a time**, and template/file locations always given as a link
  or pasted in chat. Never ask them to paste secrets/API keys into chat — keys go straight into
  Vercel/Supabase. Purchases (domain, plans) only on their explicit go-ahead with a confirmed price.
- Decisions made: operator "FanFunnel" (brand only, no entity); Massachusetts law; contact
  `support@easysimplesites.org` (a FanFunnel domain will be bought later; e.g. fanfunnel.app $9.99
  then $15/yr — .com/.co are taken); worldwide audience; creator fees "free for now, fees later";
  30-day change notice; error monitoring built in-house with email (no Sentry); all roadmap items
  before alpha. Every other roadmap decision uses the proposal's recommended default behind a
  named constant (listed per item in PROPOSALS.md §2) — walk the owner through them a few at a time.
- Test data they create on Preview should be carried to live at go-live (dry-run first, owner OK).
- Their TEST account email is `stephenbattaglia594+test@gmail.com` with a pending change back;
  remind them to click both "Confirm your new email" links.
- Email: Resend on `easysimplesites.org` (DMARC `p=none` added), Supabase SMTP configured in both
  projects, branded templates in `supabase/templates/` pasted into both projects. TEST Supabase
  Site URL is still `http://localhost:3000` (owner step 11 sets it to the Preview URL).

### Env vars the owner must set in Vercel (names only)
| Var | For | Notes |
|---|---|---|
| `RESEND_API_KEY`, `ALERT_EMAIL_TO` | error alert emails (0053) | Production |
| `CRON_SECRET` | retention cron (0054) | ≥16 chars, `openssl rand -hex 32` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (Sensitive), `VAPID_SUBJECT` (`mailto:`) | web push (0056) | `npx web-push generate-vapid-keys`; Production + Preview |
| `REWARD_ENCRYPTION_KEY` | #26 (0057) | 32 random bytes, base64; Production + Preview; never rotate without re-encrypting |
| `REWARD_CODE_FINGERPRINT_KEY` | code uniqueness (0057) | independent stable key; never rotate or erased delivered codes could be reintroduced |

Preview's VAPID trio has now been configured through the authenticated Vercel CLI;
the private key is Sensitive. Production settings were verified unchanged. Never
replace that existing Preview pair blindly. Preview's two reward keys are also
configured as Sensitive; arrange an owner-controlled secure backup before real
reward inventory. Production keys/settings were not changed. Vercel cron jobs run in Production;
do not claim scheduled TEST retention is active without a separate verified setup.

## 5. How to verify (real commands)

```bash
npm ci
npm run lint && npm run typecheck && npm test           # ~116+ test files, all must pass
NEXT_PUBLIC_ENABLE_DEBUG=1 npm run build
PG_BIN=/usr/lib/postgresql/16/bin node scripts/db/schema-drift-check.mjs   # must end "ALL PASS"
curl -s -o /dev/null -w '%{http_code}' localhost:3201   # must print 000 (stale servers caused bogus failures)
NEXT_PUBLIC_ENABLE_DEBUG=1 npx next start -p 3201 &
E2E_BASE_URL=http://localhost:3201 npm run e2e          # then, on the SAME server:
E2E_BASE_URL=http://localhost:3201 npm run e2e:a11y
```
- e2e's last journey (`firstRunJourney`) wipes the demo account; new steps go before it; a11y states
  must create their own data.
- Playwright: if it asks to install browsers, set `PLAYWRIGHT_BROWSERS_PATH` to an existing chromium
  install (in the previous container: `/opt/pw-browsers`); don't install a different version.
- Known flake under CPU load: RM-1's legendary reveal step has a 6400ms budget and misses by
  30–120ms when the machine is busy. Re-run on a fresh server; never loosen the test.
- `node scripts/security/rls-runtime-test.mjs` needs TEST project credentials; CI's `supabase` job runs it.
- Unit tests run via `npx tsx --experimental-test-module-mocks --import ./scripts/test-preload.mjs <file>`.
  Use `async function main()` (no top-level await); `mock.module` doesn't work for npm packages —
  stub `globalThis.fetch` instead.
- Next.js 16: read `node_modules/next/dist/docs/` before using any Next API.

## 6. Rules (binding — summary; AGENTS.md wins)
- Auth contract: never authorize from `user_metadata`; roles via `is_admin()`/`can_act_for()`;
  service key only via `createServiceClient()` in server code; RLS + policy on every table (no
  `using (true)`); privileged ops via server routes; revoke anon/authenticated on server-only RPCs;
  a negative test for every new authz surface.
- Migrations: one number per feature, mirrored into `supabase/schema.sql` and
  `supabase/migrations_combined.sql`, `db.types.ts` hand-edited to match `supabase gen types`.
- Mock (demo) and Supabase paths stay in parity. No new dependencies without a stated reason.
  Never weaken/skip/delete tests. Respect reduced motion, keyboard, AA contrast, 360/390/1440.
- Never touch the prod Supabase project except read-only queries. Never merge/push to `main`.
- No AI model names in commits, PRs or code. Commit messages are imperative; PR comments end
  with an attribution footer.

## 7. Detailed reports from the last builders (summarised)

**Privacy pack (0054):** admin_audit_log (append-only), creator_notices, link_tombstones (hash only);
`is_admin()` requires aal2; TOTP 2FA (`src/components/auth/totp.tsx`, `/mfa`, proxy redirect);
fan export/delete (`/api/fan-data/*`, Safety menu), creator export/close account
(`/api/account/{export,close}`, typed phrase + password + 2FA + last-admin guard); retention cron.
Knobs: `src/lib/privacy/config.ts`, `src/lib/privacy/retention.ts`. Ready-made Privacy Policy
sentences for these features are in the privacy report; add them to `src/app/privacy/page.tsx`
after merging legal (export/delete rights, 2FA for admins, 365-day admin log, retention periods).

**Legal (0055):** `profiles.terms_accepted_at/terms_version`, `fans.acked_terms_version`,
service-only `record_terms_acceptance`; clickwrap at sign-up and `/pending`; non-dismissable
dashboard prompt for creators on an older version. Lawyer points in `docs/LEGAL_NOTES.md`
(sweepstakes/lottery risk is #1). Owner still to confirm the Upstash region.

**Web push (0056):** `push_subscriptions` + `push_log`; settings card
`src/components/dashboard/PushNotificationsCard.tsx`; routes `src/app/api/push/*`; sending
`src/lib/push/{send,notify,payload,keys}.ts`; lock-screen text generic by default
(`src/lib/push/config.ts:12`). Needs a real-iPhone check (Home Screen app) on Preview.

**RM-5:** `WINBACK_MODE="queue"` (`src/lib/winback/config.ts`); spec said `can_act_for(...,'message')`
but that permission doesn't exist — `'chat'` is used.
**RM-6:** `PLAY_VISIBILITY`, `CREATOR_CAN_DISABLE_PLAY_GUARD` in `src/lib/play/config.ts`.
