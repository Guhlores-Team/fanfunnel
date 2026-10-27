# Go-live checklist

One ordered list for taking FanFunnel live: merging the current work to `main`, which deploys
https://fanfunnel.vercel.app on the LIVE Supabase project `ttlogfmogcccwiraaoae`. Work top to
bottom. Don't start a section until the one before it is done.

**Who does each line:**
- **OWNER**: a dashboard click or a decision only the owner can make.
- **AGENT**: Claude can do it in the repo or on the TEST project. Agents never touch LIVE or the
  live site.
- **OWNER + AGENT**: the agent prepares it and the owner runs or approves it.

References: [`DEPLOY.md`](../DEPLOY.md) (settings in detail), [`ENVIRONMENTS.md`](ENVIRONMENTS.md)
(LIVE vs TEST), [`AGENTS.md`](../AGENTS.md) (preview-before-prod rule),
[`e2e/MANUAL-CHECKLIST.md`](../e2e/MANUAL-CHECKLIST.md) (click-through QA).

---

## 1. Decisions and sign-offs (before anything else)

- [ ] **OWNER**: Supply the final **Terms** and **Privacy** text. Both pages are labelled
      placeholders today (`src/components/LegalPage.tsx`). AGENT then replaces the page bodies.
- [ ] **OWNER**: Review the break-reminder and responsible-play copy.
- [ ] **OWNER**: Decide on error monitoring (Sentry, a Vercel log drain, or none for alpha).
- [ ] **OWNER**: Answer the open product decisions (PROPOSALS §2 items 3–7 and 9–15) and the
      TEAM_CHECKLIST §3 sign-offs: dark text on default-pink buttons (`readableInk`), the nav
      labels, the line-icon set.
- [ ] **OWNER**: Run all of [`e2e/MANUAL-CHECKLIST.md`](../e2e/MANUAL-CHECKLIST.md) §1–3 and §6 on
      the Preview (TEST data), and §5 if you want the load check.

## 2. GitHub settings

- [ ] **OWNER**: Branch protection on `main` (Settings → Branches): require a PR, require the
      checks `verify`, `schema-drift`, `supabase` and `login-ui`, and require 1 approval.
- [ ] **OWNER**: Settings → Environments → `production`: add yourself as a **required reviewer**,
      so the LIVE migration job waits for your click.
- [ ] **OWNER**: Settings → Code security: turn on **secret scanning** and push protection.
      Dependabot is already configured (`.github/dependabot.yml`).
- [ ] **OWNER**: Repository secrets for the migration workflow: `SUPABASE_ACCESS_TOKEN`,
      `SUPABASE_TEST_PROJECT_REF`, `SUPABASE_TEST_DB_PASSWORD`, `SUPABASE_PROD_PROJECT_REF`,
      `SUPABASE_PROD_DB_PASSWORD`.
- [ ] **OWNER**: The TEST trio as secrets too (`NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), so `E2E (real Supabase)` and
      the RLS runtime test run instead of skipping.
- [ ] **AGENT**: Confirm on the release PR that all four checks ran (not skipped) and are green.

## 3. Supabase Auth, in BOTH projects

Every auth email link returns to `<site>/auth/callback?next=…` on the site that sent it.
Supabase only follows a link to an allowed URL.

- [ ] **OWNER**: Authentication → URL Configuration on **LIVE**: Site URL
      `https://fanfunnel.vercel.app`, Redirect URL `https://fanfunnel.vercel.app/**`. Both were
      added on 2026-10-27; re-check them.
- [ ] **OWNER**: Same on **TEST**: Site URL = the Preview URL, Redirect URLs = the Preview
      wildcard `https://fanfunnel-*-easy-simple-sites.vercel.app/**` (added 2026-10-27) and
      `http://localhost:3000/**`.
- [ ] **OWNER**: Authentication → Emails → Templates: paste the 5 link templates from
      `supabase/templates/`, each with its subject from `supabase/templates/README.md`:
      `recovery.html` (Reset password), `confirmation.html` (Confirm signup), `magic_link.html`
      (Magic link), `invite.html` (Invite user), `email_change.html` (Change email address).
- [ ] **OWNER**: Same screen, **Security notices**: turn ON and paste `password_changed.html`
      (Password changed) and `email_address_changed.html` (Email address changed).
- [ ] **OWNER**: Authentication → Providers → Email: **Confirm email ON**. Turn on
      **leaked-password protection**.
- [ ] **OWNER**: Enable **MFA** on the admin account.
- [ ] **AGENT**: On the TEST Preview, sign up a throwaway address, then do a password reset and an
      email change. Each email must arrive branded, and its link must land back on the Preview.

## 4. Vercel environment variables

- [ ] **OWNER**: **Production** scope: LIVE `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; `ADMIN_EMAILS` (your address);
      `FF_REQUIRE_SUPABASE=1`. **`NEXT_PUBLIC_ENABLE_DEBUG` must NOT be set.**
- [ ] **OWNER**: **Preview** scope: the TEST trio, the same `ADMIN_EMAILS`,
      `FF_REQUIRE_SUPABASE=1` and `NEXT_PUBLIC_ENABLE_DEBUG=1`.
- [ ] **OWNER**: Upstash: confirm the integration injected `KV_REST_API_URL` and
      `KV_REST_API_TOKEN` into **both** Production and Preview. Without them the rate limits are
      per instance, not shared.
- [ ] **OWNER**: Later, only when those features ship: `REWARD_ENCRYPTION_KEY` (#26) and the
      web-push VAPID keypair.
- [ ] **AGENT**: On the Preview, the teal "PREVIEW · TEST database" badge shows. If it is red,
      Preview points at the wrong database: stop.

## 5. LIVE database: before the code (DB before code)

LIVE must have every migration the release needs **before** the new code serves traffic. The
CI `production` job applies migrations on the merge push, at the same time as Vercel builds, so
it has to be finished and green before anyone uses the new deploy.

- [ ] **OWNER**: If LIVE was originally set up by pasting SQL and this hasn't been done yet, run
      `docs/auto-migration-reconcile.sql` once in the LIVE SQL Editor (TEST too, if needed).
- [ ] **OWNER**: In the LIVE SQL Editor, check what is already applied:
      `select version from supabase_migrations.schema_migrations order by version;`
- [ ] **OWNER + AGENT**: Pre-check for 0052, which is read-only and safe on LIVE. Every count
      should be 0. If one isn't, 0052 skips that CHECK and logs a WARNING (it never rewrites
      data); send the numbers to the agent.
      ```sql
      select (select count(*) from public.fan_passes where spins_granted_total < 0) as pass_granted,
             (select count(*) from public.fans where spins_granted_total < 0)       as fan_granted,
             (select count(*) from public.fans where rl_count < 0)                  as rl_count,
             (select count(*) from public.prizes where stock < 0)                   as stock,
             (select count(*) from public.prizes where cost_cents < 0)              as cost;
      ```
- [ ] **OWNER**: Migration order on LIVE is strictly numeric:
      **0039 → 0048** (apply now if the query above shows them missing), then **0049, 0050, 0051** (RM-6, RM-3, RM-5) and
      **0052** (agency RLS fix and ledger CHECKs). Missing numbers are applied by the `production`
      job on the merge push (approve it at once if a reviewer is required). If you want them in
      **before** the merge, paste each missing `supabase/migrations/00NN_*.sql` file into the LIVE
      SQL Editor in order, then record them so CI doesn't run them again:
      `insert into supabase_migrations.schema_migrations (version) values ('00NN') on conflict do nothing;`
      (0039–0048 and 0052 are idempotent, so a re-run would be harmless. Check 0049–0051 when
      they land.)
- [ ] **OWNER**: After applying, Supabase → Database → Advisors on LIVE: no new security errors.

## 6. Optional: carry over chosen TEST data to LIVE

Only if you want some TEST accounts on LIVE. Do it **after section 5** (LIVE has the full
schema) and **before section 8** (the new code goes live).

- [ ] **OWNER**: Name the exact accounts (emails) to carry over. Nothing else moves.
- [ ] **AGENT**: Build a one-off carry-over script. It does not exist yet. The script reads those
      accounts' wheels, prizes, fans, passes, grants and campaigns from TEST and writes them to
      LIVE with fresh IDs. Logins are re-created on LIVE, and each person sets a new password
      through the reset email.
- [ ] **OWNER + AGENT**: **Dry run first.** It prints, per account, exactly what it would copy
      and writes nothing. The owner reviews the counts.
- [ ] **OWNER**: Approve, then run it for real with the LIVE keys. The owner runs this step,
      because agents never hold LIVE credentials.
- [ ] **OWNER**: Spot-check one carried account on LIVE: balances match (`fans` = SUM of passes),
      and the wheel and prizes look right.

## 7. Preview sign-off and Deployment Protection

- [ ] **OWNER**: Final Preview pass on the release branch: the change and
      [`MANUAL-CHECKLIST.md`](../e2e/MANUAL-CHECKLIST.md) §1–3 pass.
- [ ] **OWNER**: **Re-enable Vercel Deployment Protection.** It was turned OFF on 2026-10-27 for
      owner testing. Project → Settings → Deployment Protection → Vercel Authentication →
      **Standard Protection** (the previous value, `all_except_custom_domains`).
- [ ] **OWNER**: In a private window (logged out of Vercel), check that a Preview URL now asks for
      a Vercel login **and** that https://fanfunnel.vercel.app still loads publicly. If the
      production domain is blocked too, the setting is wrong: fix it before merging.

## 8. Merge (the go-live moment)

- [ ] **AGENT**: Confirm CI is green on the release PR (`verify`, `schema-drift`, `supabase`,
      `login-ui`). Report the result; never merge.
- [ ] **OWNER**: Merge the release PR into `main`. `dashboard-redesign` and other large work go to
      `main` only with your explicit sign-off.
- [ ] **OWNER**: GitHub → Actions → **Supabase migrations** → `production`: approve it if asked,
      and wait for it to go green.

## 9. Post-merge smoke test (LIVE, read-only clicks)

- [ ] **OWNER**: The Vercel Production deployment is **Ready**, and the Supabase LIVE project is
      **Healthy** (not paused).
- [ ] **OWNER**: https://fanfunnel.vercel.app shows **no** environment badge, and `?debug=1` does
      nothing.
- [ ] **OWNER**: [`MANUAL-CHECKLIST.md`](../e2e/MANUAL-CHECKLIST.md) §4: sign in, open every
      section, open a fan link for a fan you control, spin once, fulfil the win.
- [ ] **OWNER**: Password reset from `/forgot-password`: the email arrives branded, and its link
      lands on `https://fanfunnel.vercel.app`.
- [ ] **OWNER**: `/terms` and `/privacy` show the final text.
- [ ] **OWNER**: `/admin` loads for you, and a non-admin account is turned away.

## 10. Rollback

- [ ] **OWNER**: For a bad deploy, revert the merge commit on `main` (GitHub → the PR → Revert,
      then merge the revert PR). Vercel redeploys the previous build in a few minutes. For an
      instant switch, use Vercel → Deployments → the previous Production deployment →
      **Promote to Production** (Instant Rollback), then revert on `main` so the next merge
      doesn't bring the bad code back.
- [ ] **OWNER**: Migrations are **not** reverted. They are additive and the previous code runs on
      the newer schema. Never run `supabase/reset.sql` on LIVE.
- [ ] **AGENT**: Reproduce the problem on a branch Preview (TEST), fix it there, and go back
      through sections 7–9.
