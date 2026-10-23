# DESLOPPIFY — FanFunnel cleanup backlog

Read-only audit (no code changed). Four parallel reviews: **data layer & SQL**, **API routes (~80)**, **React components & pages**, **infra/config/scripts/docs**. Items are prioritized **Critical → Medium → Nice-to-have**, each with location, why it matters, recommended change, and whether it's safe to fix now (✅) or should wait for a decision/verification (⏸).

Pick a task by its **ID** (e.g. "do D5"). IDs are stable so the list can be re-displayed after each task.

Legend: ✅ safe to fix now · ⏸ wait (needs decision / careful change / verification)

---

## 📊 Status (last updated this session)

**Done — 24 of 29 items**, delivered across 4 parallel worktree streams + a final wave, each verified green (`lint` · `tsc` · `test` · `build`):

- **Critical:** D1 ✅ (aggregate trigger) · D4 ✅ · D5 ✅ · D2 ✅ (SQL-sync guard test)
- **Medium:** M1 ✅ · M2 ✅ · M3 ✅ · M4 ✅ · M5 ✅ · M7 ✅ · M8 ✅ · M10 ✅ · M12 ✅
- **Nice:** N1 ✅ · N2 ✅ · N3 ✅ · N4 ✅ · N5 ✅ · N6 ✅ · N7 ✅ · N8 ✅ · N9 ✅ · N10 ✅ · N12 ✅

**Deferred — 5 items** (genuinely need a decision, DB access, or a dedicated isolated change):

| ID | Why deferred | What it needs |
|----|--------------|---------------|
| **D3** — shared rate-limit store | The in-memory→shared swap doesn't help without an actual store; provisioning is a product/infra decision | Pick a store (Upstash/Redis), then implement behind the existing `rateLimitOr429` interface |
| **M6** — `middleware`→`proxy` rename | Deprecated-but-working; this file gates auth — a wrong rename logs everyone out | A dedicated change with a real auth/deploy smoke-test |
| **M9** — generate Supabase row types | The durable fix is `supabase gen types` against the live DB | DB credentials + the Supabase CLI |
| **M11** — split god-modules (`index.ts` 5.5k lines) | Large mechanical refactor, low bug-value, high churn | A focused dedicated PR, not a drive-by |
| **N11** — unify data-layer error convention | Best done alongside M11's refactor | Tie to M11 |

---

## 1. CRITICAL — correctness / data-integrity / security time-bombs

### D1 — Spin balances are a dual source of truth, kept in sync by hand, non-atomically ⏸
- **Where:** `src/lib/data/index.ts` — `createPass` (`834-841` + `868-874`, `876-883` + `911-921`), `editGrant` (`1246-1252` + `1263-1269`), `grantSpins` (`1308-1316` + `1318-1324`). Plus `claim_spin` (SQL) and the referral path.
- **Why:** every balance write must update *both* `fan_passes.spins_remaining` and `fans.spins_remaining` (+ the `_granted_total` pair). Four hand-rolled sites use `value + delta` arithmetic, are not transactional, and are vulnerable to lost updates under concurrency. This is exactly the drift that caused the recent `tesy`/0024 incidents — every new code path is a fresh chance to update one table and not the other. The **mock layer already has the right abstraction** the Supabase layer lacks (`recomputeFanAggregate`, `creditSpinsToOldestPass` in `mock.ts:638,664`).
- **Recommend:** make the per-wheel pass the single source of truth and **derive `fans.spins_remaining` via an AFTER INSERT/UPDATE/DELETE trigger on `fan_passes`** (same SQL already in `credit_pass_spins`), so TS never writes the aggregate. Minimum alternative: route all four sites through one `credit_pass_spins`-style RPC.
- **Safety:** ⏸ behavior change on the hottest path — do it deliberately, and extend `referralIntegrity.test.ts` to cover grant/topup/edit first.

### D2 — `schema.sql`, `migrations_combined.sql`, and `migrations/` are three hand-maintained build artifacts that have already diverged ⏸
- **Where:** `supabase/schema.sql` (defines `claim_spin` **4×**: 211, 1128, 1735, 1827), `supabase/migrations_combined.sql` (`claim_spin` 3×), `supabase/migrations/*.sql`.
- **Why:** a single function/table change must be remembered in three places. It already failed once — `schema.sql` shipped the fan-decrementing `claim_spin` that caused the spin-count bug. The failure mode is silent: a DB built from `schema.sql` behaves differently from one built from migrations.
- **Recommend:** pick ONE source. Generate `schema.sql`/`migrations_combined.sql` from `migrations/` with a tiny concat script + a CI check that they're in sync; never hand-edit the combined files again.
- **Safety:** ✅ to add the generator + CI check. ⏸ before deleting either artifact.

### D3 — Rate limiter is in-memory only → ineffective on serverless ✅(interface) ⏸(infra)
- **Where:** `src/lib/rateLimit.ts:9-17` (`globalThis` Map), used by `spin`, `report`, `self-exclude`, `fans/ack`, `messages/fan`, `leaderboard/opt-in`, `account/reset`.
- **Why:** on Vercel/multi-instance this is per-instance and wiped on cold start, so the protections on the **prize-deciding spin endpoint** and the **destructive account/reset** endpoint don't actually hold.
- **Recommend:** back `rateLimit` with a shared store (e.g. Upstash/Redis) behind the same `rateLimitOr429` interface so no route changes.
- **Safety:** ⏸ needs an infra decision; the interface can land now.

### D4 — Public/fan mutating routes with no rate limit ✅
- **Where:** `src/app/api/wishlists/route.ts` (POST+DELETE, none), `messages/fan/route.ts:9-16` (**GET** thread-read unlimited; only POST limited), plus creator-authed-but-unlimited `messages/creator`, `leaderboard/enable`, `autopilot`, `account/onboarding`.
- **Why:** the token is the only secret on fan routes; unlimited endpoints enable enumeration/flooding and unbounded writes.
- **Recommend:** add `rateLimitOr429` keyed on `token` (mutations) / client IP (reads), matching `fans/ack`.
- **Safety:** ✅ additive. (Effectiveness depends on D3.)

### D5 — Unchecked Supabase errors on balance-critical writes & the redemption insert ✅
- **Where:** `index.ts` — `grantSpins` fan update (`1318`), both `editGrant` updates (`1246`,`1263`), `spin`'s `redemptions` insert (`691`), pity/leaderboard update (`659`), seed rotation (`614-622`), `getFanPass` seed-commit (`393`).
- **Why:** if the pass update succeeds and the fan update fails, the tables silently drift (amplifies D1). A failed **redemption insert means a won prize never enters the fulfilment queue** — lost prize, no signal.
- **Recommend:** check the `{ error }` on the second of each paired balance write and on the redemption insert; log/return on failure. (Leave genuine fire-and-forget like webhook fan-out alone.)
- **Safety:** ✅ additive error checks.

---

## 2. MEDIUM — systemic duplication & maintainability

### M1 — No shared API route wrapper; inconsistent error shapes & status codes ✅
- **Where:** ~50 routes repeat the `try { await req.json() } catch { 400 }` block + an error→status switch. Shape drift: most return `{ error }`, but `admin/account`, `admin/invite`, `redemptions`, `wheels/[id]`, `campaigns/[id]`, `grants/[id]`, `passes` spread the **whole data-layer result** (e.g. `redemptions/route.ts:25`, `passes/route.ts:34`). `"unauthorized"` maps to 401 in most routes but **403** in the admin ones. Status helpers re-declared per file (`statusForError`, `statusFor`).
- **Recommend:** one `apiHandler(handler)` wrapper + one `errorResponse(code)` mapper used everywhere; never spread raw results.
- **Safety:** ✅ incremental.

### M2 — Inconsistent / missing input validation; unbounded free-text ✅
- **Where:** `grants/[id]/route.ts:13-19` passes body straight to `editGrant` with zero type checks; `messages/fan`, `messages/creator`, `wishlists`, `autopilot`, `creator-application` accept unbounded strings. Good models to standardize toward: `redemptions` (enum whitelist), `wheels/[id]:60-69`, `webhooks` (caps url/event length).
- **Recommend:** one shared validation helper (or zod) with max-lengths on all free-text; reject with 400 instead of silently coercing.
- **Safety:** ✅ (pair with M1).

### M3 — No shared client fetch/poll hook; silent `.catch(()=>{})`; client trusts response shape ✅(primitive) ⏸(migration)
- **Where:** duplicated fetch+loading+error scaffolding ~30× (`DashboardClient.tsx:77-99` & `103-127` differ only by URL); silent catches at `BoostsPanel.tsx:138,343,587,626,654,687`, `AnalyticsPanel.tsx:57,134,138,238`, etc.; unvalidated `if(res.ok) setData(await res.json())` everywhere; optimistic deletes with no rollback (`InvitesBanner.tsx:42`, `BoostsPanel.tsx:687`).
- **Recommend:** one `useFetch`/`usePolledResource` hook owning loading/error/toast/SSR-guard/visibility-refresh/cleanup + boundary validation; roll back optimistic state on failure.
- **Safety:** ✅ land the hook now; ⏸ migrate call sites incrementally.

### M4 — No shared Modal / focus-trap primitive ✅
- **Where:** 5–6 inconsistent dialogs: `SpinClient.tsx:397-417` & `516-544` (full traps, duplicated), `FanDetailDrawer.tsx:176-188` (no Tab trap), `DashboardClient.tsx:1330` (aria only), `AdminClient.tsx:361-418` (no aria/trap/escape), `ChatPanel`/`SafetyMenu` (markup only).
- **Why:** keyboard/AT users get stranded inconsistently; the admin invite modal is the least accessible.
- **Recommend:** extract one `<Modal>`/`useFocusTrap` (focus-in, Tab cycle, Escape, restore, `aria-modal`, optional non-dismissable); convert call sites incrementally.
- **Safety:** ✅ additive primitive.

### M5 — Optimistic updates without rollback + missing double-submit guards ✅
- **Where:** `AdminClient.tsx:46-54,57-77` (mutate state then fire, no error handling), action buttons with no busy guard at `AdminClient.tsx:185-196,274,300-303`, `AgencyClient.tsx:184-189,224-230`. Good pattern exists (`FanDetailDrawer` GrantRow, `SpinClient` canSpin).
- **Recommend:** gate each mutation on an in-flight flag; confirm-then-commit or rollback+toast on `!res.ok`.
- **Safety:** ✅ localized.

### M6 — Deprecated `middleware` file convention (Next 16 → `proxy`) ⏸
- **Where:** `src/middleware.ts:4`, helper `src/lib/supabase/middleware.ts`.
- **Why:** Next 16 renamed this to `proxy.ts`/`export function proxy`; still works on 16.2.6 but deprecated. This file gates Supabase session refresh — silent breakage logs everyone out.
- **Recommend:** rename to `proxy`, check `node_modules/next/dist/docs/` first (per AGENTS.md), and functionally test auth.
- **Safety:** ⏸ not a blind rename.

### M7 — No standalone typecheck; scripts & e2e untyped/unlinted ✅
- **Where:** no `tsc --noEmit` script in `package.json`; `ci.yml` relies on `next build` for types; `eslint.config.mjs:16-17` ignores `scripts/**`; harness/seed are `.mjs` (untyped).
- **Recommend:** add `"typecheck": "tsc --noEmit"` + a CI step; `// @ts-check` on the `.mjs` harness/seed files.
- **Safety:** ✅.

### M8 — Stale migration numbers across docs ✅
- **Where:** `scripts/TESTING.md:5` ("through 0018"), `e2e/README.md:61` & `.github/workflows/e2e-supabase.yml:14` ("incl. 0023"), `RESEARCH_BIGBETS.md:5` ("0001–0012"). Migrations now go to **0024**. (Note: the DEPLOY.md "hardened claim_spin" claim is now *accurate* — don't touch that.)
- **Recommend:** replace hardcoded numbers with "latest migration" / a single source, or bump them.
- **Safety:** ✅.

### M9 — Triple-fallback select ladders + ~30 `as unknown as` casts in hot paths ⏸
- **Where:** `getFanPass` (`index.ts:328-353`) and `spin` (`549-564`) each re-implement migration-version select fallbacks + inline row casts (`518,535,566,1299,5014,…`).
- **Why:** the casts defeat type safety exactly where nested-join row shapes matter; if 0020/0022 are now universal the fallback tiers are dead, slightly-dangerous defensive code.
- **Recommend:** generate Supabase types (`supabase gen types`) and cast once; extract `selectFanPassRow()`; delete fallback tiers **after** confirming no live DB is pre-0022.
- **Safety:** ⏸ verify migration state before deleting fallbacks; helper extraction is ✅.

### M10 — `reset.sql` truncate list is implicit and incomplete ✅
- **Where:** `supabase/reset.sql:17-24` truncates only 6 tables "thanks to cascade"; schema has 25. `grants.fan_pass_id` is `on delete set null`, so **grants/revenue rows survive a "clean slate"** (orphans).
- **Recommend:** enumerate every app-data table explicitly (cascade still orders), or comment what cascades from what.
- **Safety:** ✅.

### M11 — God modules ⏸
- **Where:** `index.ts` **5544 lines / 107 exports**; `DashboardClient.tsx` **2451**; `BoostsPanel.tsx` 749; `FanDetailDrawer.tsx` 637.
- **Why:** every import pulls the whole module; merge conflicts concentrate; the giants host most of the duplication above.
- **Recommend:** split `index.ts` along its existing banner comments into `data/fans.ts`, `data/wheels.ts`, etc., re-exported from `index.ts`; extract modals/tabs out of `DashboardClient`.
- **Safety:** ⏸ mechanically safe but large/noisy — schedule deliberately.

### M12 — Duplicated utilities ✅
- **Where:** `RARITY_LABEL` map in 6 files (`SpinClient:39`, `FanDetailDrawer:10`, `WinsGallery`, `NearMissBeat`, `TemplateLibrary`, `DashboardClient:68`); `timeAgo` reimplemented (`FanDetailDrawer:19`, `WinsGallery:14`); clipboard logic ~6× (`DebugConsole:48` has the best version); `useOrigin` SSR-guard 6×; `metrics.ts` `bucketByDay`/`bucketCentsByDay` near-identical.
- **Recommend:** move `RARITY_LABEL` next to `RARITY_COLORS`; add `timeAgo` to `lib/format`; extract `useClipboard()`/`useOrigin()`; collapse the two bucket fns into one generic reducer.
- **Safety:** ✅ (metrics covered by `metrics.test.ts`).

---

## 3. NICE-TO-HAVE — polish

### N1 — Dead files & unused code ✅
- `scripts/shots.mjs`, `shots2.mjs`, `shots_p7.mjs`, `shots_p8.mjs` (one-off screenshot scripts, unreferenced, hardcoded ports; PNGs already in `docs/screenshots/`); `scripts/security/rls-runtime-test.mjs` (unreferenced; RLS covered elsewhere); `public/{file,globe,next,vercel,window}.svg` (Next scaffold, 0 refs); unused `pickPrize` import & `fifoCampaignForSpin` in `mock.ts`. → delete.

### N2 — Doc sprawl ✅
- `RESEARCH_BIGBETS.md` (449), `RESEARCH_ENHANCEMENTS.md`, `RESEARCH_FAN_VIEW.md`, `ROADMAP*.md`, `PLAN_PHASE_3-5.md` — ~120 KB of shipped-feature planning prose at root, with stale migration ranges. → move to `docs/archive/`.

### N3 — `.env.example` / DEPLOY.md missing env vars ⏸
- Code consumes `ADMIN_EMAILS` (`index.ts:3696`) and `FF_REQUIRE_SUPABASE` (`server.ts:30`); docs only list the 3 Supabase keys. An operator can never become admin. → document both. (⏸ confirm `.env.example` contents — it's permission-blocked from this audit.)

### N4 — Test runner quality ✅
- `scripts/run-tests.mjs:20-24` stops at the first failing file (masks the rest), uses `spawnSync(..., { shell: true })` (DEP0190), no parallelism. → collect failures, exit at end; drop `shell:true`.

### N5 — ESLint lets dead code accumulate ⏸
- `eslint-config-next` ships `no-unused-vars` as **warning**, so dead code never fails CI; `scripts/**` unlinted. → bump to `error` (`argsIgnorePattern:"^_"`) in a focused pass (will surface a backlog).

### N6 — Generic error copy ✅
- "Something went wrong" fallbacks at `SpinClient.tsx:135`, `LoginForm.tsx:57`, `AgencyClient.tsx:55`. SpinClient otherwise maps errors well — follow that model.

### N7 — Timer cleanup gaps ✅
- `fan/ReferralWidget.tsx:44`, `ChatPanel.tsx:145` (retry timer), copy-reset `setTimeout`s (`FanDetailDrawer.tsx:498`) not cleared on unmount → stale-state-after-unmount risk.

### N8 — ChatPanel Enter handling ✅
- `ChatPanel.tsx:263` sends on Enter with no Shift+newline and no in-flight guard (double-send). → send on `Enter && !shiftKey`, guard in-flight.

### N9 — Debug tooling on every prod page ⏸
- `layout.tsx:4-6,42-49` mounts `DebugConsole`/`CrashCanary`/`DebugErrorBoundary` globally (incl. the fan spin page). Well-gated at runtime, but anyone appending `?debug=1` gets a launcher with a **"Force a render crash"** button (`DebugConsole.tsx:256-264`). → gate mounting behind an env flag / strip in prod build.

### N10 — CI fragility & invisible no-op tests ⏸/✅
- `ci.yml:38-51` manual `next start &` + curl poll + `$STATUS` plumbing is brittle (lost exit codes, no `set -e`). Real-Supabase suites `process.exit(0)` silently when secrets are absent (`e2e/supabase-env.mjs:62-68`) — green ≠ tested. → emit a GitHub `::warning::` on skip (✅); simplify server-wait (⏸).

### N11 — Inconsistent data-layer error convention ⏸
- Functions variously return `{ error }`, `null`, or throw (`getFanPass`→null vs `grantSpins`→`{error}`). → document/standardize when those functions are next refactored.

### N12 — Minor a11y/effect gaps ✅
- `Sparkline.tsx` animated draw ignores `prefersReducedMotion()` (beats/Confetti honor it); `Wheel.tsx:282,348` suppress `exhaustive-deps` (safe today because SpinClient memoizes `onSpinEnd`, fragile if reused).

---

## Verified GOOD (checked, not slop — no action)
- **No client-side secret handling** — fan `pass.token` is an intentional capability token; no passwords/keys/session secrets in client props.
- **SSRF on webhooks is well-handled** — DNS-resolve + private-IP block at *both* create and fire time, `redirect:"manual"` (`index.ts:4392-4404,4481-4501`).
- **Ownership enforcement** is consistent in the data layer (`.eq("creator_id", user.id)`, `requireAdmin`) — routes are thin adapters by design.
- `next.config.ts` does **not** ignore build/lint errors; `tsconfig` is strict.
- DEPLOY.md/README "hardened claim_spin in schema.sql" is now accurate (prior bug fixed).
- `Wheel.tsx` hex-color parsing is robust against malformed live-editor input; `InboxPanel` realtime/poll branch is not a leak.

---

## Suggested order of attack
1. **D5** (✅ small, stops silent prize loss & drift) → **D4** (✅ add rate limits) → **D1** (⏸ the trigger; the real fix) → **D2** (generated SQL) → **D3** (shared limiter store).
2. Then the shared-primitive Mediums that kill systemic duplication in one pass: **M1** (route wrapper) + **M2** (validation), **M3** (fetch hook) + **M4** (Modal).
3. Quick ✅ wins anytime: **N1** (delete dead files), **M12** (dedupe utils), **M8** (doc numbers), **M7** (typecheck in CI), **M10** (reset.sql).
