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
| `VAPID_PUBLIC_KEY` | public half of a VAPID key pair | **Web push** (closed-tab notifications for creators). Served to the browser at runtime by `GET /api/push/config`. `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is accepted too. See **Web push setup** below. |
| `VAPID_PRIVATE_KEY` | private half (mark **Sensitive**) | Signs every push. Server-only: read only by `src/lib/push/keys.ts`. **Never** a `NEXT_PUBLIC_*` variable. |
| `VAPID_SUBJECT` | `mailto:you@yourdomain` | Contact the push services (Google, Mozilla, Apple) can reach about your sends. |

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

## Notes
- **Migrations are idempotent** — re-running `migrations_combined.sql` is safe.
- **Realtime chat** needs nothing extra: Supabase Realtime is on by default for
  the `messages` table once the schema is loaded.
- **Web push** (closed-tab notifications for creators) is off until the three
  `VAPID_*` variables are set; see below. The Inbox's "Get alerts on this
  device" opens the same opt-in in Settings › Notifications.

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
