# Implementation Plan — Phases 3→5 + Polish Bugs

Living plan for finishing the ROADMAP. Phases 1–2 shipped. Phase 3 **data layer
is complete** (all 18 functions in both `src/lib/data/index.ts` and
`src/lib/data/mock.ts`, demo-gated by `isSupabaseConfigured()`); what remained
was routes + UI. Everything is built **mock-first** so demo mode works before any
migration is run.

Conventions (match existing code):
- Route handlers: `app/api/.../route.ts`, `import { NextResponse } from "next/server"`,
  call a data-layer fn, map `{ error }` → status. Auth is enforced by RLS in the
  data layer (creator routes need no explicit check); fan routes are token-gated.
- Next 16: `params`/`searchParams` are Promises (`const { id } = await ctx.params`).
- Money is **cents**; render through `formatCents` (never raw).
- Each feature ships: data (done for P3) → route → UI → build+lint+test green → commit.

---

## Phase 3 — Engagement & virality (routes + UI)

### Routes (consume existing data fns)
- [x] `POST/GET/DELETE /api/happy-hours` (+`[id]`) → `listHappyHours/createHappyHour/deleteHappyHour`
- [x] `GET /api/share-cards/[shareId]` → `getShareCard`
- [x] `POST/DELETE /api/wishlists` → `addWishlist/removeWishlist`
- [x] `GET /api/wishlist-demand` → `getWishlistDemand`
- [x] `POST /api/leaderboard/enable`, `POST /api/leaderboard/opt-in`, `GET /api/leaderboard/[creatorId]`
- [x] `GET /api/referrals/overview`, `GET /api/referrals/stats`
- [x] `POST/GET /api/messages/fan`, `GET /api/messages/inbox`, `GET /api/messages/thread/[fanId]`, `POST /api/messages/creator`
- [x] `GET /api/public/wheel/[creatorId]` → `getPublicWheelTeaser`

### Fan UI (`SpinClient.tsx`; data already on `FanPassView`)
- [x] Happy-hour banner (when `pass.happyHour.active`) — countdown + ×N multiplier
- [x] Referral widget — copy referral link (`?ref=<code>`), bonus copy
- [x] Wishlist — add/remove prizes the fan is chasing
- [x] Share card — after a win, link to `/share/[shareId]` + Web Share / copy
- [x] Chat — spin-gated DM thread (poll), gated by `pass.chatUnlocked`

### Dashboard UI (`DashboardClient.tsx` + new panels)
- [x] New tabs: **Inbox** (chat threads + unread badge), **Boosts** (happy-hour scheduler + leaderboard toggle + wishlist demand + referral stats)
- [x] Prize-photo upload in the wheel editor (Supabase Storage `prize-photos`; demo = data URL)

### Public pages
- [x] `/share/[shareId]` — branded win card (OG image)
- [x] `/leaderboard/[creatorId]` — opt-in public leaderboard

---

## Phase 4 — Deeper analytics ✅ done

- [x] **#17 Best-time heatmap** — reads `spins` timestamps → hour×weekday grid. No migration. `getEngagementHeatmap()` → `/api/analytics/heatmap` → heatmap panel in metrics.
- [x] **#18 Prize ROI** — migration `0006`: `prizes.cost_cents`. `getPrizeRoi()` (value given vs spins/revenue) → `/api/analytics/roi` → ROI table. Cost editable in wheel editor.
- [x] **#19 Cohort retention** — reads `grants`; cohort by first-grant campaign, repeat-grant curve. `getCohortRetention()` → `/api/analytics/cohorts` → cohort grid.

All three live behind an **Analytics** dashboard tab.

---

## Phase 5 — Trust, safety & ops ✅ done

- [x] **#13 Fulfilment workflow** — migration `0007`: extend `redemptions` (`status` add `in_progress`, `notes`, `due_at`). Richer Prizes queue (status chips, due/SLA flag, note).
- [x] **#10 Bulk CSV import** — `POST /api/fans/import` (parse rows → create fans + optional grant/campaign). Dashboard upload + preview. No migration.
- [x] **#23 Provably-fair** — migration `0008`: `spins.server_seed_hash`, `server_seed`, `nonce`. Commit hashed seed pre-spin, reveal post-spin. `/verify/[shareId]` page recomputes the outcome.
- [x] **#24 Webhooks + age-gate/ToS** — migration `0009`: `webhooks`, `fans.acked_at`. Pending-prize webhook fire; age-gate + ToS acceptance gate on the spin page before first spin.

---

## Inferred "two need your call" decisions (from the lost chat)

The two items the previous session flagged as needing a product decision were
most likely:

1. **Conversion-funnel definition (bug 6).** Switching to per-fan
   (fans → fans-who-spun → fans-with-fulfilled-prize) changes what the headline
   number *means*. Default chosen: **per-fan funnel**, matching the one-permanent-link
   model. (Reversible; documented in code.)
2. **Leaderboard identity (#6).** Ranking fans publicly needs a display handle and
   an opt-in. Default chosen: **opt-in only, handle-only** (no real names), creator
   toggles the board on; fans opt in from the spin page. Privacy-safe by default.

If either default is wrong, they're isolated and easy to flip.

---

## Polish bugs (fold into integration pass, after phases land)

- [x] **5. Revenue sparkline raw cents** — `Sparkline.tsx` total/peak labels bypass `formatCents`. Wrap them.
- [x] **6. Conversion 4/6 counts links** — switch `ConversionFunnel` to per-fan (created → spun → fulfilled).
- [x] **3. QR popover overflow** — `QrButton.tsx` renders off-screen left on mobile → centered modal/sheet on small screens.
- [x] **2. Mobile horizontal overflow** — track the element wider than the viewport (nowrap stat row / wheel canvas) and clamp.

---

## Execution order
P3 routes → P3 fan UI → P3 dashboard UI → P3 public pages → verify+commit →
P4 → P5 → polish bugs. Commit + push after each green wave (ephemeral env).
