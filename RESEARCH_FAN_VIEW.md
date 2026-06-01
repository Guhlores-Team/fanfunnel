# FanFunnel — Fan View Research & Build Plan

**Author:** Senior mobile-product design research · **Date:** 2026-06-01
**Scope:** The FAN-FACING experience only — `src/app/spin/[token]/page.tsx` → `src/components/SpinClient.tsx` and `src/components/fan/*`. Planning only, no app code.

## North star

> The wheel is the hero. Every fan page should feel like **their creator's** branded room, not a SaaS dashboard. Fans never authenticate, never have settings, and see as little server/admin surface as possible. We add *delight, ceremony, and honest reasons to return* — never gambling patterns, fake scarcity, or loss-framing. Every spin wins; that guarantee is what keeps this out of gambling-law territory (`engine.ts` enforces it).

**Ethics rails baked into every idea below:** every-spin-wins, no daily-free-spin slot-machine loops, no countdown-to-lose timers, no fabricated "only 2 left" unless `prize.stock` is really set, no manipulative "you'll lose your streak" framing. Nudges are *aspirational* ("chase it", "climb the board"), never *punitive*.

---

## What the fan already has (baseline — not re-proposed)

Wheel + SPIN, spins-left counter, mute, per-rarity win modal (medallion + confetti + share → `/share/[shareId]`), near-miss "So close!" beat, pity celebration, win-history pills, wishlist, referral widget, spin-gated Realtime chat (auto intro/outro), happy-hour banner, age/ToS gate, Safety menu (report / pause), `TopUpMoment` (teases rarest unwon prize + tip link), embedded `FanLeaderboard` (top 5 inline). Haptics + procedural Web Audio exist (`sound.ts`). No PWA manifest / service worker exists yet (confirmed — gap).

---

## 1. Anticipation & reveal

The single biggest lever. Right now the flow is: tap → spin → modal. The *build-up* and *rarity ceremony* are thin. Make winning feel earned even though it's guaranteed.

| # | What (one line) | Why it drives spend/return | Effort | Data/migration | Priority | Tasteful note |
|---|---|---|---|---|---|---|
| 1.1 | **Pre-spin charge-up:** press-and-hold SPIN ramps a rising tone + escalating haptic, releases into the spin | Tactile commitment makes each spin feel bigger; raises perceived value of a top-up | S | none | **P0** | Pure feel, no outcome change; honor `prefers-reduced-motion` |
| 1.2 | **Rarity-tiered reveal ceremony:** decelerate slower + screen flash/shake scaled to rarity *before* the modal; legendary gets a held beat ("…") | The "almost there" deceleration is the dopamine peak; tiering makes rare drops feel rare | M | server already returns rarity/index | **P0** | Tension comes from *anticipation of a guaranteed win*, never fear of loss |
| 1.3 | **Richer win soundscape:** layer the existing `playWin` arpeggio with a rarity-scaled pad/sub; distinct legendary stinger | Audio is the cheapest "premium" signal; sub-bass on legendary is memorable | S | extend `sound.ts` only | P1 | Respects existing mute toggle |
| 1.4 | **Slice spotlight on stop:** the winning slice pulses/lifts on the wheel before the modal opens, tying outcome to the physical wheel | Connects reveal to the object they spun; less "modal popped out of nowhere" | S | `result.index` already known | P1 | — |
| 1.5 | **Combo/streak *feel* (visual only):** consecutive rare-or-better wins stack a brief "On fire 🔥 ×2" flourish | Makes a hot run feel special, encouraging "one more" | S | client-derivable from `history` | P1 | No mechanical reward, no "lose your streak" threat — purely celebratory |
| 1.6 | **Near-miss honesty polish:** keep `NearMissBeat` but cap frequency and never imply "you almost lost X" | The existing beat is ethical; just guard against over-firing | S | add a client cooldown | P2 | Frame as "the wheel teased you", not "you missed" |

---

## 2. Progress & collection

Turn scattered win pills into a **prize book** — a collection the fan wants to *complete*. This is the strongest non-gambling retention mechanic available (set-completion, not chance).

| # | What | Why | Effort | Data/migration | Priority | Tasteful note |
|---|---|---|---|---|---|---|
| 2.1 | **Prize Book (collection grid):** every prize on the wheel as a card; won = lit + emoji/photo, unwon = tasteful locked silhouette + odds-honest "chase it" | Completion drive is intrinsic and ethical; gives a *concrete* reason to top up (fill the gaps) | M | derive from `wheel.prizes` (won set from `history`); optional persistent `imageUrl` already on `Prize` | **P0** | Show *real* odds (`prizeOdds` exists) on tap; never imply guaranteed |
| 2.2 | **Personal stat ribbon (fun, not dashboard):** 3 playful figures — total spins, rare drops ✨, prize-book % complete | Light vanity stats deepen investment without dashboard feel | S | counts derivable client-side; persist lifetime totals for accuracy (see 5.x) | P1 | Three numbers max, on the fan's terms — collapse by default |
| 2.3 | **Milestone moments:** celebratory toast at 10/25/50 spins and at "collection 50%/100%" | Marks progress as joyful; gives natural share beats | S | needs lifetime spin count (server) | P1 | Milestones are *achievements*, not gates — never block play |
| 2.4 | **Badges (sparse, earned):** "First Legendary", "Completionist", "Hat-trick" — a small shelf, not a wall | Identity + bragging rights = social shares back to creator's link | M | new `fan_badges` (fanId, badge, awardedAt) | P2 | Keep the set tiny and meaningful; no XP/level grind |

> **Data note for §2/§5:** the fan view today is largely stateless per-pass (`FanPassView`). Accurate lifetime stats/badges need a small server rollup keyed on the fan account (the fan record already exists creator-side — `FanAccountSummary` has `grantedTotal`, `lastWin`). Add read-only fan-facing fields to `FanPassView` (e.g. `lifetimeSpins`, `rareWins`, `badges`) rather than a new fan auth surface.

---

## 3. Social proof & FOMO (honest)

The engine supports `stock`, rarity, and a leaderboard — enough for *truthful* scarcity and proof. Never fabricate.

| # | What | Why | Effort | Data/migration | Priority | Tasteful note |
|---|---|---|---|---|---|---|
| 3.1 | **Recent-wins ticker:** subtle marquee "🎉 someone won Legendary · 4m ago" (handle-only, opt-in pool) | Live proof that rare drops are real and happening normalizes spending | M | new `GET /api/creator/:id/recent-wins` (handle-only, opt-in same as leaderboard) | **P0** | Only opted-in handles; round timestamps; no spend amounts |
| 3.2 | **Real stock counter on limited prizes:** show `prize.stock` ("3 of 5 left") *only when set* | Genuine scarcity drives action without lying | S | `stock` already on `Prize` + `isAvailable` | **P0** | Never show on unlimited prizes; never invent a number |
| 3.3 | **"X fans are chasing this":** on a wishlist/Prize-Book item, show real concurrent-wishlist demand | Honest competitive pull toward a specific prize | S–M | `WishlistDemand` aggregate exists creator-side; expose a fan-safe count | P1 | Count only, never names, on the fan side |
| 3.4 | **Leaderboard rank nudge:** "You're #7 — 3 spins from #6" using the embedded board | Concrete, close-by goals beat abstract ranks | M | leaderboard already ranks by spins; need the fan's own position | P1 | Aspirational delta only; never "you'll drop to #8" |
| 3.5 | **"Sold out" dignity:** when a limited prize hits 0, the Prize-Book card flips to "Claimed by the community ✨" | Truthful FOMO + closure; teaches that limited means limited | S | `stock===0` already excludes from spins | P2 | Celebrate the winner, don't shame the chaser |

---

## 4. Personalization & belonging

The page is already brand-themed (`--brand`). Push it from *themed* to *theirs*.

| # | What | Why | Effort | Data/migration | Priority | Tasteful note |
|---|---|---|---|---|---|---|
| 4.1 | **Creator note / mini-hero:** optional creator avatar + one-line personal message at the top ("Hey {fanName}, spin away 💋 — Mia") | Parasocial warmth is the product; a face converts far better than a title | S | add `creatorAvatarUrl` + `creatorNote` to `FanPassView` | **P0** | Creator-authored, real; `fanName` already exists |
| 4.2 | **Returning-fan greeting:** "Welcome back, {fanName} — you've got {n} spins waiting" on load (vs first-visit framing) | Recognition increases session start rate | S | first-seen flag (cookie or server `lastActive`) | P1 | Warm, never "you abandoned us" guilt |
| 4.3 | **Wishlist progress thread:** tie `WishlistSection` to the Prize Book — "2 of your 3 wishes landed" | Closes the loop on intent the fan already expressed | S | reuse `wishlist` + `history` | P1 | — |
| 4.4 | **Brand depth beyond color:** allow a creator background texture/gradient + display font accent within safe bounds | Each creator's room feels distinct; stronger ownership | M | extend wheel/brand config; guard contrast/perf | P2 | Constrain to keep accessibility + load budget |

---

## 5. Retention & return (no gambling loops)

The hard rule: **no daily free spins, no streak-or-lose, no manufactured timers.** Reasons to return must be *real events* the creator created.

| # | What | Why | Effort | Data/migration | Priority | Tasteful note |
|---|---|---|---|---|---|---|
| 5.1 | **"Spins waiting" recall (push/email handoff):** if the creator tops a fan up, the fan link can surface "🎁 {n} new spins from {creator}" | Real new value = legitimate return trigger; no fake urgency | M | needs a notify channel (web-push opt-in or creator-sent link) | **P0** | Only fires on a *real* top-up, never on a timer |
| 5.2 | **"What's new since your last visit":** new prizes added, happy-hour scheduled, leaderboard movement | Curiosity loop tied to genuine changes | M | `lastActive` diff vs wheel/happy-hour data (both exist) | P1 | Factual "new on the wheel", not "don't miss out!" |
| 5.3 | **Scheduled drop countdown:** if a happy-hour/new wheel is scheduled, show "Rare boost starts Fri 8pm" | Appointment viewing the creator controls; honest scheduling | S | `HappyHour.startsAt` + wheel `activeFrom` exist | P1 | Countdown to a *gain* (boost), never to a loss of access |
| 5.4 | **Web-push opt-in (post-win, not on load):** "Want a ping when {creator} drops new spins?" after a delightful moment | Owned re-engagement channel without app install | M | push subscription store; VAPID keys | P2 | Opt-in at a happy moment; easy off in Safety menu |

> **Anti-pattern guard:** do **not** add a "free daily spin", "login streak", energy/timer refill, or "spin now or lose your bonus" mechanic. These convert engagement into compulsion and break the every-spin-wins / payments-off-platform model.

---

## 6. Frictionless mobile

70%+ mobile. Two real gaps today: **no PWA/manifest** (confirmed absent) and **single-column flow gets long** below the wheel.

| # | What | Why | Effort | Data/migration | Priority | Tasteful note |
|---|---|---|---|---|---|---|
| 6.1 | **PWA: per-creator manifest + add-to-home:** dynamic `manifest` route themed to `--brand`, creator name/icon; install nudge after a win | Home-screen icon = the single best retention tool; turns a link into "their app" | M | add `app/manifest.ts` (dynamic) + icons; optional minimal SW for offline shell | **P0** | Icon is the *creator's*, reinforcing ownership; no install wall |
| 6.2 | **One-thumb layout audit:** SPIN within thumb reach, sticky spins counter, collapse secondary sections into a single "More" sheet | Keeps the wheel the hero and the long scroll manageable | M | layout only (`SpinClient`) | **P0** | Directly serves the lean mandate (§Guardrail) |
| 6.3 | **Instant load:** the page is `force-dynamic`; ensure wheel paints first, lazy-load chat/leaderboard/wishlist below the fold | Faster first spin = higher activation on cold mobile data | M | `dynamic()` import the below-fold fan components | P1 | — |
| 6.4 | **Accessibility pass:** the SPIN result needs an `aria-live` announcement; modal focus-trap/restore; verify `prefers-reduced-motion` cuts confetti + charge-up | Inclusive + avoids motion-sickness; legal hygiene for an adult product | S | `prefersReducedMotion()` exists; wire confetti/1.1/1.2 to it | **P0** | — |
| 6.5 | **Native share everywhere:** the win modal uses `navigator.share`; extend to Prize-Book milestones + leaderboard rank | More share surfaces = more inbound creator links (the growth loop) | S | reuse `/share/[shareId]` + OG image route | P1 | — |

---

## 7. The leaderboard-embedding question (owner's direct ask)

**Recommendation: keep inline-on-spin-page as the default, add the fan's own rank, and make a *standalone shareable board* the growth artifact. Do NOT add a dedicated fan "tab" (that's the first step toward a dashboard).**

Reasoning:
- **Inline (just shipped, `FanLeaderboard`) is correct as the *ambient* placement** — it shows competition without leaving the wheel and never exposes creator internals. It already self-fetches, hides when off/empty, and is handle-only/opt-in. Keep it, but **collapse it to top-3 by default with a "see full board" expand** so it never pushes the wheel down on mobile.
- **A dedicated in-page fan tab = no.** Tabs imply an app/dashboard with sections to manage. That violates the lean mandate and fragments the single-page flow.
- **Standalone shareable board = yes, as a separate route**, not embedded in the personal token link. `/leaderboard/[creatorId]` already exists and is privacy-safe (handle + spins + rare wins; the public one should **drop `spentCents`** — see §Remove). Make *that* the thing a creator/fan shares publicly and the thing the "you're #7" nudge deep-links to.

Concrete shape:

| Surface | Placement | Contents | Privacy |
|---|---|---|---|
| **Ambient** (default) | Inline in `SpinClient`, collapsed top-3 | rank, handle, spins, rare ✨ | handle-only, opt-in (existing) |
| **Personal nudge** | One line under the inline board | "You're #7 — 3 spins from #6" | the fan's own row only |
| **Shareable board** | `/leaderboard/[creatorId]` (own route) | top N, handle + spins + rare wins, **no spend** | handle-only; OG image for sharing |

Competitive-without-internals checklist: handle-only (no real names), opt-in (already enforced server-side), **never expose `spentCents` on any fan-public surface**, round/omit timestamps, and rank by *spins + rare wins* (engagement) rather than money — keeps it about play, not a spend leaderboard (which would be predatory and creepy).

---

## Top 8 "do next" (ranked, impact vs effort)

| Rank | Item | Impact | Effort | Why first |
|---|---|---|---|---|
| 1 | **2.1 Prize Book** | ★★★★★ | M | Ethical completion drive — the strongest non-gambling reason to keep spinning/topping up |
| 2 | **1.1 + 1.2 Charge-up + rarity reveal ceremony** | ★★★★★ | S–M | Makes the core loop *feel* incredible; raises perceived value of every spin |
| 3 | **4.1 Creator note / face** | ★★★★☆ | S | Parasocial warmth is the actual product; tiny effort, big conversion |
| 4 | **6.1 PWA add-to-home** | ★★★★☆ | M | Home-screen icon is the best retention lever and reinforces "their app"; gap today |
| 5 | **3.2 + 3.1 Real stock counts + recent-wins ticker** | ★★★★☆ | S–M | Honest scarcity + live proof, both backed by real data |
| 6 | **7 Leaderboard: collapse inline to top-3 + add personal rank + strip spend** | ★★★★☆ | M | Answers the owner's question; protects leanness + privacy |
| 7 | **6.2 + 6.4 One-thumb layout + a11y/aria-live** | ★★★☆☆ | M | Keeps wheel the hero on a long page; correctness + inclusivity |
| 8 | **5.1 "Spins waiting" recall** | ★★★☆☆ | M | Legitimate (real top-up) return trigger; needs a notify channel |

---

## Lean vs feature-creep — the guardrail

**The test for anything new:** *Does it make the next spin feel better, or does it ask the fan to manage something?* If it's management, it doesn't belong on the fan page.

**Hard "do NOT add" list (these turn it into a dashboard):**
- No fan login / account / settings screen. The pass token *is* the identity. (`FanPassView` is deliberately session-less — keep it.)
- No multi-tab / multi-route navigation on the personal link. One page, one hero.
- No analytics, charts, graphs, or "your stats over time" dashboards. Stats are 3 playful numbers max (2.2), collapsed by default.
- No transaction/payment history, no spend totals shown to the fan, no invoices. Payments are off-platform — keep them invisible.
- No creator-admin bleed: no odds editor, no campaign names, no fulfilment status queue, no CRM tags, no "wheel settings".
- No notification center / inbox list. Chat is one panel; recall is one banner.
- No gamification grind: no XP bars, levels, energy/timers, daily-streak meters, or free-spin loops.

**Progressive disclosure (how to keep the wheel the hero):**
- **Above the fold = wheel + SPIN + spins-left only.** Everything else lives below or in a sheet.
- **Collapse-by-default** the leaderboard (top-3 + expand), Prize Book (summary row → full grid sheet), referral, and chat. One tap to open, gone again on close.
- **Move secondary surfaces into a single "More" bottom sheet** (referral, wishlist management, safety, badges) instead of stacking them as permanent sections.
- **Reveal on event, not always-on:** `TopUpMoment`, milestones, and recall banners appear *only* at their moment, then dismiss.
- **One CTA hierarchy:** SPIN is the only primary button on screen at a time; share/top-up are secondary by color and weight.

---

## Currently on the fan page — REMOVE or de-emphasize

| Item | Action | Why |
|---|---|---|
| **`spentCents` in `LeaderboardEntry` / `/leaderboard/[creatorId]`** | **Remove from all fan-public surfaces** | A money leaderboard is predatory and exposes a creator/fan internal; rank by spins + rare wins instead. (`leaderboard/[creatorId]/page.tsx` currently renders `formatCents(e.spentCents)`.) |
| **Inline `FanLeaderboard` showing top-5 always-expanded** | **Collapse to top-3 + expand** | Pushes the wheel down on mobile; conflicts with "wheel is hero" |
| **Stacked permanent sections** (win pills + leaderboard + wishlist + referral + chat all rendered inline in `SpinClient`) | **Consolidate into collapsibles / a "More" sheet** | The page already scrolls long; each section competes with the wheel |
| **"Powered by FanFunnel · every spin wins" footer prominence** | **De-emphasize** (keep "every spin wins" near the wheel for the ethics signal, shrink the FanFunnel mark) | Reinforces *their creator's* brand over the SaaS; leanness |
| **`TopUpMoment` "Out of spins!" headline** | **Soften to gain-framing** ("Chase {rarePrize} →") | Avoid loss-framing even at the highest-intent moment; the body copy is already good |

---

## Files referenced

- `src/components/SpinClient.tsx` — the entire fan client; reveal flow, history pills, section stacking, `PrizeModal`, `Confetti`, `AgeGate`.
- `src/components/fan/FanLeaderboard.tsx` — inline board (collapse + add personal rank here).
- `src/components/fan/TopUpMoment.tsx` — highest-intent moment (re-frame to gain).
- `src/app/spin/[token]/page.tsx` — page shell, `--brand`, footer.
- `src/app/leaderboard/[creatorId]/page.tsx` — standalone board (strip `spentCents`).
- `src/lib/data/types.ts` — `FanPassView` (add `creatorNote`, `creatorAvatarUrl`, `lifetimeSpins`, `rareWins`, `badges`), `LeaderboardEntry`.
- `src/lib/games/wheel/engine.ts` — `prizeOdds`, `isAvailable`, pity/stock (powers Prize Book odds + real stock counts).
- `src/lib/games/wheel/types.ts` — `Prize.stock`, `imageUrl`, `cost`, rarity (Prize Book source of truth).
- `src/lib/sound.ts` — `playWin`, `haptic`, `prefersReducedMotion` (extend for §1).
- `src/app/layout.tsx` — add PWA `manifest` wiring (no manifest/SW exists today).
