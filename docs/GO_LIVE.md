# Future go-live checklist

This runbook prepares a possible future release to `main`, Vercel Production and
LIVE Supabase `ttlogfmogcccwiraaoae`. **Current takeover authorization is TEST
only.** Nothing here authorizes an agent to push/merge `main`, write LIVE, send
email, purchase a plan, copy data or retire deployments. Give the nontechnical
owner only the next applicable step with its full clickable link.

**Who does each line:**

- **OWNER**: performs an account action, decision or separately authorized LIVE operation.
- **AGENT**: the coding agent prepares/reviews source and evidence on the branch, local environment or TEST; it does not operate LIVE.
- **OWNER + AGENT**: the agent prepares a concrete plan; the owner reviews it and performs or explicitly authorizes its defined action.

Follow this in order. An unchecked item is not a pass. Record the exact release
SHA, target, date, result and redacted evidence. Never paste passwords, API keys,
reward values, fan links, exports or authenticator codes into chat or logs.

References: [binding rules](../AGENTS.md), [current handoff](handoff/HANDOFF.md),
[TEST owner steps](handoff/OWNER_STEPS.md), [environment identities](ENVIRONMENTS.md),
[deployment settings](../DEPLOY.md), [controlled Preview release](PREVIEW_DEPLOY.md),
[manual checklist](../e2e/MANUAL-CHECKLIST.md) and [security audit brief](handoff/SEC_AUDIT_BRIEF.md).

## 1. Finish and accept the complete TEST release

- [ ] **AGENT**: Complete the owner's full pre-alpha scope and small fixes from the handoff, in migration order. This includes privacy0054, legal0055, push0056, instant delivery0057, theming0058, Focus0059, Scratch0060, personal Bingo0061, account security0062 and operational integrity0063. Include any subsequently reviewed migrations; this list is scope, not a claim that they are applied anywhere.
- [ ] **AGENT**: After each integration, complete both full verification rounds specified in the handoff: install, lint, types, unit/security tests, debug build, PostgreSQL16 drift, all e2e/scripts.mjs syntax checks, and e2e then accessibility on the same fresh server. Preserve failures and skips honestly.
- [ ] **AGENT**: Confirm exact-SHA CI jobs `verify`, `schema-drift`, migration `test`, `supabase` and `login-ui` all completed successfully, with actual TEST migration history, generated-type comparison and non-skipped runtime/login tests. Deploy that exact source to Preview only after TEST is ready; verify actual hosted clicks.
- [ ] **AGENT**: Complete two fresh independent security audits plus privacy-promise and outside-attacker passes per the audit brief; verify/fix confirmed Critical and High findings and record remaining limits in the final report. Earlier feature reviews are not substitutes.
- [ ] **OWNER + AGENT**: Complete the TEST manual checklist on real phones as creator and fan, including age/Terms consent, breaks, export/deletion, instant rewards using dummy values, theming, Focus, Scratch, Bingo and account recovery. Record revision/device/result. Review measured themed Preview LCP and the actual hosted feature-smoke cleanup result.
- [ ] **OWNER**: Review [TEST Terms](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/terms), [TEST Privacy](https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app/privacy), responsible-play copy and [legal questions](LEGAL_NOTES.md). The legal pages and in-house error monitoring have been implemented; owner/legal acceptance and actual alert receipt are separate checks.
- [ ] **OWNER + AGENT**: Review the saved product defaults in [PROPOSALS](handoff/PROPOSALS.md), including price/cost warnings, opt-in Boostable prizes and lock-screen privacy. Keep the chosen recommended defaults behind their named constants; do not restart settled decisions. Hosted Chase stays OFF until documented Focus soak and a separately approved one-creator TEST pilot pass.
- [ ] **OWNER**: Explicitly confirm acceptance of the exact tested Preview revision. This is necessary for a future release; it is not permission for an agent to merge or write LIVE.

## 2. Confirm provider security and GitHub protections

- [ ] **OWNER**: Verify provider two-factor and recovery for everyone with access, using [GitHub security](https://github.com/settings/security), [Vercel account](https://vercel.com/account), [Supabase account security](https://supabase.com/dashboard/account/security) and the owning email account. Save recovery codes privately; do not share logins/factors.
- [ ] **OWNER**: Review [branch rules](https://github.com/Guhlores-Team/fanfunnel/settings/branches) for `main`: require a PR, the exact required green jobs and an approval. Record any plan limitation rather than assuming protection is enabled.
- [ ] **OWNER**: In [GitHub environments](https://github.com/Guhlores-Team/fanfunnel/settings/environments), require your review for `production` database operations. On its own this does not delay Vercel's deployment; the section 5 Deployment Check on `db-migrations-production` does.
- [ ] **OWNER**: Review [repository security](https://github.com/Guhlores-Team/fanfunnel/settings/security_analysis): secret scanning, push protection and dependency alerts where supported. Dependabot configuration alone does not prove these settings are enabled.
- [ ] **OWNER + AGENT**: Confirm required Actions secret names and target identity without exposing values: migration access token, TEST/PROD project refs and database passwords, plus TEST URL/anon/service credentials for real tests. A working Git connection does not prove permission to manage [Actions secrets](https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions).

## 3. Verify Auth and recovery on TEST; prepare LIVE separately

Auth email links must return to the correct site's `/auth/callback?next=…` through
an allowed URL. Prepared templates are not proof of delivery or correct redirects.

- [ ] **OWNER + AGENT**: Review [TEST URL configuration](https://supabase.com/dashboard/project/snmcrmhgevfqggxdiomu/auth/url-configuration). Its intended Site URL is `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app`; inspect the actual value and review existing Preview/local redirect allowances before changing them. Never substitute the LIVE ref.
- [ ] **OWNER**: Review email confirmation and leaked-password protection; record unavailable plan features without purchasing anything. Keep confirmation ON.
- [ ] **OWNER**: Verify configured SMTP and the five [link templates](../supabase/templates/README.md): recovery, confirmation, magic link, invite and email change; review password/email security notices too. Do not blindly replace working settings merely because files exist.
- [ ] **OWNER**: Perform reset and email-change checks using a disposable TEST address you control, or explicitly authorize a defined TEST send. Confirm branded receipt, required confirmation links and return to TEST. An agent must not send real email without that authorization.
- [ ] **OWNER + AGENT**: Confirm two independent trusted TEST admins can sign in with their own two-factor and demonstrate recovery on a disposable creator. The owner has already enrolled FanFunnel admin two-factor; do not repeat enrollment or experiment on the only working admin.
- [ ] **OWNER**: For a separately approved future release, review the analogous [LIVE URL configuration](https://supabase.com/dashboard/project/ttlogfmogcccwiraaoae/auth/url-configuration), email protections, SMTP and templates. Intended LIVE Site URL is `https://fanfunnel.vercel.app` until a separately approved domain changes it. No current agent operation targets LIVE.

## 4. Verify configuration, original keys and operational recovery

Owner step-by-step: [`docs/handoff/GO_LIVE_KEYS.md`](handoff/GO_LIVE_KEYS.md) (checked against the real Vercel env list on 2026-11-04, names only).

Variable names by scope (see the checks below for how to verify each):

- [ ] **OWNER**: **Production** scope: LIVE `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; `ADMIN_EMAILS` (your address);
      `FF_REQUIRE_SUPABASE=1`. **`NEXT_PUBLIC_ENABLE_DEBUG` must NOT be set.**
- [ ] **OWNER**: **Preview** scope: the TEST trio, the same `ADMIN_EMAILS`,
      `FF_REQUIRE_SUPABASE=1` and `NEXT_PUBLIC_ENABLE_DEBUG=1`.
- [x] **Done (env listing of 2026-11-04)**: the shared rate-limit store (A22) is configured. The
      Upstash integration injected `KV_REST_API_URL` and `KV_REST_API_TOKEN` (plus `KV_URL`,
      `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN`) into **both** Production and Preview. Without
      them every route limit would be per serverless instance and the retention cron would report
      the store as `per_instance`; the first LIVE smoke check confirms it reads `shared`.
- [ ] **OWNER**: **Production** scope, **required**, generated fresh for LIVE (never copied from Preview):
      `CRON_SECRET` (`openssl rand -hex 32`; without it the retention cron refuses to run and
      Admin › Errors alerts), `REWARD_ENCRYPTION_KEY` and `REWARD_CODE_FINGERPRINT_KEY` (each
      `openssl rand -base64 32`, Sensitive, backed up securely, never rotated), the web-push
      VAPID trio, and `RESEND_API_KEY` + `ALERT_EMAIL_TO` for alerts. Names, scopes and warnings:
      the table in [`DEPLOY.md` section 3](../DEPLOY.md#3-vercel-project-and-environment-variables).
      **Optional**, only during a reward-key rotation (procedure below): `REWARD_ENCRYPTION_KEY_PREVIOUS`
      and, when needed, `REWARD_ENCRYPTION_KEY_PREVIOUS_VERSION`; unset otherwise.
      **Known gap (env listing of 2026-11-04, names only):** Production is still missing
      `ADMIN_EMAILS`, `FF_REQUIRE_SUPABASE`, `CRON_SECRET`, `REWARD_ENCRYPTION_KEY`,
      `REWARD_CODE_FINGERPRINT_KEY`, the VAPID trio, `RESEND_API_KEY` and `ALERT_EMAIL_TO`
      (Preview has all but the two alert variables; `CRON_SECRET` is set on neither scope). Until
      they exist the 0063 startup canary reports the crypto configuration as missing and the
      retention cron / error alerts refuse to run; the first LIVE smoke check (section 9) must
      confirm System health is green. The owner's checklist: `docs/handoff/GO_LIVE_KEYS.md`.

- [ ] **OWNER + AGENT**: Review [Vercel environment settings](https://vercel.com/easy-simple-sites/fanfunnel/settings/environment-variables) by scope. Preview must use TEST URL/anon/service credentials; future Production must use LIVE credentials. Service keys remain server-only. `FF_REQUIRE_SUPABASE=1` prevents accidental mock fallback; `NEXT_PUBLIC_ENABLE_DEBUG=1` belongs only in Preview and must be absent from Production.
- [ ] **OWNER + AGENT**: Confirm server-controlled admin profiles and independent two-factor access. `ADMIN_EMAILS` is configuration, not a substitute for checking actual role/active/approval state or RLS.
- [ ] **OWNER + AGENT**: Verify the shared rate-limit service and failure behavior. Supported variable pairs are `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`. Without shared storage, bounded per-instance fallback does not provide a global distributed quota.
- [ ] **OWNER + AGENT**: Verify Preview's existing VAPID configuration without replacing it: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. Real installed-iPhone/Android receipt and privacy checks remain necessary. A future Production pair/configuration is a separate reviewed action.
- [ ] **OWNER + AGENT**: Know the reward-key rotation procedure before it is ever needed (it is
      the only supported way to change `REWARD_ENCRYPTION_KEY`; never swap the key in place):
      1. Generate the new key (`openssl rand -base64 32`) and back it up through the private
         operator path, next to the original.
      2. Set `REWARD_ENCRYPTION_KEY_PREVIOUS` to the key that is current now and, if the
         current version is not exactly one below the new one, `REWARD_ENCRYPTION_KEY_PREVIOUS_VERSION`
         to its version. Set `REWARD_ENCRYPTION_KEY` to the new key and bump
         `REWARD_ENCRYPTION_KEY_VERSION`. Keep `REWARD_CODE_FINGERPRINT_KEY` unchanged (set it to
         the ORIGINAL key first if the project still runs on version 1 without it).
      3. Redeploy. New rewards are sealed with the new key; stored rewards sealed with the
         previous key still open (`src/lib/rewards/crypto.ts` keyring, pinned by
         `rewards.test.ts`). Anything sealed under an older version than the previous one is
         refused, not mis-decrypted, so rotate one step at a time.
      4. Once no undelivered reward sealed under the previous version remains (check
         `prize_rewards` / `prize_reward_codes` key versions), remove the `_PREVIOUS` variables
         and redeploy. Record the rotation (who, when, versions) in the operator log.
- [ ] **OWNER + AGENT**: Securely back up the ORIGINAL `REWARD_ENCRYPTION_KEY`, its `REWARD_ENCRYPTION_KEY_VERSION` (default1 when unset), and the separate stable `REWARD_CODE_FINGERPRINT_KEY` through the existing private backup/operator path. Never rotate keys to silence an error, display values in logs or generate replacements and call them a backup. Review [instant delivery](INSTANT_DELIVERY.md).
- [ ] **OWNER + AGENT**: Complete a disposable TEST restore rehearsal before real-value inventory. Prove dummy reward decryption, erased-code non-reuse, financial/data relationships and canary health using the original keys. Specify whether database, Auth associations, public media bytes/storage metadata and configuration are covered; record exclusions. A database backup and a key backup are both required, and their existence alone is not a restore pass.
- [ ] **OWNER + AGENT**: After verified0063 rollout, inspect actual legacy erased/live-code and anchor counts, then follow the current System health result. Counts alone do not validate original keys or authorize initialization. Legacy erasure without an anchor requires the reviewed recovery path; never bless replacement keys or overwrite a mismatch.
- [ ] **AGENT**: Verify real authenticated TEST retention/storage maintenance and healthy key/inventory/reservation/credit diagnostics. Observe the actual daily scheduler's enqueue, HTTP and application completion; setup/manual invocation alone is insufficient. Vercel cron is Production-only; the reviewed TEST scheduler is separate.
- [ ] **OWNER**: After an explicitly authorized safe TEST alert, confirm actual receipt in the intended private inbox. Verify `RESEND_API_KEY`/`ALERT_EMAIL_TO` scope without exposing values. Monitoring code or a green UI does not prove email delivery.
- [ ] **OWNER + AGENT**: Before any future Production configuration, prepare its own original-key backups, restore proof, maintenance/alert plan and rollback compatibility. Do not copy Preview secrets or pretend TEST evidence proves LIVE operations.
- [ ] **AGENT**: Confirm the verified TEST Preview shows the teal TEST badge. A red environment badge is a stop condition.

## 5. Plan LIVE database-before-code ordering before any merge

**This section is future owner work, not current authorization.** A reviewed,
backed-up LIVE schema must be ready before code that requires it can serve traffic.

### The enforced gate (A39): Vercel Deployment Check on `db-migrations-production`

Vercel deploys `main` from Git on its own, so ordering cannot come from GitHub
alone. The gate that works with that setup is a **Vercel Deployment Check**:
Vercel still builds each Production deployment, but does not assign it to the
production domain until the named GitHub check on the same commit succeeds.

- The [migration workflow](../.github/workflows/supabase-migrations.yml) job
  `production` is named **`db-migrations-production`**. It runs on **every**
  push to `main` (the old `paths:` filter is gone, so code-only pushes get the
  check too), uses the `production` environment, runs `supabase db push`, then
  re-reads `supabase migration list --linked` and fails unless the remote
  history holds every migration file in that commit and nothing unknown
  ([`scripts/ci/verify-migrations-applied.mjs`](../scripts/ci/verify-migrations-applied.mjs)).
  The TEST job runs the same read-back on pull requests.
- With the Deployment Check required, new code is promoted only after that
  job passes; a failed, cancelled or never-approved job leaves the previous
  Production deployment serving. A code-only push is a verified no-op run.
- `node scripts/test/db-before-code.test.mjs` (CI `verify` job) pins the
  trigger, the job name, the push-then-verify order and this section.

Owner setup, once (nothing in the repo can turn it on):

- [ ] **OWNER**: In [Vercel → Settings → Build and Deployment → Deployment Checks](https://vercel.com/easy-simple-sites/fanfunnel/settings/build-and-deployment#deployment-checks), select **Add Checks** → **GitHub** and require exactly `db-migrations-production`.
- [ ] **OWNER**: In [Vercel → Settings → Environments → Production](https://vercel.com/easy-simple-sites/fanfunnel/settings/environments/production), confirm automatic aliasing for Production is ON (Deployment Checks only promote with it on).
- [ ] **OWNER + AGENT**: Prove it on the first merge after setup: the new Production deployment shows the check as pending and stays un-aliased until `db-migrations-production` is green, then is promoted. Record the deployment and run links.
- [ ] **OWNER**: The `production` environment's required reviewer now applies to every `main` push. Approving a code-only run is approving a verified no-op; rejecting it keeps the old deployment live.

Residual gaps, stated plainly:

- **Owner setting.** Until the Deployment Check is configured in Vercel, this
  is not enforced; the repo cannot verify the setting. **Force Promote**,
  Instant Rollback, `vercel --prod` and a manual redeploy bypass it.
- **Old code meets the new schema.** The previous deployment keeps serving
  while migrations apply, so every migration must stay compatible with the
  code already live (expand, then contract in a later release). The check
  does not prove that; review it per migration.
- **Build time.** The new build runs before the check. It must not need the
  new schema at build time; keep build-time data reads out of the app.
- **Superseded commits.** The workflow's concurrency group replaces a pending
  run with a newer one, so an intermediate `main` commit can end cancelled and
  never be promoted; the newer commit carries its migrations.
- **Runtime schema-version check (0067): flags, does not fail closed.**
  `public.schema_version()` returns the migration level the database was
  built to (69 after 0069). It is a constant every migration redefines with
  its own number, not a read of `supabase_migrations.schema_migrations`: that
  table is not exposed through the Data API and is empty when SQL was pasted
  by hand, while the constant travels with the schema itself.
  `src/lib/operations/schemaVersion.test.ts` (in `npm test`) fails unless the
  newest migration redefines it to its own number, both snapshots end on it
  and the app's `EXPECTED_SCHEMA_VERSION` matches. It is granted to
  `service_role` only (revoked from `public`, `anon`, `authenticated`); the
  server reads it with the service client. A database **behind** the code's
  level (or without the function, i.e. before 0067) is shown in
  **Admin › System health**, fails the manual **Run checks now** and the daily
  maintenance cron (`/api/cron/retention`, HTTP 503), and is reported at server
  startup through the existing error/alert pipeline with a fixed message.
  A database **ahead** of the code passes (that is the normal DB-before-code
  order). The app keeps serving either way: a maintenance page was rejected
  because a false "behind" (a transient read error) would take the site down.
- [ ] **OWNER + AGENT**: After every LIVE migration, open **Admin › System health** on LIVE and confirm the schema line reads "as this release expects" (or "newer"), then **Run checks now**. A "behind" line means the code is live without its migration: roll the deployment back or apply the reviewed migration before relying on the new features.

### Release plan before any merge

The current [migration workflow](../.github/workflows/supabase-migrations.yml)
runs TEST on pull requests and the gated Production job on every push to
`main`. Workflow concurrency and the environment approval alone do **not**
establish ordering; the Deployment Check above does, once configured.

- [ ] **OWNER + AGENT**: Prepare and approve a concrete release plan before any main merge. One option is owner-run pre-application of the exact reviewed migrations while the old code remains safely served, but only after proving old-code/new-schema compatibility. If that cannot be proved, prepare a separately reviewed traffic/deployment hold and restoration plan. Do not assume additive numbering makes an old deployment compatible; later auth/RPC contracts can deliberately retire old calls.
- [ ] **OWNER**: Verify a recoverable LIVE backup and the original-key backup, intended project identity and actual migration history. Keep LIVE credentials in approved private controls; the agent does not obtain or use them. Never run `supabase/reset.sql` on LIVE.
- [ ] **OWNER + AGENT**: Compare actual LIVE schema/history with the final checked commit, including required migrations 0001–0069 and any subsequently reviewed additions. Record exactly which migrations are missing; do not use a stale hardcoded “already applied” list. Required later scope includes 0059 Focus, 0060 Scratch, 0061 Bingo, 0062 account security, 0063 operational integrity, 0064 completeness gaps, 0065 per-fan game pins and batch-3 hardening, 0066 agency seat scopes, the approval notice and alert release, and 0067 cancelled-prize stock and `schema_version()`.
- [ ] **OWNER + AGENT**: If historical SQL was pasted manually, investigate history/schema divergence with a separate reviewed reconciliation plan and backup. Do not mark a migration applied merely to make CI green, infer execution from a history row, or assume a rerun is harmless.
- [ ] **OWNER + AGENT**: Review the existing ledger prechecks and migration-specific constraints on actual data, including negative balances/grants, stock and costs. A warning or skipped constraint is not proof of the intended invariant. Resolve unexpected counts before proceeding; do not repair financial records automatically.
- [ ] **OWNER**: Only after explicit approval for that exact Production operation, use the pinned supported Supabase CLI from the final checked source, verify the selected project is LIVE, inspect `supabase migration list --linked` and the pending migration plan, then perform the reviewed `supabase db push --linked` in strict numeric order. Credentials go through secure operator controls, not chat, saved scripts or command logs. Review configured Vault/seed/role behavior and supported CLI flags rather than adding broad include/reset flags. This runbook is not an instruction to execute those commands now.
- [ ] **OWNER + AGENT**: Record actual completed application, re-read history and compare generated database types/schema with the exact release contract. Check Advisors and relevant invariants/security expectations. A success message or manually inserted history record is not enough. Failed, partial or uncertain application stops release pending inspection.
- [ ] **OWNER**: Confirm the reviewed DB-before-code plan is complete and authorizes admission of the new code only after every prerequisite is verified.

## 6. Optional chosen TEST data transfer — separate approval

The owner wants to keep selected TEST work at go-live. The tool is
[`scripts/golive/carry-over.mjs`](../scripts/golive/carry-over.mjs) (A38). It
exists and is tested; **running it against LIVE is not authorized by this
checklist** and the agent never runs it against a hosted project.

What it does: copies chosen creators' **configuration** from TEST to LIVE,
matched by Auth email. The LIVE account must already exist (the creator signs
up or is invited; the tool never creates Auth users or sends email) and be an
active, approved creator with the game features their games need.

| Carried | Never carried |
| --- | --- |
| Profile look and copy: theme, display name, public page address/tagline/tip link, chat intro/outro, creator note, notification and leaderboard preferences | Fans, fan passes, spins, attempts, grants, redemptions, wishlists, referrals, messages, check-ins, outreach |
| Unarchived games (wheel, scratch, bingo) with prizes and game config | Reward secrets (`prize_rewards`) and reward codes; archived games |
| Campaigns and their packs | Media bytes and rows, avatar and prize image URLs |
| Prize, wheel and DM templates; Focus setting | Webhooks, happy hours, role/approval/features/org/terms, Auth |

Changes on the way, each listed in the plan: every row gets a new
deterministic id; games arrive **paused**; link/text prizes become **manual**
(re-enter the link/text in LIVE); code prizes arrive with **0 stock** (add
codes in LIVE); a photo background falls back to `glow`; an avatar app icon
falls back to `neutral`; **Chase is off**. A plan still pointing at the TEST
project or at a TEST row id is blocked.

Safety rails: `--from-ref` must be TEST `snmcrmhgevfqggxdiomu` and `--to-ref`
must be LIVE `ttlogfmogcccwiraaoae` (equal refs are refused); each database
URL comes only from `CARRY_FROM_DB_URL` / `CARRY_TO_DB_URL` (a URL on the
command line is refused) and must name its own project; dry run is the
default and reads both sides in read-only transactions; `--apply` refuses any
blocked creator and then requires the exact typed line
`CARRY snmcrmhgevfqggxdiomu -> ttlogfmogcccwiraaoae: <sorted emails>`. Each
creator is one transaction that re-checks the LIVE account; the run stops at
the first failure and the JSONL resume log (`--resume-log`, default
`golive-carry-over-ttlogfmogcccwiraaoae.log.jsonl`) lets a re-run skip finished
creators. Without the log a re-run still inserts nothing twice (same ids), but
it re-applies profile fields, so keep the log.

Proof: `node scripts/golive/carry-over.test.mjs` (pure refusals, binding,
planner, SQL) and `node scripts/golive/carry-over.db.test.mjs` (two disposable
Postgres 16 databases built from `supabase/schema.sql`: dry run writes
nothing, blocked/unconfirmed applies write nothing, real triggers accept the
writes, re-runs change nothing, a mid-run failure rolls back and resumes). CI
runs both.

- [ ] **OWNER**: Identify the exact creator emails to keep; unselected TEST records do not move.
- [ ] **OWNER**: Make sure each chosen creator has a LIVE account that is approved and active, with the Scratch/Bingo features their games use (Admin in LIVE).
- [ ] **OWNER + AGENT**: Dry run (no `--apply`) from a private machine with `psql`, the two URLs in the environment only, and review the printed plan per creator: carried counts, "not carried" counts, notes and blockers. Keep emails, URLs and output private.
- [ ] **OWNER**: Approve the exact list only after the dry run and the section 4/5 prerequisites (LIVE backup first), then run with `--apply` and type the confirmation line yourself. Agents do not hold LIVE credentials.
- [ ] **OWNER + AGENT**: Verify one carried account in LIVE (games paused, prizes, campaigns, templates), then have the creator re-enter link/text rewards, add codes, re-upload photos and turn games on. Keep the resume log with the release evidence.
- Residual gaps: the hosted `postgres` role's privileges on LIVE and pooler behaviour are not exercised by the local test; carried rows keep their TEST `created_at`; the tool has never run against a hosted database.

## 7. Preview protection and old deployment retirement

- [ ] **OWNER + AGENT**: Complete the final Preview acceptance before changing access protection. Review [Vercel project settings](https://vercel.com/easy-simple-sites/fanfunnel/settings) → Deployment Protection; its prior setting was Standard Protection (`all_except_custom_domains`), but inspect current behavior and the intended real-device testing needs first.
- [ ] **OWNER**: Approve the concrete protection change when ready. In a private window, verify the intended Preview requires Vercel login while the LIVE domain remains accessible as intended. Do not generate bypass secrets or change Production protection incidentally.
- [ ] **AGENT**: Refresh the old immutable Preview inventory and prepare a concrete retirement/recreation-prevention plan after the replacement is fully verified. Stable-alias movement alone does not disable old endpoints or complete legacy-byte cleanup.
- [ ] **OWNER**: Review and explicitly approve any exact retirement list. Preserve all Production/current Preview deployments, Git history and TEST data. Deletion does not guarantee instant cancellation: verify no new requests reach legacy code, allow each old function's actual maximum execution bound, then reconcile any untracked bytes. No retirement is authorized by the general takeover instruction.

## 8. Future release approval and owner merge

- [ ] **AGENT**: Report the full checked SHA, both verification rounds, actual exact-SHA CI/TEST results, final audit status, hosted/manual evidence and outstanding limits. Confirm the branch has not advanced since the accepted Preview.
- [ ] **OWNER**: Explicitly approve that exact release only after sections1–7 and the DB-before-code plan are complete. Any new code/schema change invalidates the affected sign-off and requires its checks again.
- [ ] **OWNER**: Perform the reviewed merge to `main`; the coding agent does not merge or push main. Confirm which Production deployment serves traffic and its exact source.
- [ ] **OWNER**: Inspect the Production migration job (`db-migrations-production`, which runs on every `main` push) and approve it only under the reviewed plan. If migrations were safely pre-applied it is a verified no-op. Confirm the Vercel deployment stayed un-aliased until the check passed, then confirm genuine history/types before admitting new traffic.

## 9. Owner-operated LIVE smoke checks after separate release approval

These checks include writes and email; they are not “read-only” and do not grant
an agent permission to exercise Production.

- [ ] **OWNER**: Confirm the Production deployment is READY, the intended LIVE database is healthy and the reviewed schema is in place before use.
- [ ] **OWNER**: Confirm `https://fanfunnel.vercel.app` (or the approved domain) shows no TEST/debug badge and `?debug=1` cannot activate the debug console.
- [ ] **OWNER**: Follow the manual LIVE smoke with only controlled data: sign in, inspect sections, open a controlled fan link, perform the approved test play and fulfilment, then reconcile its records. Confirm real admin two-factor and normal-user denial.
- [ ] **OWNER**: If authorized, request and complete a controlled password reset; confirm branded receipt and return to the LIVE domain. Review final Terms/Privacy and actual alert/maintenance evidence.
- [ ] **OWNER**: Record the outcome and any required incident response. TEST success does not waive these LIVE checks.

## 10. Rollback and recovery

- [ ] **OWNER + AGENT**: Before release, identify the exact safe rollback deployment and prove its compatibility with the new database/auth contracts on TEST. Do not assume an older build is compatible with retired RPCs or that code rollback restores schema/data.
- [ ] **OWNER**: If a release fails, execute only the approved traffic/code rollback plan. A separately reviewed Vercel rollback and/or revert PR on main is an owner operation; preserve evidence and prevent an automatic redeploy of known-unsafe code.
- [ ] **OWNER**: Do not reverse migrations, reset LIVE, rotate reward keys or repair economic records as a shortcut. Follow the reviewed backup/restore and incident plan if data recovery is needed; record exactly what was restored and re-verify invariants before reopening traffic.
- [ ] **AGENT**: Reproduce/fix on a branch Preview with TEST data, repeat affected full verification/audit/hosted gates, then prepare a new concrete release for owner approval.
