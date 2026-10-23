# Phase 8 Roadmap — Autopilot · Agency · Fan-View (3 phases, back-to-back)

Built sequentially (shared files `index.ts`/`DashboardClient.tsx` rule out parallel
agents). Each wave: mock-first → migration → data fn → route → UI →
`tsc`/`eslint`/`build`/tests green → commit + push → screenshot.

## Phase 8A — Admin bootstrap + Agency console (foundation)
- [x] **Admin bootstrap** — a one-time, env-guarded "claim admin" so the owner
      becomes admin without touching the DB. Fixes `/admin` access (#4).
- [x] **Org layer** (migration 0014): `orgs`, `org_members(role)`,
      `org_member_creators`, `profiles.org_id`. `org_role` enum.
- [x] **`can_act_for(creator_id, perm)`** SECURITY DEFINER predicate; split the
      `for all` owner RLS policies per-command so seats get scoped powers.
- [x] **`org_account_stats(org_id)`** (generalize `admin_account_stats`) → org
      roll-up (revenue + fans + spins + pending across the org's creators).
- [x] **Agency dashboard** at `/admin` (or `/agency`): roster, roll-up, switch
      into a creator, manage seats + permissions.

## Phase 8B — Autopilot "Today" tab (prescriptive action feed)
- [x] **`getAutopilot()`** — generates ranked action cards from existing getters
      (`getCreatorCrm`, `getEngagementHeatmap`, `getPrizeRoi`, `getMetricsExtra`,
      `getWishlistDemand`, `getOverview`). Rank = impact × urgency × 1/effort.
- [ ] Migration 0015: `autopilot_dismissals` (card dedupe_key, snooze/done).
- [x] **12 card types** (DM whales, win-back, hot-slot drop, over-given rarity,
      restock, overdue fulfil, answer fans, out-of-spins, campaign fuel/leak,
      set costs, wishlist spike).
- [x] **"Today" tab** — ranked cards, each with one-tap execute (reuse DM
      templates, happy-hour scheduler, editor deep-link, CRM copy-link) + dismiss/snooze.

## Phase 8C — Fan-view delight (lean, wheel stays hero)
- [x] **Prize Book** — collection of won vs. unwon prizes (progressive-disclosure).
- [x] **Recent-wins ticker** — handle-only opt-in social proof.
- [x] **Real stock counts** — "3 of 5 left" only when `stock` set.
- [x] **Creator note / mini-hero** — avatar + one personal line (migration 0016:
      `profiles.avatar_url`, `creator_note`).
- [x] **PWA** — dynamic per-creator `manifest`, add-to-home nudge after a win.
- [x] **A11y pass** — `aria-live` spin result, reduced-motion guards, focus traps.

## Guardrails
- Fan view: wheel is the hero; no daily-free-spin/streak/timer mechanics; honest
  scarcity only. Agency: RLS correctness is the load-bearing risk — test per-seat.
- No prize-media hosting (compliance deferred). Payments off-platform.
