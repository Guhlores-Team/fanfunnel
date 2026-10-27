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
`main` (`production` job). That workflow needs these GitHub repository secrets:
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_TEST_PROJECT_REF`, `SUPABASE_TEST_DB_PASSWORD`,
`SUPABASE_PROD_PROJECT_REF`, `SUPABASE_PROD_DB_PASSWORD`. If a project was set up by pasting SQL
before the workflow existed, run `docs/auto-migration-reconcile.sql` on it once first.

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
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | set by the Upstash integration | same | Shared rate-limit counters across instances (`src/lib/rateLimit.ts`). `UPSTASH_REDIS_REST_URL`/`_TOKEN` also work. Unset = per-instance in-memory limits. |
| `NEXT_PUBLIC_SITE_URL` | optional | optional | Only for self-hosting behind a proxy that strips the scheme. |

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

**Rollback:** revert the merge commit on `main`. Vercel redeploys the previous build. Migrations
are not rolled back automatically. They are written to be backward-compatible (additive,
idempotent), so the previous code keeps running on the newer schema. Check that is still true for
any migration that renames or drops something before relying on a plain revert.

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
| `ALERT_EMAIL_FROM` | optional | Defaults to `FanFunnel Alerts <alerts@easysimplesites.org>` (domain verified in Resend). |
| `ALERT_ENVIRONMENTS` | optional, e.g. `production,preview` | Defaults to `production`. |

If `RESEND_API_KEY` or `ALERT_EMAIL_TO` is missing, errors are still recorded and
alerts are silently off (the server logs that once). An alert goes out only for
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
- Optional later keys: `REWARD_ENCRYPTION_KEY` (encrypted digital rewards) and a web-push VAPID
  keypair, both only when those features ship.
