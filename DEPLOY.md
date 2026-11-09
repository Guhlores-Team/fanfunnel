# Deploy FanFunnel (Vercel + Supabase)

Goal: a live site that auto-deploys from `main`, backed by the LIVE Supabase project, with
every other branch on a Preview backed by the TEST project. See
[`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md) for which is which and
[`AGENTS.md`](AGENTS.md) for the preview-before-prod rule.

**Going live for the first time?** Follow the ordered checklist in
[`docs/GO_LIVE.md`](docs/GO_LIVE.md). This page is the reference it points to.

> Anything in a browser dashboard (Vercel, Supabase, GitHub settings) is the owner's to click.
> It can't be automated from the repo.

---

## 1. Database schema

Migrations are applied by CI, not by hand: `.github/workflows/supabase-migrations.yml`
applies `supabase/migrations/` to **TEST** on every PR (`test` job) and to **LIVE** on merge to
`main` (`production` job). That workflow needs `SUPABASE_TEST_PROJECT_REF`,
`SUPABASE_TEST_DB_PASSWORD`, `SUPABASE_TEST_DB_URL` (the `test` job), and
`SUPABASE_PROD_PROJECT_REF`, `SUPABASE_PROD_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN` (the
`production` job). The PROD values and the account token belong in the **`production`
environment's** secrets, not the repository's: a repository secret reaches every same-repo PR
workflow (supply-chain audit SUP-1). Owner steps: [`docs/GO_LIVE.md` section 2](docs/GO_LIVE.md#supply-chain-settings-batch-6-audit).
If a project was set up by pasting SQL before the workflow existed, run
`docs/auto-migration-reconcile.sql` on it once first.

Manual paths (a brand-new project, or recovery):
- **Brand-new project:** run `supabase/schema.sql` in the SQL Editor. It is the complete current
  schema and is idempotent.
- **Existing project behind on migrations:** run `supabase/migrations_combined.sql`. Also
  idempotent.

CI (`npm test` and the `schema-drift` job) proves `migrations/`, `schema.sql` and
`migrations_combined.sql` build the same database.

**Keys:** Supabase → Project Settings → API: Project URL (`NEXT_PUBLIC_SUPABASE_URL`), anon public
key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), service_role key (`SUPABASE_SERVICE_ROLE_KEY`, secret).

---

## 2. Supabase Auth settings (both projects)

Every auth email link (sign-up confirm, password reset, email change) comes back to
`<site>/auth/callback?next=…`, built from the page's own origin
(`src/components/LoginForm.tsx`, `src/app/forgot-password/page.tsx`,
`src/app/api/account/email/route.ts`). Supabase only follows a link whose target is on its allow
list, so set, under **Authentication → URL Configuration**:

| Project | Site URL | Redirect URLs |
|---|---|---|
| LIVE `ttlogfmogcccwiraaoae` | `https://fanfunnel.vercel.app` | `https://fanfunnel.vercel.app/**` |
| TEST `snmcrmhgevfqggxdiomu` | the Preview URL, e.g. `https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app` | `https://fanfunnel-*-easy-simple-sites.vercel.app/**` (every branch Preview) and `http://localhost:3000/**` |

Also, in both projects:
- **Authentication → Emails → Templates:** paste the 5 link templates and turn on and paste the 2
  security notices from `supabase/templates/` (see its `README.md`).
- **Authentication → Providers → Email:** keep **Confirm email ON**. Turn on **leaked-password
  protection**.
- Enable **MFA** for the admin account.

---

## 3. Vercel project and environment variables

Project → **Settings → Environment Variables**. Scope matters: Production = LIVE, Preview and
Development = TEST.

| Name | Production | Preview | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | LIVE URL | TEST URL | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | LIVE anon key | TEST anon key | Browser key; RLS applies. |
| `SUPABASE_SERVICE_ROLE_KEY` | LIVE service key | TEST service key | Server-only. Never a `NEXT_PUBLIC_*` var. |
| `ADMIN_EMAILS` | owner email(s) | same | Comma-separated allowlist for the one-time admin claim (see step 4). Unset = nobody can claim admin. |
| `FF_REQUIRE_SUPABASE` | `1` | `1` | Fail closed instead of falling back to the in-memory demo. `VERCEL_ENV=production` already forces this on Vercel. |
| `NEXT_PUBLIC_ENABLE_DEBUG` | **unset** | `1` | Turns on the `?debug=1` error console and the "PREVIEW · TEST database" badge. Must never be set on Production. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | set by the Upstash integration | same | Shared rate-limit counters across instances (`src/lib/rateLimit.ts`). `UPSTASH_REDIS_REST_URL`/`_TOKEN` also work. Unset = per-instance in-memory limits; **required on Production**: without it the daily maintenance cron records "Rate limits are per instance in production" in Admin › Errors and Admin › System health says so. |
| `VAPID_PUBLIC_KEY` | separate public key | separate public key | Web push; see setup below. `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is accepted as an alternative name. |
| `VAPID_PRIVATE_KEY` | private key (Sensitive) | private key (Sensitive) | Server-only; never a `NEXT_PUBLIC_*` variable. |
| `VAPID_SUBJECT` | `mailto:you@yourdomain` | same | Contact for browser push services. |
| `NEXT_PUBLIC_SITE_URL` | optional | optional | Only for self-hosting behind a proxy that strips the scheme. Also the origin used for links in alert e-mails. |
| `CRON_SECRET` | random secret (Sensitive) | optional | Authorizes the daily retention cron (`vercel.json` → `/api/cron/retention`). At least 16 characters; generate with `openssl rand -hex 32`. Unset or too short: the cron refuses to run (fails closed) and records a "Retention cron is not configured" error in Admin › Errors, which e-mails `ALERT_EMAIL_TO`. Vercel only runs crons on Production. |
| `REWARD_ENCRYPTION_KEY` | 32 random bytes, base64 (Sensitive) | separate key (Sensitive) | Encrypts instant-delivery codes, links and texts (#26, `src/lib/rewards/crypto.ts`). Generate with `openssl rand -base64 32`. **Never rotate or replace it** without re-encrypting stored rewards: old codes become unreadable. Back up the original securely. Unset: instant-delivery prizes can't be saved or delivered. |
| `REWARD_ENCRYPTION_KEY_VERSION` | optional, integer | optional | The key version stamped on new ciphertexts (default `1`). Only changes as part of a planned re-encryption. |
| `REWARD_CODE_FINGERPRINT_KEY` | 32 random bytes, base64 (Sensitive) | separate key (Sensitive) | Keeps reward codes unique across pastes (keyed fingerprint). Generate with `openssl rand -base64 32`, independent of the encryption key. **Never rotate it**: erased codes could be pasted and handed out again. |
| `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_ENVIRONMENTS` | **required**: `RESEND_API_KEY` + `ALERT_EMAIL_TO` (see Monitoring) | optional | Error alerts, urgent safety-report alerts and creator account mail (approval, invitations, new-request notes). Without the key on Production, no creator gets the "you're approved" e-mail and System health shows **Alert e-mails: OFF** in red. Details under **Monitoring** below. |
| `HEARTBEAT_URL` | recommended: a heartbeat monitor's `https://` ping URL | unset | After each successful daily maintenance run the cron sends one GET (3 s timeout; a failure is logged, never fatal). When pings stop, the monitor e-mails you, even if our database or e-mail is down. Never logged or shown; System health only says whether it is set. |
| `FF_MAINTENANCE` | unset; `1` pauses the site | unset | Maintenance mode (`src/lib/ops/maintenance.ts`). Redeploy after changing it. Fans see a "back soon, nothing was spent" page, API writes answer 503, and `/dashboard`, `/admin`, `/login`, `/api/admin/*` and `/api/health` stay reachable. See `docs/RUNBOOK.md`. |
| `NEXT_PUBLIC_COMMIT_SHA` | unset | set only by CLI archive deploys | Short commit shown on the Preview badge when `VERCEL_GIT_COMMIT_SHA` is absent (`docs/PREVIEW_DEPLOY.md`). |

Add the TEST trio as GitHub secrets too (same names), so the `E2E (real Supabase)` workflow and
`scripts/security/rls-runtime-test.mjs` run instead of skipping.

**Deployment Protection** (Settings → Deployment Protection): keep Vercel Authentication on
**Standard Protection** (`all_except_custom_domains`), so Previews need a Vercel login and the
production domain is public.

---

## 4. Ship a change

1. Work on a branch off `main`. Push it: Vercel builds a Preview on the TEST database, and CI
   applies the branch's migrations to TEST.
2. Test the change on the Preview with real clicks.
3. When CI is green (`verify`, `schema-drift`, `supabase`, `login-ui`) **and** the Preview has been
   tested, merge the PR to `main`. CI migrates LIVE, and Vercel deploys Production.

First run on a fresh LIVE project: sign up at `/login`, confirm the email, then open `/admin`
and use **Claim admin** (works only for an `ADMIN_EMAILS` address). No SQL is needed.

### Rollback

Incident steps for the owner are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md) § Roll back a deploy. In order:

1. **Instant Rollback first.** Vercel → Deployments → the previous Production deployment →
   **Instant Rollback**. Traffic moves back within seconds, with no build and no migration job. It
   bypasses the `db-migrations-production` Deployment Check on purpose: the database is not changed.
2. **Then a revert PR.** Revert the bad merge on a branch, open a PR, wait for CI to go green, and
   merge it. The merge re-runs `db-migrations-production`, which needs the reviewer's approval. It is
   a verified no-op when no migration changed. This makes `main` match what is serving, so the next
   deploy does not bring the bad code back. Do not revert directly on `main`.
3. **Old code, new schema check.** Migrations are not rolled back. Before relying on the rollback,
   check that every migration in the bad release is expand-only (additive and idempotent). For each
   one, look for a dropped or renamed column, table or function, a narrowed `check`, or an RPC whose
   arguments or return shape changed, because the older code may still call the old shape. Then open
   Admin › System health: the schema line must say "newer than this release expects", not "behind".
   If a migration is not expand-only, do not just roll back: pause the site (`FF_MAINTENANCE=1`, see
   the runbook) and plan the fix. Never reverse a migration by hand.

## Monitoring (errors + e-mail alerts)

FanFunnel records its own errors; there is no third-party service to sign up for.

**What is captured, on every environment (Production, Preview, local):**
- Browser errors: uncaught errors, unhandled promise rejections and React error
  boundaries (`src/instrumentation-client.ts`, `src/app/error.tsx`,
  `src/app/global-error.tsx`) are posted to `POST /api/errors`.
- Server errors: route handlers, server components, server actions and the proxy,
  through `onRequestError` in `src/instrumentation.ts`.
- Everything is redacted before it is stored or e-mailed (fan link tokens, auth
  tokens and cookies, e-mails, passwords and API keys, query strings, ids, IPs),
  then grouped by fingerprint in the `app_errors` table (migration `0053`), so a
  repeat bumps a count instead of adding a row. The table keeps at most 1000
  groups and prunes the oldest resolved ones first.
- `POST /api/errors` is public but rate limited per IP, size-capped (16 KB),
  schema-checked and answers `204` with no body.

**Where to read errors:** sign in as an admin → **Dashboard › Admin**, section
**Errors** (direct link: `/dashboard?section=admin#errors`). Filter Open /
Resolved and by environment, expand an entry for its redacted stack, and press
**Resolve**. A resolved error that happens again reopens and alerts again.

**E-mail alerts** (sent with Resend's HTTP API). Add these in Vercel → Settings →
Environment Variables, for **Production** (and Preview too if you want Preview
alerts). All are server-only: never prefix them with `NEXT_PUBLIC_`.

| Name | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | your Resend API key | Required for alerts. |
| `ALERT_EMAIL_TO` | `you@example.com,ops@example.com` | Required for alerts. Comma list, up to 10. |
| `ALERT_EMAIL_FROM` | optional | Defaults to `FanFunnel <alerts@easysimplesites.org>` (domain verified in Resend; `src/lib/monitoring/config.ts`). |
| `ALERT_ENVIRONMENTS` | optional, e.g. `production,preview` | Defaults to `production`. |

If `RESEND_API_KEY` or `ALERT_EMAIL_TO` is missing, errors are still recorded and
alerts are off (the server logs that once, and Admin › System health shows
**Alert e-mails: OFF**, in red on Production). An alert goes out only for
the **first** occurrence of a new error or when a resolved one comes back, at
most **10 per hour** across all servers (`ALERT_MAX_PER_HOUR` in
`src/lib/monitoring/config.ts`). Errors held back by that limit are summed up in
one "N more new errors" e-mail once the hour frees up. E-mails are sent after the
response, so they never slow down or break a request.

**Create a Resend key restricted to sending:**
1. resend.com → **API Keys** → **Create API Key**.
2. Name it e.g. `fanfunnel-alerts`, permission **Sending access**, and restrict
   the domain to `easysimplesites.org`.
3. Copy the key once and paste it into Vercel as `RESEND_API_KEY` (Production;
   Preview if wanted). Never commit it or paste it anywhere else.
4. Redeploy so the new variables take effect.

**Database:** migration `0053_app_errors.sql` must reach the TEST project before
the Preview is tested and PROD before (or at) the merge to `main`. Only admins
(`is_admin()`) can read or resolve errors; nobody but the server can write them.

## Notes
- Re-running `migrations_combined.sql` is safe.
- Realtime chat needs nothing extra: Supabase Realtime is on for the `messages` table once the
  schema is loaded.
- Instant-delivery prizes (#26) need `REWARD_ENCRYPTION_KEY` and `REWARD_CODE_FINGERPRINT_KEY`
  (see the table in section 3). Back both up before any real reward is stored.
- Every variable the code reads is listed in section 3 and, with how to generate it, in
  `.env.example`. Values never go in the repo.
- Web push is off until the three `VAPID_*` variables are set. The Inbox alert
  link opens the same opt-in in Settings › Notifications.

---

## Web push setup (closed-tab notifications)

Creators can get the bell's alerts (a win to fulfil, a fan message, low prize
stock, a fan out of spins) as phone/desktop notifications, even with FanFunnel
closed. They turn it on per device in **Settings › Notifications › Push to this
device**. Until you do the steps below, that card says push isn't available and
nothing is sent.

1. **Database:** migration `0056_push_subscriptions.sql` (tables
   `push_subscriptions` + `push_log`, RLS on) must be applied: to the **test**
   project before the Preview, to **prod** before (or exactly at) the merge to
   `main`.
2. **Generate one key pair per environment** (Preview and Production each get
   their own; never reuse prod keys on Preview):

   ```bash
   npx web-push generate-vapid-keys
   ```

   It prints a **Public Key** and a **Private Key**. Don't commit them anywhere.
   Store both in your password manager.
3. **Vercel → Project → Settings → Environment Variables**, for **Preview** (the
   Preview pair) and **Production** (the Production pair):
   - `VAPID_PUBLIC_KEY` = the Public Key
   - `VAPID_PRIVATE_KEY` = the Private Key, marked **Sensitive**
   - `VAPID_SUBJECT` = `mailto:you@yourdomain` (same value for both is fine)

   Leave them out of **Development** unless you need push locally.
4. **Redeploy** (env changes apply to new deployments only).
5. **Set the keys once and leave them.** Every device's subscription is tied to
   the public key: changing it silently breaks push on every device until each
   creator turns it on again.
6. **Test on real devices** (Preview URL, test account):
   - Desktop Chrome/Edge/Firefox: Settings › Notifications › Push to this
     device → allow → **Send a test**.
   - Android Chrome: same, in the browser.
   - iPhone/iPad (iOS 16.4+): open the dashboard in Safari → Share → **Add to
     Home Screen** → open FanFunnel from the icon → turn push on there (Apple
     only allows web push in installed apps; in a Safari tab the card shows these
     steps instead).
   - Tap a notification: it opens the right dashboard section.

Privacy default (owner decision D9): a new device's lock screen shows only
"New activity on FanFunnel". A creator can switch **Show names and prizes on
lock screen** on per device. The default lives in `src/lib/push/config.ts`
(`DEFAULT_SHOW_DETAILS`) and the `push_subscriptions.show_details` column
default.
