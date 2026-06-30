# FanFunnel — "Confirm Everything Works" Checklist

End-to-end verification that the deploy machine **and** the live system actually
work. Go top to bottom — each phase gates the next. Legend:

- `[x]` = verified this session (evidence noted)
- `[ ]` = needs you (dashboard / clicks / live creds I don't have)
- `⏭️` = covered by CI on `main` (authoritative), not re-run locally

**Reference values** (compare against these exactly):
- Prod Supabase ref: `ttlogfmogcccwiraaoae`
- Test Supabase ref: `snmcrmhgevfqggxdiomu`
- Default branch / production: `main`
- Dev branch this session: `claude/fanfunnel-handoff-dwgt2m`
- Required CI checks: `verify` (CI) · `supabase` (E2E real Supabase) · `login-ui` (E2E login UI)

---

## Phase 0 — Repo baseline  ✅ verified
- [x] `main` is at `df7a1d9` = PR #37; working tree clean.
- [x] PRs #34, #35, #36, #37 all present in `main` history.
- [x] `dashboard-redesign` exists as its own branch and is **not** merged to `main`.
- [x] Latest `main` push CI all green: `CI` + `E2E (real Supabase)` + `E2E (real Supabase — login UI)` → `completed/success` (14:57Z).

---

## Phase 1 — GitHub repository secrets  ✅ verified
Page: `https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions`

Migration pipeline (5) — all present, set ~1h ago:
- [x] `SUPABASE_ACCESS_TOKEN`
- [x] `SUPABASE_TEST_PROJECT_REF`
- [x] `SUPABASE_TEST_DB_PASSWORD`
- [x] `SUPABASE_PROD_PROJECT_REF`
- [x] `SUPABASE_PROD_DB_PASSWORD`

CI real-Supabase suite (3) — all present, set ~2w ago:
- [x] `NEXT_PUBLIC_SUPABASE_URL`
- [x] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [x] `SUPABASE_SERVICE_ROLE_KEY`

Values you must confirm by trust (GitHub never shows secret values):
- [ ] `SUPABASE_TEST_PROJECT_REF` = `snmcrmhgevfqggxdiomu`
- [ ] `SUPABASE_PROD_PROJECT_REF` = `ttlogfmogcccwiraaoae`
- [ ] CI `NEXT_PUBLIC_SUPABASE_URL` = `https://snmcrmhgevfqggxdiomu.supabase.co` (**TEST**, not prod — the suite creates/deletes ephemeral users).
- [ ] CI `SUPABASE_SERVICE_ROLE_KEY` is the **test** project's key, not prod's.
- [ ] Org-level secrets page is empty — that's fine; the workflows read repo-level (confirmed) and these are not needed at the org.

> If unsure on any value, click the pencil and re-enter it — cheaper than a prod incident.

---

## Phase 2 — Branch protection on `main`  ✅ verified (rule created this session)
Page: `https://github.com/Guhlores-Team/fanfunnel/settings/branches`

- [x] Rule targets `main`.
- [x] **Require a pull request before merging** ON (+ 1 required approval).
- [x] **Require status checks to pass** ON, with all three required: `verify`, `supabase`, `login-ui`.
- [x] **Require branches to be up to date before merging** ON.
- [x] **Do not allow bypassing the above settings** ON (applies to admins).
- [x] Allow force pushes OFF; Allow deletions OFF.
- [ ] (Optional live test) `git push origin main` directly → should be **rejected**.

> Note: "1 approval + no bypassing" means every PR (even your own) needs the
> *other* admin to approve. Fine with 2 admins; drop approvals to 0 only if it
> ever blocks solo work (status checks still gate the merge).

---

## Phase 3 — Vercel  ⚠️ partial — Git link confirmed, env+deploy pending
Vercel dashboard → FanFunnel project.

- [x] Project is linked to `Guhlores-Team/fanfunnel` ("Connected 2m ago"; org-transfer re-auth fixed). Webhook events on (`deployment_status`, `repository_dispatch`, Commit Status).
- [ ] A **Production** deployment exists, built from `main` @ `df7a1d9` (or newer), status **Ready**. (Re-linking does NOT auto-build — trigger Deployments → ⋯ → Redeploy.)
- [ ] Production env vars point at **prod** Supabase:
  - [ ] `NEXT_PUBLIC_SUPABASE_URL` = `https://ttlogfmogcccwiraaoae.supabase.co`
  - [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` = prod anon key
  - [ ] `SUPABASE_SERVICE_ROLE_KEY` = prod service-role key, scoped to **server** (NOT a `NEXT_PUBLIC_*` var)
- [ ] Preview env vars point at **test** Supabase (`snmcrmhgevfqggxdiomu`).
- [ ] Open the live production URL → page loads, no console errors, no infinite spinner.
- [ ] Trigger a fresh deploy (push a no-op or "Redeploy") and confirm it builds & goes live — proves the pipeline, not just an old artifact.

---

## Phase 4 — Supabase health (both projects)  [ ] needs you
Supabase dashboard.

Prod `ttlogfmogcccwiraaoae`:
- [ ] Project status **Active / healthy** (NOT paused/unhealthy — handoff flagged a prior risk; restart if needed).
- [ ] Migration history shows `0001`–`0035` applied (reconciled), **no pending/drift**.
- [ ] At least **2 admin** rows in `profiles` (`role='admin'`, `is_active=true`).

Test `snmcrmhgevfqggxdiomu`:
- [ ] Project status **Active / healthy**.
- [ ] Migration history shows `0001`–`0035` applied (reconciled).
- [ ] At least 2 admin rows in `profiles` (for the runtime self-promote test).

---

## Phase 5 — Local verification  ✅ verified (no-secret checks)
Run from repo root. Results captured this session:

```bash
npm ci            # deps installed
npm run lint      # [x] clean (exit 0)
npm run typecheck # [x] clean (exit 0)
npm test          # [x] 13/13 files — incl. rls.test.ts:
                  #     25 tables RLS+policy · 0 wide-open policies · 79 SECURITY DEFINER fns search_path-pinned
npm run build     # [x] succeeds
```

Browser / real-Supabase E2E — **not re-run locally** (headless-shell build 1223
missing; proxy blocks download). These are **CI-authoritative and green on `main`**:
- ⏭️ `npm run e2e` (mock creator flow + zero console errors) — CI `verify`
- ⏭️ `npm run e2e:a11y` — CI `verify`
- ⏭️ `npm run e2e:supabase` (RLS tenant isolation + SECURITY DEFINER RPCs) — CI `supabase`
- ⏭️ `npm run e2e:spin` (double-spend / spin integrity) — CI `supabase`
- ⏭️ `npm run e2e:login` (real /login → dashboard) — CI `login-ui`

Optional — run against the **test** project yourself (don't paste creds in chat):
- [ ] `export NEXT_PUBLIC_SUPABASE_URL=… ANON_KEY=… SERVICE_ROLE_KEY=… && node scripts/security/rls-runtime-test.mjs`
  → expect "A cannot self-UPDATE its profile" + cross-tenant isolation all pass.

---

## Phase 6 — Auth-contract acceptance (AGENTS.md)  ✅ verified
All four mandatory answers, with file:line evidence:

- [x] **Where authz happens** — RLS gated by `is_admin()`/`can_act_for()`
  (`supabase/schema.sql:293,300-302` for profiles; owner-or-admin on every creator
  table `:304-502`). Privileged ops go through server routes using
  `createServiceClient()` (e.g. `src/app/api/admin/account/delete/route.ts:78`),
  never a client calling a privileged RPC.
- [x] **Role source is server-controlled** — `is_admin()` = `profiles.role='admin' AND is_active`
  (`schema.sql:197-207`); `can_act_for()` reads org membership, `SECURITY DEFINER`
  (`supabase/migrations/0032_*.sql:33-37`). **Zero `user_metadata`/`app_metadata`
  reads in `src/`.**
- [x] **Service key can't reach client** — defined only in `src/lib/supabase/server.ts:90`,
  reads `SUPABASE_SERVICE_ROLE_KEY` (`:93`); **never `NEXT_PUBLIC_*`**; of the 17
  modules importing `supabase/server`, **none is `"use client"`**.
- [x] **Negative test** — static `src/lib/security/rls.test.ts` passed (profiles
  UPDATE is admin-only, `schema.sql:299-302`; no wide-open policies). Runtime
  equivalent: `scripts/security/rls-runtime-test.mjs:113-124` ("A cannot self-UPDATE
  its profile") — run it against the test project (Phase 5 optional) to tick the
  live box.

Optional hardening (not a contract violation):
- [ ] Add `import "server-only";` to the top of `src/lib/supabase/server.ts` — a
  build-time tripwire if the service module is ever pulled into a client bundle.

---

## Phase 7 — Migration pipeline dry-run  [ ] needs you (proves auto-migrate fires)
Do this **once** to trust the machine. Workflow: `.github/workflows/supabase-migrations.yml`.

- [ ] Branch off `main`; add a trivial reversible migration `supabase/migrations/0036_noop.sql`
      (e.g. a comment-only statement or a `create table if not exists _migrate_probe(...)` you drop next).
- [ ] Open a PR → the **`Supabase migrations` → test** job runs and goes green.
- [ ] Confirm in the **test** DB that history now includes `0036`.
- [ ] (If you defined a `production` Environment with a required reviewer, note the prod job will wait for approval.)
- [ ] Merge to `main` → the **production** job runs, applies `0036` to **prod**, and the Vercel prod deploy succeeds.
- [ ] Confirm in the **prod** DB that history now includes `0036`.
- [ ] Clean up the probe in a follow-up migration if you used a real object.
  → Pass = code and DB shipped together with no manual psql.

---

## Phase 8 — Live production smoke test (real clicks on the prod URL)  [ ] needs you
- [ ] Creator signs in at `/login` → reaches a working dashboard.
- [ ] **20+ prize wheel persistence:** create/save a wheel with **20+ prizes** → reload →
      all prizes persist. (This is the old mock-mode data-loss; `saveWheel` is now
      hardened, `MAX_WHEEL_PRIZES=50`, so a prod rebuild persists.)
- [ ] Fan opens a `/spin/[token]` link → age-gate appears → spin works → remaining-spin count is accurate.
- [ ] Spin a few times → counts decrement correctly; no double-spend.
- [ ] Open `/verify/[shareId]` for a spin → fairness/verify page renders.
- [ ] Expired/bad link (`/spin/badtoken`, `/c/badslug`) → currently bare Next.js 404
      (branded 404 is still an **open Tier-1** item in `RELEASE_CHECKLIST.md`).
- [ ] DevTools → Network/Sources: **no** `SUPABASE_SERVICE_ROLE_KEY` or any secret in
      the client bundle or responses.
- [ ] DevTools console: no errors across creator + fan flows.

---

## Phase 9 — Safety / rollback knowledge  [ ] confirm you know these
- [ ] You can roll back a bad prod deploy in Vercel (Deployments → previous → "Promote to Production").
- [ ] A bad migration is **forward-fix only** (write `0037_*` to correct it) — `db push` doesn't auto-revert.
- [ ] `dashboard-redesign` stays OFF `main` until explicitly approved after full preview testing (pink-ink change needs sign-off).
- [ ] Never merge to `main` without: all CI green **AND** verified on the branch's Preview URL.

---

## Open backlog (not blocking "works", but track)
From `RELEASE_CHECKLIST.md`:
- [ ] Tier-1: fan-chat poll flood (`ChatPanel.tsx`) + branded 404/error pages.
- [ ] Deferred: wheel slice-label overlap (`src/components/Wheel.tsx`).

---

### Summary of progress
Done: Phase 0 ✅ · Phase 1 ✅ · Phase 2 ✅ (rule created) · Phase 5 ✅ · Phase 6 ✅
Partial: Phase 3 ⚠️ (Git linked; env vars + a Ready prod deploy still to confirm).
Remaining: Phase 3 (finish), 4, 7, 8, 9 (+ secret-value confirmations in 1).
