# FanFunnel — "Confirm Everything Works" Checklist (in depth)

Go top to bottom. Each phase has **steps**, the **exact action**, and a **pass
criterion**. Do every checkbox. Legend:

- `[x]` done/verified · `[ ]` to do · `⏭️` covered by CI on `main`

**Reference values**
- Prod Supabase ref: `ttlogfmogcccwiraaoae`
- Test Supabase ref: `snmcrmhgevfqggxdiomu`
- Production branch: `main` · dev branch: `claude/fanfunnel-handoff-dwgt2m`
- Required CI checks: `verify` · `supabase` · `login-ui`

**Automated vs one-time:** Phases 5, 6, and the migration *apply* (7) + Vercel deploy
run automatically on every push/PR via CI + workflows — hands-off once wired. Phases
1–4 are **one-time setup confirmations** (re-checked here because the org transfer can
break the wiring). Phase 8 is the only inherently-manual judgment check (and its core
flows are already covered by CI's real-Supabase E2E).

**Status at a glance**
| Phase | What | Status |
|---|---|---|
| 0 | Repo baseline | ✅ done |
| 1 | GitHub secrets | ✅ done |
| 2 | Branch protection | ✅ config (live-push test pending) |
| 3 | Vercel | ✅ config (deploy/URL test pending) |
| 4 | Supabase health | ✅ done |
| 5 | Local verification | ✅ done (E2E ⏭️ CI) |
| 6 | Auth contract | ✅ done |
| 7 | Migration dry-run | ✅ proven (test + prod, PR #38) |
| 8 | Live smoke test | ⬜ runtime batch |
| 9 | Safety/rollback | ⬜ knowledge check |

---

## Phase 0 — Repo baseline ✅
**How to re-verify:** `git fetch origin main && git log --oneline -1 origin/main`
- [x] `origin/main` tip = `df7a1d9` (PR #37)
- [x] PRs #34–#37 all merged into `main`
- [x] `dashboard-redesign` exists but is **not** merged to `main`
- [x] Latest `main` CI green: `CI` + `E2E (real Supabase)` + `login-ui`

---

## Phase 1 — GitHub repository secrets ✅
**Where:** `https://github.com/Guhlores-Team/fanfunnel/settings/secrets/actions`

Presence (8 repo secrets):
- [x] `SUPABASE_ACCESS_TOKEN`
- [x] `SUPABASE_TEST_PROJECT_REF` = `snmcrmhgevfqggxdiomu`
- [x] `SUPABASE_TEST_DB_PASSWORD`
- [x] `SUPABASE_PROD_PROJECT_REF` = `ttlogfmogcccwiraaoae`
- [x] `SUPABASE_PROD_DB_PASSWORD`
- [x] `NEXT_PUBLIC_SUPABASE_URL` (CI → **test** project)
- [x] `NEXT_PUBLIC_SUPABASE_ANON_KEY` (CI → test)
- [x] `SUPABASE_SERVICE_ROLE_KEY` (CI → test key)
- [x] Org-level secrets page empty — fine; workflows read repo-level.

---

## Phase 2 — Branch protection on `main` ✅
**Where:** `https://github.com/Guhlores-Team/fanfunnel/settings/branches`
- [x] Rule targets `main`
- [x] Require a pull request before merging
- [x] Required approvals = **0** (per user — solo self-merge OK; CI still gates)
- [x] Require status checks to pass — all three: `verify`, `supabase`, `login-ui`
- [x] Require branches up to date before merging
- [x] Do not allow bypassing the above settings
- [x] Allow force pushes OFF · Allow deletions OFF
- [ ] **Live test (later):** direct `git push origin main` → must be **rejected**

---

## Phase 3 — Vercel ✅ done
**Where:** Vercel dashboard → FanFunnel project.
- [x] Git connection = `Guhlores-Team/fanfunnel` ("Connected"), webhook events on
- [x] **Production** env vars → prod Supabase (`ttlogfmogcccwiraaoae`):
  - [x] `NEXT_PUBLIC_SUPABASE_URL` = `https://ttlogfmogcccwiraaoae.supabase.co`
  - [x] `NEXT_PUBLIC_SUPABASE_ANON_KEY` = prod anon
  - [x] `SUPABASE_SERVICE_ROLE_KEY` = prod key, **server-scoped, NOT `NEXT_PUBLIC_`**
- [x] **Preview** env vars → test Supabase (`snmcrmhgevfqggxdiomu`)
- [x] Production deploy `425c255` from `main` → **Ready** (triggered by PR #38 merge)
- [x] Live URL opens (Preview deploys also Ready — confirmed on handoff branch)

---

## Phase 4 — Supabase health ⚠️ near-done
### 4a — Project awake? — ✅ both (proven: SQL ran; a paused project can't)
- [x] PROD active · [x] TEST active

### 4b — Migration history reconciled — ✅ both
- [x] PROD: applied=35, 0001→0035
- [x] TEST: applied=35, 0001→0035

### 4c — Schema present + RLS on
- [x] TEST: 25 tables, all `rowsecurity = true` (no holes)
- [x] PROD: `unprotected = 0` (re-run confirmed every public table has RLS)

### 4d — Admins
- [x] PROD: has admins (≥2 — confirm count)
- [ ] TEST: **0 admin rows** — `where role='admin'` returned nothing.
  Not a pipeline blocker (login-ui CI uses a creator, not an admin), but seed one
  if you want to exercise admin paths on the test preview. Decide & note.

---

## Phase 5 — Local verification ✅ (no-secret) / ⏭️ E2E in CI
Captured this session:
- [x] `npm run lint` clean
- [x] `npm run typecheck` clean
- [x] `npm test` → 13/13 files; RLS lint: 25 tables RLS, 0 wide-open policies, 79 SECURITY DEFINER fns search_path-pinned
- [x] `npm run build` succeeds
- [⏭️] `e2e` / `e2e:a11y` / `e2e:supabase` / `e2e:spin` / `e2e:login` green in CI on `main`
- [ ] (optional, against TEST) `node scripts/security/rls-runtime-test.mjs`

---

## Phase 6 — Auth-contract acceptance ✅ (AGENTS.md, 4 answers w/ evidence)
- [x] **Authz where:** RLS gated by `is_admin()`/`can_act_for()` (`schema.sql:293,300-302`; owner-or-admin `:304-502`); privileged ops via server routes (`api/admin/account/delete/route.ts:78`)
- [x] **Role source server-controlled:** `is_admin()` = `profiles.role+is_active` (`schema.sql:197-207`); zero `user_metadata`/`app_metadata` in `src/`
- [x] **Service key contained:** only `src/lib/supabase/server.ts:90`; never `NEXT_PUBLIC`; no `"use client"` importer
- [x] **Negative test:** static `rls.test.ts` passed (profiles UPDATE admin-only)
- [ ] (optional) runtime self-promote test `rls-runtime-test.mjs:113-124` against TEST
- [ ] (optional hardening) add `import "server-only";` atop `server.ts`

---

## Phase 7 — Migration pipeline dry-run ✅ PROVEN end-to-end
Workflow: `.github/workflows/supabase-migrations.yml`. PR #38 (squash `425c255`).

- [x] Probe `0036_pipeline_probe.sql` (comment-only; passes RLS + sqlSync guards)
- [x] PR #38 `Supabase migrations` **test** job ✅ → applied `0036` to TEST
      (also proved rotated `SUPABASE_ACCESS_TOKEN` + `SUPABASE_TEST_DB_PASSWORD`)
- [x] Merged to `main` → **production** job ✅ ("Apply migrations to PRODUCTION")
      → applied `0036` to PROD (proved rotated `SUPABASE_PROD_DB_PASSWORD`)
- [ ] Optional confirm: PROD SQL editor `select max(version) …` = `0036`
→ Pipeline works: one merge ships code + DB together, no manual psql. The probe
  is a harmless schema comment — no cleanup needed.

> Note: `import "server-only"` hardening (Phase 6 optional) was SKIPPED — the
> `server-only` package isn't installed; adding it is a new dependency. Contract
> already passes without it.

---

## Phase 8 — Live production smoke test ⬜ (real clicks on prod URL)
- [ ] Creator signs in at `/login` → working dashboard
- [ ] Create/save a wheel with **20+ prizes** → reload → all prizes persist
      (old mock-mode loss; `saveWheel` hardened, `MAX_WHEEL_PRIZES=50`)
- [ ] Fan `/spin/[token]` → age-gate → spin works → remaining count accurate
- [ ] Spin repeatedly → decrements correctly, no double-spend
- [ ] `/verify/[shareId]` → fairness page renders
- [ ] Bad link (`/spin/badtoken`) → 404 (branded 404 still open in RELEASE_CHECKLIST.md)
- [ ] DevTools: no `SUPABASE_SERVICE_ROLE_KEY`/secret in bundle or network; no console errors

---

## Phase 9 — Safety / rollback knowledge ⬜
- [ ] Vercel rollback: Deployments → pick previous good → "Promote to Production"
- [ ] Bad migration is **forward-fix only** — write `0037_*` to correct, no auto-revert
- [ ] `dashboard-redesign` stays OFF `main` until explicitly approved post-preview
- [ ] Never merge to `main` without: all CI green **AND** verified on the Preview URL

---

## Open backlog (track, not blocking "works")
From `RELEASE_CHECKLIST.md`:
- [ ] Tier-1: fan-chat poll flood (`ChatPanel.tsx`) + branded 404/error pages
- [ ] Deferred: wheel slice-label overlap (`src/components/Wheel.tsx`)

---

### Progress
Config-complete: 0, 1, 2, 3, 5, 6. Next config: **Phase 4** (then Phase 7 prep).
Runtime batch (later): Phase 2 live-push · Phase 3 deploy/URL · Phase 7 PR→merge · Phase 8.
