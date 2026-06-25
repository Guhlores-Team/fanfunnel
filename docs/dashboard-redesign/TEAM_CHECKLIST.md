# Dashboard Redesign — Your-Side Checklist (infra, Supabase, release safety)

Things **the team** owns for the redesign — work Claude Code can't do for you (infra,
secrets, product decisions, prod migrations) — plus exactly **how we test before prod**.
Pairs with the design handoff's `README.md` + `PORTING_CHECKLIST.md`.

---

## 0. How we ship safely (no prod without testing)

**Short answer: yes, we already have staging — two layers — and prod is gated.**

### Layer 1 — Local, zero-dependency ("mock mode")
The app runs fully in-memory when **no Supabase env vars are set** — deterministic, no DB.
```bash
npm run dev        # http://localhost:3000 — live local dashboard, mock data
npm test           # unit + RLS lint + SQL-sync + theme/contrast guards
npm run build && npm run e2e   # Playwright creator+fan journeys on the prod build
npm run e2e:a11y   # axe accessibility pass
```
Use this for fast iteration on every phase. It needs nothing external.

### Layer 2 — Vercel **Preview Deployments** (the real staging URL)
We deploy via Vercel, so **every branch/PR gets its own preview URL** automatically.
That preview is the staging environment to click through and share for review **before**
anything reaches `main`. Merging to `main` is what triggers the **production** deploy.
- [ ] Confirm in Vercel project settings: **Production Branch = `main`**, and **Preview
      Deployments = enabled for all branches** (so `dashboard-redesign` + each phase PR
      gets a URL). This is the gate — we review the preview, not prod.
- [ ] (Recommended) Point previews at a **separate Supabase project** (see §1) via Vercel
      *Preview*-scoped env vars, so preview traffic never touches prod data.

### The release gate (every phase PR must pass before merge to main)
- [ ] CI green: lint, `npm test`, `npm run build`, mock E2E + a11y (already runs in `ci.yml`).
- [ ] Real-Supabase E2E green against the **test** project (`npm run e2e:supabase`; see §1).
- [ ] Manual pass of `e2e/MANUAL-CHECKLIST.md` for the touched screens.
- [ ] Visual diff vs `design_handoff_fanfunnel_dashboard/screenshots/`.
- [ ] axe/Lighthouse AA (incl. brand buttons), keyboard nav, reduced-motion.
- [ ] Reviewer signs off on the **Vercel preview URL**.
> Rule of thumb: **main = production.** Nothing lands on `main` until its preview has been
> exercised and CI is green. Keep each redesign phase a small PR so previews stay reviewable.

---

## 1. Supabase / database

The redesign mostly re-skins existing screens, but the **behavior-spec** items (handoff §
"Mocked … wire to real services") need real backing. Decide which land now vs. follow-up.

- [ ] **Dedicated test/preview Supabase project** (NOT prod) for `e2e:supabase` and preview
      deploys. Apply `supabase/schema.sql` (fresh) — it now includes the latest functions.
      Provide `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY` for that project as **CI secrets** and **Vercel Preview** vars.
- [ ] **Migration discipline:** apply any new migration to the **test project first**, run
      `e2e:supabase`, then to prod. Keep `migrations/`, `migrations_combined.sql`, and
      `schema.sql` in sync — the SQL-sync guard (unit test) fails the build otherwise.
- [ ] **Notifications + web-push** (behavior item 1): new tables likely needed —
      `notifications` and `push_subscriptions` (per-creator), with **RLS** scoping each to its
      owner. Plus a send path (Edge Function or server route). *Decision: in-app only first, or
      web-push now?*
- [ ] **Realtime / no-refresh** (item 3): if we go subscription-based for instant updates,
      **enable Supabase Realtime** on the relevant tables (overview/metrics, redemptions,
      messages). Otherwise we do optimistic updates client-side (no Supabase change).
- [ ] **Onboarding persistence** (item 5): confirm completion is stored on the **account**
      (e.g. existing `set_onboarding_dismissed` RPC / profile flag), **not** on a wheel, so it
      survives wheel delete/archive. Add a migration if it's currently wheel-scoped.
- [ ] **Spin-pack quantity** (item 2) & **stock→odds** (item 6): confirm the data model
      supports pack *quantity* (increment, not replace) and per-prize *stock* that removes a
      prize from the ticket pool at 0. Migration only if columns are missing.
- [ ] **Admin role** for the Admin section + debug-console gating (item 4): confirm the admin
      mechanism (`ADMIN_EMAILS` env and/or a role column) is set in every environment.

## 2. Env vars / secrets (browser only — no terminal)

### 2a. Migration automation — Option A (the fix for "Supabase never updated")
The workflow `.github/workflows/supabase-migrations.yml` now auto-applies `supabase/migrations/`
to the **test** project on every PR and to **production** on merge to `main`. Add these as
**GitHub repo secrets** (Settings → Secrets and variables → Actions → New repository secret):
- [ ] `SUPABASE_ACCESS_TOKEN` — Supabase dashboard → Account → Access Tokens → generate.
- [ ] `SUPABASE_TEST_PROJECT_REF` — the `xxxx` in your test project's `xxxx.supabase.co`.
- [ ] `SUPABASE_TEST_DB_PASSWORD` — test project → Settings → Database → password.
- [ ] `SUPABASE_PROD_PROJECT_REF` — production project ref.
- [ ] `SUPABASE_PROD_DB_PASSWORD` — production project database password.
- [ ] *(optional hardening)* Settings → Environments → create `production` with a **required
      reviewer** so prod migrations need one human click before they run.
> First merge to `main` puts this workflow on `main`; from then on every merge auto-migrates prod.
> Phase 1 has no migrations, so nothing runs until a later phase adds one.

### 2b. App runtime env (Vercel dashboard — Preview vs Production scope)
- [ ] **Preview** scope → **test** Supabase trio (`NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) + `ADMIN_EMAILS` +
      `FF_REQUIRE_SUPABASE=1`.
- [ ] **Production** scope → **prod** Supabase trio + same `ADMIN_EMAILS` + `FF_REQUIRE_SUPABASE=1`.
- [ ] Also add the **test** trio as GitHub secrets (same names) so the `e2e:supabase` CI job runs.
- [ ] **Web-push VAPID keypair** (only if web-push lands): public key (client) + private (server).
- [ ] Fonts need **no** keys — Geist + Bricolage Grotesque already wired via `next/font`.

## 3. Product / design decisions Claude needs from you

- [ ] **Scope of the 7 behavior-spec items** — which land in this redesign vs. follow-up PRs
      (Porting Checklist Phase 0). Biggest call: notifications/web-push and realtime.
- [ ] **Accessibility fix sign-off (Phase 1):** the `readableInk` change flips **default-pink
      button/badge text from white → dark `#160d12`** app-wide (fixes the tracked 3.52:1
      contrast defect; now ~6:1, passes AA). This is intentionally visible on the *live* app,
      not just redesigned screens. Approve, or tell us to scope it to new surfaces only.
- [ ] Confirm nav grouping/labels (Run / Build / Grow / Measure / Account) and the
      "New fan link" primary action.
- [ ] Line-icon set: confirm we author inline 1.7px-stroke SVGs (prize *content* emojis stay).

## 4. QA / release ops

- [ ] **Enforce the pre-prod gate (branch protection).** GitHub → Settings → Branches → add a
      rule for `main`: require a PR, require status checks to pass (CI + `E2E (real Supabase)` +
      `Supabase migrations`), require 1 approval. This hard-blocks anything reaching prod until
      checks are green and you've signed off the preview. Every phase PR also gets a desloppify
      pass + a `/multi-review` report before merge.
- [ ] Add the **test-Supabase secrets** so the `e2e:supabase` CI workflow stops no-opping.
- [ ] Devices/browsers for the responsive sweep (360 → 1440px) and who runs manual QA.
- [ ] Decide on a **visual-regression baseline** (the handoff screenshots) and who approves diffs.
- [ ] Rollback plan: since main = prod, a bad deploy is reverted by reverting the merge commit
      (Vercel redeploys the previous main). Keep phases independently revertable.

---

### Status
- **Phase 1 (token + accessibility foundation)** — implemented on branch `dashboard-redesign`,
  unit tests + typecheck + lint green. Awaiting your review before Phase 2.
- Everything above in §1–§4 is the team's parallel track; none of it blocks Phase 1, but the
  **test-Supabase project + Vercel preview settings** unblock proper staging for Phase 2+.
