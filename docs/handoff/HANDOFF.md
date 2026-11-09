# FanFunnel hand-off (2026-10-29, §1–§3 refreshed 2026-11-04)

> **Superseded by [MASTER_TRACKER.md](./MASTER_TRACKER.md) (2026-11-04).** The tracker is the
> single source of truth for what is done and what is left. This file keeps the owner facts
> (§4), the verify commands (§5), the rules (§6) and history. §1–§3 below were refreshed on
> 2026-11-04 and only summarise the tracker; where they disagree, the tracker wins.

Read this first, then `AGENTS.md` (binding), then the other files in `docs/handoff/`.
Everything below was true at the time of writing; verify with `git` before acting.

**Owner's weekly-usage rule: at 3% remaining, prepare the safe handoff and pause.**
The agent cannot observe the usage meter; the owner must flag the threshold. Follow the
[checkpoint procedure](./TAKEOVER_CHECKPOINT.md#weekly-usage-checkpoint-rule) and refresh the
[concise resume brief](./RESUME_BRIEF.md). Do not start another feature at the threshold or
let unfinished work exist only in chat or temporary files. (The 2026-10-29 pause at 2% was
lifted; work resumed and built 0060–0066.)

## 1. Where things stand (2026-11-04)

- **Integration branch for the go-live candidate:** `orch/fixes`. It holds migrations
  **0001–0066**, the final hardening (36 paths) and audit batch 3 (merges 4a49139 b3-db,
  43e4840 b3-app, 2a0f979 b3-ui, c73dd44 b3-ops; reconciled docs 7bea8ac).
- **`dashboard-redesign`** (draft PR #78 → `main`, head 8bf5c4c) has 0001–0061 plus the
  game/campaign switching UX. **Nothing new has been merged to it**; 0062–0066 and batch 3
  reach it only after the owner's "go".
- **Batch 4 is in flight** on branches off `orch/fixes` 7bea8ac: `gaps/b4-db` (0067),
  `gaps/b4-seats` (agency seats on campaigns, A28 residual), `gaps/b4-stress` (load/abuse
  harness, A26) and `gaps/b4-qa` (docs, public-page copy, exploratory QA; see
  `QA_PASS_2026-11-04.md`). Those branches carry a `vercel.json` commit so they never deploy
  a Preview.
- **TEST database (`snmcrmhgevfqggxdiomu`) is at 0061.** 0062–0066 have not been applied to
  any hosted database.
- **Preview (TEST):** https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app
- **Live:** https://fanfunnel.vercel.app (prod database `ttlogfmogcccwiraaoae`). Unchanged; an
  old July build. **`main` = production. Never push or merge to `main`** without (a) green CI
  and (b) the owner's explicit "tested on Preview, go".
- **Waiting on the owner's "go"** to move `orch/fixes` onto `dashboard-redesign`, apply
  0062+ to TEST, and run Preview acceptance (`e2e/MANUAL-CHECKLIST.md`, now with §19).

## 2. Roadmap status (owner chose: build ALL before alpha)

All roadmap stages are built. Per-stage state, commits and what closes each row live in
[MASTER_TRACKER §1](./MASTER_TRACKER.md#1-roadmap-stages-prepared-source--integrate).

| Item | Migration | Where | State |
|---|---|---|---|
| RM-1 … RM-6, fairness v3, privacy pack, terms, web push, #26 instant rewards, theming, #25 focus/chase | 0045–0059 | `dashboard-redesign`, Preview/TEST | done (`5f72680` verified release; see `RELEASE_CHECKPOINT.json`) |
| RM-7a scratch tickets | 0060 | `dashboard-redesign`, TEST | integrated; Preview acceptance pending |
| RM-7b personal bingo + interplay suite | 0061 | `dashboard-redesign`, TEST | integrated; Preview acceptance pending |
| Game/campaign switching UX | — | `dashboard-redesign` | done-pending-Preview |
| Account security follow-up | 0062 | `orch/fixes` | integrated, not on any hosted DB |
| Ledger operations + safety overlay | 0063 | `orch/fixes` | integrated, not on any hosted DB |
| Audit batch 1 | 0064 | `orch/fixes` | integrated, not on any hosted DB |
| Per-fan game pins + batch-3 DB hardening | 0065 | `orch/fixes` | integrated, not on any hosted DB |
| Agency seat scopes, approval notice, alert release | 0066 | `orch/fixes` | integrated, not on any hosted DB |
| Runtime schema-version check (A39 residual) | 0067 | `gaps/b4-db` | in flight |

## 3. Next steps, in order

1. **Finish batch 4** and merge its branches into `orch/fixes` (DB branch first, so 0067 lands
   before code that needs it). Each branch reports two full verification rounds (§5).
2. **Owner's "go"** → merge `orch/fixes` into `dashboard-redesign`; CI applies 0062–0067 to
   TEST (DB before code, AGENTS.md). Confirm with `list_migrations` on TEST, then deploy the
   exact checked SHA to Preview per `docs/PREVIEW_DEPLOY.md`.
3. **Preview acceptance** by the owner: `e2e/MANUAL-CHECKLIST.md` (including §19 games,
   campaigns and links) and `docs/handoff/OWNER_STEPS.md`.
4. **Verification and acceptance gates** in [MASTER_TRACKER §3](./MASTER_TRACKER.md#3-verification--acceptance-from-takeover_checkpoint-open-gaps):
   two fresh security audits, hosted feature checks, installed-phone push, key backup and
   TEST restore drill, second-admin recovery, email/cron checks, Production env vars.
5. **Go-live** per `docs/GO_LIVE.md`, only on the owner's explicit "go": migrations to prod
   before (or exactly at) the merge to `main`.

### Merge tips (still true)

`supabase db push` (CI `test` job) rejects a migration numbered lower than the remote's latest,
so migrations must reach `dashboard-redesign` in number order.

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

After each merge run the full verify (§5) twice before pushing.

### History

The 2026-10-29 merge plan (0054–0059 merges, #26/theming finishing notes, the 0060+ build
order) is complete. It is kept in Git history (`git show 7bea8ac:docs/handoff/HANDOFF.md`) and
summarised in `TAKEOVER_CHECKPOINT.md`. The small fixes listed then are all closed on
`orch/fixes` (percent-encoded URLs, on-break top-ups, debug banner overlap, creator 2FA in the
database, invite expiry, last-active-admin, private rate-limit keys).

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
  Site URL should be the Preview URL `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app`
  (OWNER_STEPS 11, `docs/GO_LIVE.md` §3); inspect the actual value before changing it.

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
