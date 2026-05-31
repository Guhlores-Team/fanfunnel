# FanFunnel Roadmap

Status of the approved feature set from research + sessions. **Nothing here is
built until you approve the phase.** `#NN` = research item number.

Legend: **Effort** S (hours) / M (a day-ish) / L (multi-day). **Migration?** =
needs a Supabase schema change you'd run.

---

## ✅ Already shipped (for reference)
Redesign (landing/fan/dashboard), brand-adaptive wheel, editor upgrades, metrics
(trend + funnel + what's-landing + rarity), per-fan drawer, **#15 revenue
tracking**, many-to-many **campaigns** (grants ledger, FIFO attribution,
per-fan/per-campaign breakdown), 1-link model, fan search, delete fan, toasts,
spin rate-limit.

Cut: **#1** daily free spin (not a casino — monetize instead).

---

## Phase 1 — Quick wins (low risk, fast, mostly no migration)
| # | Feature | Design sketch | Migration? | Skills | Effort |
|---|---|---|---|---|---|
| #2 | **Near-miss animation** | When a legendary lands one slice away, a slow-down + glow + "So close!" beat on the fan page. Pure client motion. | No | motion-foundations, motion-patterns | S |
| #21 | **QR codes** per fan link + per campaign | Render a QR for any `/spin/<token>` (and a campaign share link) with a download/copy. | No (client lib or tiny SVG QR) | frontend-design | S |
| #12 | **Saved DM templates** | Creator saves message templates with a `{link}` token; one-tap "Copy DM" fills the fan's link. | Small: `dm_templates` table (or per-creator JSON) | postgres-patterns, react-patterns | S |
| #14 | **Per-fan notes + tags** | Notes (the `fans.notes` column already exists) + tags (VIP/whale/new) shown on the card + drawer; filter by tag. | Small: `fans.tags text[]` | postgres-patterns | S–M |

## Phase 2 — Monetization core
| # | Feature | Design sketch | Migration? | Skills | Effort |
|---|---|---|---|---|---|
| #8 | **Multiple wheels** per creator | Build/duplicate/archive several wheels; pick the active one. Foundation for #9 + #11. | Yes: drop the one-wheel assumption (`wheels.is_active`, `archived_at`) | postgres-patterns, react-patterns | M–L |
| #16 | **Per-campaign spin packs** | Each campaign defines pack presets ("5 spins = $20"). Granting under a campaign = tap a preset (auto-fills spins + $). Feeds revenue. | Yes: `campaign_packs` (campaign_id, spins, amount_cents, label) | api-design, react-patterns | M |
| #4 | **Bulk-purchase bonuses** | Bigger packs escalate rare odds (Nth spin boosted) or "buy 10 → 1 guaranteed rare." Lives in the wheel engine + grant. | Maybe: pack bonus config | (engine work) react-patterns | M |
| #9 | **Scheduled wheels** | Per wheel `active_from`/`active_until`; fan page serves whichever window contains now. **Independent of campaign pricing** (swaps prizes/odds, not packs). | Yes: `wheels.active_from/until` | postgres-patterns | M (needs #8) |
| #11 | **Templates / prize library** | Reusable prize sets + wheel templates to spin up seasonal wheels fast. | Yes: `prize_templates` | react-patterns | M (needs #8) |

## Phase 3 — Engagement & virality
| # | Feature | Design sketch | Migration? | Skills | Effort |
|---|---|---|---|---|---|
| #3 | **Win share-card** | Auto-generate a branded image of a win; share to IG/X/FB (Web Share API + downloadable PNG, dynamic OG image). Free reach. | No (uses real prize photo if #22 done) | canvas-design, frontend-design | M |
| #22 | **Prize photos** (modal + teaser) | Upload a real photo per prize; shown in the win modal + public teaser. Wheel keeps clean icons. | Yes: Supabase Storage + `prizes.image_url` | postgres-patterns, frontend-design | M |
| #5 | **Wishlist** | Fan marks a prize they're chasing; creator sees aggregate demand. | Yes: `wishlists` | postgres-patterns | S–M |
| #6 | **Leaderboard** (opt-in) | Per-creator toggle; ranks fans (handles only) by spins/spend/rare wins. Drives competitive tipping. | Small: `profiles.leaderboard_on` | react-patterns | M |
| #7 | **Happy hour** | Creator schedules a window; rare weights ×N; fans see a "boosted now" banner. **Fair to all fans, time-boxed, net-positive for creator.** | Yes: `boost_windows` (wheel_id, multiplier, start/end) | postgres-patterns, motion-ui | M |
| #20 | **Referral spins** | Fan shares a referral code; when a referred *new* fan first gets a paid grant, both get a bonus. Cap ~3/fan, no self-referral. | Yes: `referrals` + code | postgres-patterns, api-design | M |
| 💬 | **Spin-gated chat** | Fan with ≥1 spin can DM the creator; 0 spins → "Top up from [Creator] to message." Creator replies in the fan drawer; unread badge; realtime. | Yes: `messages` + Supabase Realtime | postgres-patterns, react-patterns | L |

## Phase 4 — Deeper analytics
| # | Feature | Design sketch | Migration? | Skills | Effort |
|---|---|---|---|---|---|
| #17 | **Best-time heatmap** | Engagement by hour/day from spin timestamps → when to post/grant. | No (reads `spins`) | react-patterns | M |
| #18 | **Prize ROI** | Optional cost per prize → "value given vs spins/revenue it drove." | Yes: `prizes.cost_cents` | postgres-patterns | M |
| #19 | **Cohort retention** | Do campaign-A fans come back more than B? Cohort by first-grant campaign, repeat-grant curve. | No (reads `grants`) | react-patterns | M |

## Phase 5 — Trust, safety & ops
| # | Feature | Design sketch | Migration? | Skills | Effort |
|---|---|---|---|---|---|
| #13 | **Fulfilment workflow** | Redemption gets in-progress status, notes, due date / SLA flag; richer Prizes queue. | Yes: extend `redemptions` | postgres-patterns | M |
| #10 | **Bulk CSV import** | Import dozens of fans (+ optional grants/campaign) at once. | No (uses existing tables) | api-design | M |
| #23 | **Provably-fair** | Server commits a hashed seed pre-spin, reveals post-spin; a verify page lets fans confirm the result wasn't swapped. | Yes: store seed/commit on `spins` | (engine) postgres-patterns | M–L |
| #24 | **Webhooks + email digest + age-gate/ToS** | Pending-prize email/Zapier; fan age-gate + ToS acceptance gate on the spin page. | Yes: `webhooks`, `fan ack` | api-design, mcp-builder | M |

> **Note:** #22 **Prize photos** was built then **cut** (May 2026) — prizes are
> label + optional emoji, with a per-rarity gradient medallion in the win modal /
> share card. The `prizes.image_url` column + share `imageUrl` field remain in
> the schema/types as dormant (harmless) in case we revisit richer prize media.

## Phase 6 — Conversion deepeners (RESEARCH FIRST, then build)
**Gate:** each item gets brainstorm → spec → prototype → A/B on a test creator
before going live. These touch payout economics and/or delivery security, so they
are NOT auto-shipped with the earlier phases.

| # | Feature | Design sketch | Migration? | Skills | Effort |
|---|---|---|---|---|---|
| #25 | **Wishlist focus-pack / chase pity** (gacha) | A fan can pay a *premium* pack that boosts the odds of a prize they wishlisted. Two models to test: **(a) Focus pack** — temporary ×N weight on the target prize for the next N spins (reuses `applyRareBoost` aimed at one prize id); **(b) Chase pity** — a hard "guaranteed within N spins" counter for the target (reuses the pity engine, scoped to a prize). | Yes: `focus_packs` / per-fan `chase_target` + counter on `fans` | (engine) postgres-patterns, react-patterns | M–L |
| #26 | **Instant-delivery / auto-fulfil prizes** | A prize can carry a pre-loaded **digital reward** (a link, unlock code, or short text). On win it's revealed to the fan immediately AND the redemption is auto-marked `fulfilled` (no creator step). Mixed wheels (some instant, some manual) supported. | Yes: `prizes.reward_kind` + `reward_payload` (encrypted at rest); spin auto-creates a fulfilled redemption | postgres-patterns, api-design | M |
| 🔔 | **Web push (closed-tab notifications)** | True OS push when the dashboard/app is closed — new message, prize pending, low stock. Needs a service worker + VAPID keys + a push-subscription table + a sender (Supabase Edge Function or cron). Builds on the in-app + Notification-API layer from the chat work. | Yes: `push_subscriptions`; VAPID env keys | mcp-builder, deployment-patterns | L |

### #25 design risks to resolve before build
- **Stocked/limited prizes:** a guaranteed/boosted chase can oversell — needs a
  per-prize "boostable?" flag + a stock guard.
- **Payout economics:** boosting a high-value prize changes the EV the creator
  pays out — needs a min-price/guardrail and a clear "this is what you'll owe"
  preview for the creator.
- **Fairness optics:** must stay provably-fair (#23) — the boost has to be part
  of the committed seed derivation, not a post-hoc swap.
- **Recommendation:** ship **(a) Focus pack** first (soft odds, no hard promise
  to honor); treat **(b) Chase pity** as a follow-up once economics are proven.

### #26 design risks to resolve before build
- **Reward security:** codes/links are sensitive — encrypt `reward_payload` at
  rest, never expose it before a win, and one-time-reveal per spin.
- **Inventory:** a code can only be handed out once — either a pool of codes per
  prize (decrement on win) or "same link for all." Decide per prize.
- **Workflow:** auto-fulfilled redemptions still appear in the queue (status
  `fulfilled`, flagged "auto") so the creator has an audit trail.

---

## Execution method
Per phase: **brainstorm → writing-plans (plan doc) → subagent-driven-development**
(fresh implementer per task + spec/quality review), build+lint+tests green,
deploy, screenshot-verify on mobile. Migrations are generated as
`supabase/migrations/NNNN_*.sql` for you to run; everything is built mock-first
so demo mode works before the migration.

## Suggested order
1 (quick wins) → 2 (monetization) → 3 (engagement/chat) → 4 (analytics) → 5 (trust/ops).
Within each phase, foundational items first (#8 before #9/#11; #22 before #3).
