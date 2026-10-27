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

## Notes
- Re-running `migrations_combined.sql` is safe.
- Realtime chat needs nothing extra: Supabase Realtime is on for the `messages` table once the
  schema is loaded.
- Optional later keys: `REWARD_ENCRYPTION_KEY` (encrypted digital rewards) and a web-push VAPID
  keypair, both only when those features ship.
