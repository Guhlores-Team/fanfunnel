# Backlog — the single ordered work queue

Work strictly top to bottom (the autopilot does this; see `AUTOPILOT_PROMPT.md`).
Compiled 2026-10-23 from the README open items, `docs/RELEASE_CHECKLIST.md`,
`docs/archive/DESLOPPIFY.md`, `docs/archive/ROADMAP_PHASE7.md`, the redesign
porting checklist, and the 2026-06-30 infra checklist.

**Tags:** `human` = needs the owner (decision, credentials, dashboard click, real device), so the autopilot skips it and lists it in
[`OWNER_ACTIONS.md`](OWNER_ACTIONS.md) · `verify-first` = the source note may be stale, so confirm the problem
still exists before changing code (several old checklist items were fixed without
being ticked) · `after:X` = don't start until X is merged.

Status: `[ ]` open · `[~]` PR open (link it) · `[x]` merged/verified (cite PR or evidence).

## P0 — Preserve & stabilize (owner)
- [~] **OPS-1** Branch cleanup: all 21 retired branches preserved in `archive/branches-2026-10` (done); deleting them needs the owner (`scripts/delete-archived-branches.sh --apply`). `human`
- [x] **OPS-2** Both Supabase projects resumed 2026-10-23: ACTIVE_HEALTHY, both at migration 0038.
- [ ] **OPS-3** Live prod smoke test + create an admin on the **test** DB. `human`
- [ ] **OPS-4** Development env vars on Vercel point at the **prod** DB. Remove them or repoint to test. `human` approval

## P1 — Command Center redesign (do before the security audit)
Spec: `docs/design/command-center/` · parity: `docs/design/command-center/PARITY_MAP.md`.
Every current feature, edit control, animation, and bug fix must land in its
mapped spot (owner requirement). **`dashboard-redesign` is the integration branch:** each
phase is a PR *into `dashboard-redesign`* (branch off it), reviewed on its Preview before the
next. `main` and the live site stay untouched until RD-9. Re-merge `main` into
`dashboard-redesign` whenever `main` gains fixes, so they carry over.
Port the prototype's **markup**, keep the app's **logic** (the prototype's wheel/odds/balance
code would bring back fixed bugs). 78 parity rows are `needs placement`: propose a home in
the phase's PR and get owner sign-off; never drop one silently. The e2e `[role=tab]` /
`clickTab` helpers break in RD-2, so update them in that PR (that's not weakening the tests).
- [x] **RD-1** Phase 1 tokens + `readableInk()` contrast fix, refreshed onto current `main` (`dashboard-redesign` @ `911ee3e`; lint/tsc/tests/build, e2e 23/23, a11y green).
- [~] **RD-2** Phase 2 shell: sidebar + top bar in `DashboardClient.tsx`, keeping tablist keyboard a11y semantics. `after:RD-1`. In progress since 2026-10-23 on branch `redesign/rd-2-shell`.
- [ ] **RD-3** Phase 3 Today: pulse strip + "Needs you now". `after:RD-2`
- [ ] **RD-4** Phase 4 panels: Analytics, Wheels editor, Fulfilment, Fans + drawer, Campaigns, Boosts, Inbox, Settings/Admin (one PR per panel). `after:RD-3`
- [ ] **RD-5** Phase 5 empty + first-run states. `after:RD-4`
- [ ] **RD-6** Phase 6 mobile: bottom tab bar, bottom sheet, stacked editor. `after:RD-5`
- [ ] **RD-7** Phase 7 behavior wiring (spec items 1–7: notifications, pack qty increments, no-refresh, debug gate + admin, onboarding persistence, stock→odds, fan-page fairness hash clipping). Some need product calls. `after:RD-6`
- [ ] **RD-8** Phase 8 QA: axe AA, 360→1440 sweep, keyboard, visual diff vs screenshots; update `DESIGN.md` to the new system. `after:RD-7`
- [ ] **RD-9** Ship it: PR `dashboard-redesign` → `main`, with the full parity map checked on its Preview. Merge is the owner's call. `human` `after:RD-8`

## P1 — Full security audit (after the redesign lands)
- [ ] **SEC-AUDIT** Run `SECURITY_AUDIT_PROMPT.md` on Fable 5.1. Findings get added below as `SEC-xx`. `after:RD-9`
<!-- SEC-xx findings are inserted here by the audit: Critical/High first. -->

## P2 — Correctness (money/fairness paths)
- [ ] **COR-1** Referral bonus credits the fan aggregate only, not a pass (breaks `fans == SUM(passes)`). `verify-first` — RELEASE_CHECKLIST, `index.ts:992-1018`
- [ ] **COR-2** `editGrant` can desync aggregate vs sum-of-passes on partially spent grants. `verify-first`
- [ ] **COR-3** Concurrent double-spin can reuse one pre-committed server seed. `verify-first`
- [ ] **COR-4** Verify page claims "committed before reveal" for legacy/fallback spins. `verify-first`
- [ ] **COR-5** `fan_passes.spins_remaining` lacks a `>= 0` CHECK. `verify-first`
- [ ] **COR-6** Mock vs real spin `nonce` basis differ; mock floors fractional happy-hour multiplier. `verify-first`

## P2 — Security hardening already known (fold into the audit if it gets there first)
- [ ] **HARD-1** `import "server-only"` at the top of `src/lib/supabase/server.ts`.
- [ ] **HARD-2** Run `scripts/security/rls-runtime-test.mjs` in CI against the test DB (secrets already exist).
- [ ] **HARD-3** Supabase session cookie `httpOnly:false`. Evaluate `httpOnly:true` if the browser client doesn't need it. `verify-first`
- [ ] **HARD-4** Leaderboard auto-opts fans in on spin and exposes per-fan spend. Fix: explicit opt-in, drop spend. `verify-first`
- [ ] **HARD-5** Admin page reads `profiles.role` directly. Align with the `is_admin()` contract. `verify-first`
- [ ] **HARD-6** Rate limiting is in-process unless Upstash env is set. Decide whether to provision Upstash. `human`

## P3 — UX fixes
- [ ] **UX-1** Spin errors `needs_ack` / `no_prizes` fall through to a generic error in `SpinClient.tsx`.
- [ ] **UX-2** "Pause my link" (self-exclude) needs a manual refresh before SPIN disables. `verify-first`
- [ ] **UX-3** No confirm on webhook / happy-hour delete; no impact preview when editing a historical grant. `verify-first`
- [ ] **UX-4** Brand-color hex field unvalidated; validation polish (field highlight, `aria-invalid`, silent min-2-prize guard). `verify-first`
- [ ] **UX-5** Age gate requires agreeing to Terms that don't exist. Add `/terms` + `/privacy`. `human` (legal copy)

## P3 — Performance
- [ ] **PERF-1** Dashboard polls don't pause on hidden tabs; add backoff to all poll loops. `verify-first`
- [ ] **PERF-2** RecentWinsTicker: 20s poll, uncached public endpoint. `verify-first`
- [ ] **PERF-3** N+1 queries in `getCampaignStats`. `verify-first`
- [ ] **PERF-4** `/c/[slug]` forced dynamic; tighten `src/proxy.ts` matcher to auth routes. `verify-first`

## P4 — Tech debt
- [ ] **DEBT-1** Generate Supabase row types (`npm run gen:types`; needs `SUPABASE_ACCESS_TOKEN`, so run it in CI).
- [ ] **DEBT-2** Split `src/lib/data/index.ts` (~6k lines) by domain; unify its error convention. One domain per PR.
- [ ] **DEBT-3** Dedupe `clientIp` helpers (`lib/api/limit.ts` vs `lib/api/clientIp.ts`, different header precedence). Security-sensitive.
- [ ] **DEBT-4** Remove unused `src/components/fan/ReferralWidget.tsx`.
- [ ] **DEBT-5** Tick the stale boxes in `docs/RELEASE_CHECKLIST.md` with evidence (headers, 404, debug gate, avatar sniff, Shift+Enter, chat poll are already fixed).
- [ ] **DEBT-6** Upgrade `playwright` to a release that supports Ubuntu 26.04, then unpin `runs-on: ubuntu-24.04` in `ci.yml` and `e2e-supabase-ui.yml` (pinned 2026-10-23 when `ubuntu-latest` moved to 26.04). Also bump the GitHub actions still on Node 20 (`checkout@v4`, `setup-node@v4`, `upload-artifact@v4`).

## P5 — Roadmap (product calls; propose before building)
- [ ] **RM-1** Reveal theater (rarity-tiered win animation). `human` sign-off on direction
- [ ] **RM-2** Show stock to fans ("3 left"). `human`
- [ ] **RM-3** Streaks / daily check-in glow (no free spins). `human`
- [ ] **RM-4** PWA install for the fan page. `human`
- [ ] **RM-5** Win-back DM automation from the worklist. `human`
- [ ] **RM-6** Spend-awareness guardrail for fans. `human`
- [ ] **RM-7** More games: scratch tickets, bingo (same prize/fan/account system). `human`
