# Deploy FanFunnel (Vercel + Supabase)

Goal: live site that auto-deploys from `main`, backed by your Supabase project.
Three connections: **GitHub→Vercel**, **Vercel→Supabase env vars**, **schema in Supabase**.

> Anything in a browser dashboard (Vercel / Supabase / GitHub settings) is **yours
> to click** — it can't be automated from the repo. The repo side (code, PR,
> combined SQL) is done.

---

## STEP 1 — Supabase: load the schema (one paste)

1. Go to **supabase.com → your project** (the one you've been running SQL on).
2. Left sidebar → **SQL Editor** → **New query**.
3. **Brand-new project (recommended):** open `supabase/schema.sql`, paste it, **Run**. This one file is now **complete** — base tables + every migration (self-exclusion, age-gate ack, provably-fair seeds, webhooks, chat, reports, in-progress status) and the hardened `claim_spin`. Nothing else to run.
4. **Existing project that pre-dates these migrations:** new query → open **`supabase/migrations_combined.sql`**, paste it, **Run** to bring an older DB up to date. Idempotent (safe to re-run). Not needed if you ran `schema.sql` in step 3.
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
- **Browser push notifications** prompt the creator for permission in the Inbox
  ("🔔 Enable alerts"); full closed-tab web-push is a Phase 6 item.
