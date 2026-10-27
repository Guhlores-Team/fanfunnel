# Deploy FanFunnel (Vercel + Supabase)

Goal: live site that auto-deploys from `main`, backed by your Supabase project.
Three connections: **GitHub→Vercel**, **Vercel→Supabase env vars**, **schema in Supabase**.

> Anything in a browser dashboard (Vercel / Supabase / GitHub settings) is **yours
> to click** — it can't be automated from the repo. The repo side (code, PR,
> combined SQL) is done.

---

## STEP 1 — Supabase: load the schema (two pastes, in order)

1. Go to **supabase.com → your project** (the one you've been running SQL on).
2. Left sidebar → **SQL Editor** → **New query**.
3. **Brand-new project (recommended):** run `supabase/schema.sql` — the complete, current schema (base tables + RLS + hardened `claim_spin` + every migration folded in). It is idempotent, and running `supabase/migrations_combined.sql` on top is a harmless no-op. CI (`npm test` and the `schema-drift` job) proves the three SQL files build the same database.
4. **Existing project that pre-dates these migrations:** new query → open **`supabase/migrations_combined.sql`**, paste it, **Run** to bring an older DB up to date. Idempotent (safe to re-run).
5. (Optional) Authentication → Providers → Email → turn **OFF "Confirm email"** so you can sign in instantly while testing.

**Get your 3 keys:** Supabase → **Project Settings → API**:
- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
- **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **service_role** key (secret) → `SUPABASE_SERVICE_ROLE_KEY`

---

## STEP 2 — Vercel: connect the repo (skip if already connected)

1. **vercel.com → Add New… → Project**.
2. **Import** `SteveGuhlore/fanfunnel`. Framework auto-detects **Next.js** — leave build/output defaults.
3. Don't deploy yet — set env vars first (Step 3).

If a fanfunnel project **already exists** in Vercel, open it instead and go to Step 3.

---

## STEP 3 — Vercel: add the 3 environment variables

Project → **Settings → Environment Variables**. Add each for **Production, Preview, AND Development**:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | your Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (keep secret) |

> If they're already there from before, confirm all three exist and are spelled exactly.

### Optional environment variables

These aren't required to boot, but you'll want them for a real deployment:

| Name | Value | What it does |
|---|---|---|
| `ADMIN_EMAILS` | comma-separated email allowlist | Gates the one-time admin-claim bootstrap (`claimAdmin` in `src/lib/data/index.ts`). A signed-in user whose email is on this list can promote themselves to admin via the in-app "claim admin" action — no SQL needed. **If it's unset, no one can self-promote** (you'd fall back to the manual `update profiles set role='admin'` in STEP 5). |
| `FF_REQUIRE_SUPABASE` | `1` | Self-hosted opt-in to **fail closed** instead of mock mode (`src/lib/supabase/server.ts`). On Vercel, `VERCEL_ENV=production` already forces real-Supabase mode; set this where `VERCEL_ENV` isn't present (e.g. a non-Vercel host) so a missing Supabase key throws instead of silently serving in-memory demo data. |

---

## STEP 4 — Merge to main (gets you the auto-deploy)

Easiest: merge the open Pull Request (titled "Phases 3–5 + polish + realtime chat").
- Open the PR on GitHub → **Merge pull request**.
- Vercel auto-builds `main` and gives you the **Production URL**.

(Before merging, the PR also produces a **Preview URL** — test on that first if you want, no risk to production.)

---

## STEP 5 — First run on the live site

1. Visit the Vercel Production URL → **/login** → sign up (this creates your creator account).
2. To make yourself an **admin**: Supabase → Table Editor → `profiles` → your row → set `role` = `admin`.
3. Build a wheel in **/dashboard**, mint a fan link, open `/spin/<token>` on your phone.

---

## Auto-deploy from here on
Once Steps 2–4 are done, **every push/merge to `main` auto-deploys**. Feature
branches get their own preview URLs automatically. That's the "deploy straight
from Vercel" flow you wanted.

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
- **Migrations are idempotent** — re-running `migrations_combined.sql` is safe.
- **Realtime chat** needs nothing extra: Supabase Realtime is on by default for
  the `messages` table once the schema is loaded.
- **Browser push notifications** prompt the creator for permission in the Inbox
  ("🔔 Enable alerts"); full closed-tab web-push is a Phase 6 item.
