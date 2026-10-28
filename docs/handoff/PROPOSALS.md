# FanFunnel pre-alpha roadmap: build proposals

Read 2026-10-27 against `origin/dashboard-redesign` @ `9220559` (the branch that will ship).
All file:line references are to that commit. Planning sources: `docs/autopilot/BACKLOG.md`
(P5 RM-1..RM-7), `docs/archive/ROADMAP.md` (Phase 6), `docs/archive/ROADMAP_PHASE7.md`, and the three
`RESEARCH_*.md` files on `claude/eager-volta-l8juq7`, plus `PRODUCT.md` and `DESIGN.md`.

**How to read this.** Each proposal opens with a short plain-English summary, then the
decisions you need to make, then the technical detail for whoever builds it. Your decisions
are also collected in one list near the top. Effort is S (a few days), M (about a week),
or L (two weeks or more), counting one engineer and preview testing.

---

## Contents
1. [Recommended build order](#1-recommended-build-order)
2. [All owner decisions in one list](#2-all-owner-decisions-in-one-list)
3. [Problems found while researching (fix along the way)](#3-problems-found-while-researching)
4. [Shared foundations (cross-cutting)](#4-shared-foundations-cross-cutting)
5. Proposals
   - [RM-1 Reveal theater](#rm-1--reveal-theater-rarity-tiered-win-animation)
   - [RM-2 Show stock to fans](#rm-2--show-stock-to-fans-3-left)
   - [RM-6 Spend-awareness guardrail](#rm-6--spend-awareness-guardrail-for-fans)
   - [RM-3 Streak / daily check-in glow](#rm-3--streak--daily-check-in-glow-no-free-spins)
   - [RM-5 Win-back DM automation](#rm-5--win-back-dm-automation)
   - [#26 Instant-delivery prizes](#26--instant-delivery--auto-fulfil-prizes)
   - [RM-4 PWA install for the fan page](#rm-4--pwa-install-for-the-fan-page)
   - [Web push for creators](#web-push--closed-tab-notifications-for-creators)
   - [#25 Focus pack / chase pity](#25--wishlist-focus-pack--chase-pity)
   - [Per-creator theming](#per-creator-theming-fonts-background-photo-hub)
   - [RM-7 Scratch tickets and bingo](#rm-7--more-games-scratch-tickets-and-bingo)
6. [Every migration, numbered](#6-every-migration-numbered)
7. [Every external setup you must do](#7-every-external-setup-you-must-do)
8. [What could go wrong: the riskiest three](#8-what-could-go-wrong-the-riskiest-three)

---

## 1. Recommended build order

The order is **guardrails first, then cheap high-value work, then the shared foundations,
then the features that change odds or payouts.** Each step is its own branch off
`dashboard-redesign` (or off `main` once the redesign ships), tested on its Preview before the
next one starts.

| # | Item | Effort | Why here |
|---|---|---|---|
| 1 | **RM-1** Reveal theater | M | Highest value per risk. No database change and no change to odds. It also builds the shared `RewardReveal` component that #26 and the new games reuse. |
| 2 | **RM-2** Show stock to fans | S | Small. It also fixes a real leak: the fan page and a public API currently send your **prize costs** to the browser (section 3). |
| 3 | **RM-6** Spend-awareness | M | **Risk-first.** The guardrail ships *before* we add more engagement (streaks, focus packs, more games). It also adds the "taking a break" state that RM-3 and RM-5 must respect. |
| 4 | **RM-3** Streak glow | S–M | Cheap, visual only. Comes after RM-6 so the glow can be hidden for fans on a break. |
| 5 | **RM-5** Win-back DMs | S–M | The research's highest-ROI creator feature. It needs RM-6's "on a break" flag and fixes the current list, which can suggest messaging fans who blocked or paused. |
| 6 | **Fairness v3** (shared foundation F2) | M | Must land before anything that changes odds per fan (#25) or adds games (RM-7). Doing it here gives it a long soak on Preview. |
| 7 | **#26** Instant-delivery prizes | M–L | Lower payout risk than #25, and reuses RM-1's reveal. |
| 8 | **RM-4** PWA install (fan) | M | Builds the manifest and icon routes that web push reuses. |
| 9 | **Web push** (creator) | L | Needs RM-4's install plumbing, because iPhones only allow push for apps added to the home screen. |
| 10 | **#25** Focus pack, then chase pity | L | The riskiest economics. Needs Fairness v3 and RM-6. Focus pack ships first and chase pity follows once focus has soaked. |
| 11 | **Per-creator theming** | M–L | Independent. Doing it before the games means scratch and bingo use theme tokens from day one. |
| 12 | **RM-7** Scratch tickets, then bingo | L | The largest item, touching the money path and the legal posture. Needs Fairness v3, RM-1 and theming. |

**Dependency graph (arrows mean "needed by"):**
```
F1 fan-safe projection ──► RM-2 ──► #26 ──► RM-7
RM-1 (RewardReveal) ─────────────► #26, RM-7
RM-6 (break state) ──► RM-3, RM-5, #25
F2 Fairness v3 ──────► #25, RM-7
RM-4 (manifest/icons) ──► Web push
Theming ──► RM-7 (renderers use theme tokens)
```

---

## 2. All owner decisions in one list

Each has my recommendation in **bold**. The detail and the alternatives are in each proposal.

1. **RM-1, when does the rarity show?** (a) only after the wheel stops; **(b) a build-up
   in the last second of the spin for epic and legendary, plus tap-to-skip**; (c) a full
   cut-scene for every rare-or-better win.
2. **RM-2, how is stock shown?** (a) the exact count on every limited prize, always;
   **(b) the exact count, with a per-wheel "Show stock to fans" switch that defaults to on**;
   (c) only "Only N left" once a prize gets to 5 or fewer.
3. **RM-6, what does a fan see about their own play?** **(a) spin counts only ("38 spins
   this week")**; (b) spin counts plus the dollar amounts the creator recorded; (c) nothing
   unless the fan sets a reminder.
4. **RM-6, can a creator turn spend reminders off?** **(a) No, they're platform-wide**;
   (b) yes, as a creator opt-out.
5. **RM-3, how does the streak behave?** (a) a classic day streak that resets to 0;
   **(b) a rolling "glow" showing days visited out of the last 7, with no reset cliff**;
   (c) a day streak with one free grace day. In every option a check-in means opening the
   link and never requires a spin.
6. **RM-5, what does "automation" mean?** (a) one-tap Copy DM from the list;
   **(b) (a) plus a "work the queue" mode that copies, marks as contacted and moves to
   the next fan, with a 14-day snooze**; (c) also auto-send an in-app chat message.
7. **#26, can a fan see a revealed reward again later?** (a) only once; **(b) any time
   from their own link, with every view logged**; (c) for 30 days.
8. **RM-4, what goes on the fan's home-screen icon?** (a) the creator's photo and name;
   (b) always a neutral icon and name; **(c) the creator chooses, defaulting to the neutral
   icon (an adult creator's face on a fan's home screen is a privacy risk for the fan).**
9. **Web push, what shows on the lock screen?** (a) full detail ("Nova won 👑 VIP
   Month"); (b) always generic ("New activity"); **(c) a per-device switch that defaults to
   generic.**
10. **#25, which models at alpha?** (a) focus pack only; **(b) focus pack first, then
    chase pity, where a chase pack sets aside one unit of stock the moment it is granted
    so the guarantee can always be honored**; (c) chase pity only.
11. **#25, the highest combined boost on one prize** (focus × happy hour): ×3, **×5**, ×10.
    A prize can only be boosted if you have marked it "boostable".
12. **Theming, what is the scope?** **Fonts, background and photos are per creator, and
    the brand colour stays per wheel as it is today**; or everything per wheel.
13. **Theming, what is allowed in the photo hub?** **(a) SFW-only everywhere: the creator
    confirms each upload is SFW, and fans can report it**; (b) SFW on the public `/c/` page,
    anything behind the age gate; (c) no uploads, preset backgrounds only. Hosting explicit
    media needs the 2257 records and age verification that are currently back-burnered.
14. **RM-7, what shape does bingo take?** **(a) a personal card where every play wins
    the prize it draws, and completing a line wins a bonus prize**; (b) a live, shared bingo
    event; (c) a personal card that pays only on a line. Option (c) breaks "every play wins",
    which is the legal line.
15. **RM-7, are scratch near-miss decoys allowed?** **(a) No engineered near-misses: a
    losing symbol shows at most once per ticket**; (b) allow "2 of a legendary" teasers.

---

## 3. Problems found while researching

These exist on the shipping branch today. Each is folded into the proposal that touches the
same code, but you should know about them.

1. **Prize costs leak to fans and to the public.** `toWheelConfig` copies `cost_cents`
   into every prize (`src/lib/data/shared.ts:140`). That config goes to the fan's browser
   (`src/lib/data/spins.ts:199` → `SpinClient`), and the **unauthenticated**
   `GET /api/public/wheel/[creatorId]` returns it too (`src/lib/data/publicProfile.ts:48`).
   Anyone can see what each prize costs you. Fixed by F1 in the RM-2 PR.
2. **The win-back list can suggest fans who blocked or paused.** `listFans` never reads
   `blocked_at` or `self_excluded_at` (`src/lib/data/fans.ts:247-252`). The dormant filter
   only checks spend and age (`fans.ts:389-392`), and "Copy link" uses the newest link
   even when that link is paused (`fans.ts:324`). This is a spend-safety bug. Fixed in RM-5.
3. **Webhooks may be dropped on Vercel.** `fireWebhooks` is fire-and-forget (`void …`,
   `spins.ts:591`). On serverless, work left running after the response can be cut off.
   Next 16's `after()` is the supported way to run it (see
   `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`). Fixed in
   the web-push PR, which adds the same kind of side effect.
4. **The odds are not part of the fairness proof.** The verify page proves only the
   seed (`src/app/verify/[shareId]/page.tsx:163-164`: "it does not re-simulate the full prize
   pool"). Any feature that changes odds per fan therefore needs F2 first.
5. **The pity counter write can race.** Two concurrent spins both read `pity_counter`
   (`spins.ts:403`) and then each write their own result (`spins.ts:524-530`, best-effort,
   no guard). This is harmless today but not acceptable once a chase pity *guarantee* rides
   on a counter (#25).
6. **There is no index on `spins(fan_id)`**, although every fan page load filters on it
   (`spins.ts:150-155`). Added in 0045.
7. **The app manifest can't install a fan's link.** `src/app/manifest.ts` has
   `start_url: "/"` and only a `.ico` icon, so Android won't offer a real install and an
   iPhone would open the marketing page, not the fan's link. Fixed in RM-4.

---

## 4. Shared foundations (cross-cutting)

These are built once and reused. Each is shipped inside the first proposal that needs it, so
nothing is built speculatively.

### F1. Fan-safe prize projection (ships with RM-2)
A single `toFanWheel(config, opts)` in `src/lib/data/shared.ts` produces what a fan or the
public may see. It returns `id, label, description, rarity, weight, color, emoji`, and also
`stock` (or `soldOut` when stock is hidden). It **never** returns `cost` or any reward field.
Use it in `getFanPass` (`spins.ts:199`) and `getPublicWheelTeaser` (`publicProfile.ts:48`).
A static test fails the build if a fan-facing data function returns `toWheelConfig` output
directly. #26 relies on this so reward secrets structurally cannot reach the fan payload.

### F2. Fairness v3: the odds go into the commitment (ships before #26/#25)
**Plain version:** today a fan can prove the random seed wasn't swapped, but not that the
odds used were the odds shown. v3 records the exact odds used for each spin, including any
happy-hour, focus or pity effect. It mixes a fingerprint of those odds into the random
number itself, and lets the verify page replay the spin end to end.

- **Today.** The RNG is `SHA-256(serverSeed:clientSeed:nonce:block)`
  (`src/lib/games/wheel/fairness.ts:85-109`). The pool is whatever the DB says at spin time,
  plus the happy-hour boost (`spins.ts:410`). Nothing about the pool is recorded except the
  winning label.
- **v3.**
  1. Build the **effective pool** after every modifier: happy hour, focus boost, the
     stock-available flag, and the pity/chase state. Serialize it canonically as JSON in
     config order: `[{id, rarity, w, avail}]` plus `{pity:{counter,threshold}, chase:…}`.
  2. Compute `poolHash = sha256(canonical)`.
  3. The RNG becomes `SHA-256(serverSeed:clientSeed:nonce:poolHash:block)`
     (`makeFairRngV3`). Changing the odds by even one ticket changes every random number,
     so the recorded result only replays against the exact odds that were recorded.
  4. Store `fair_version=3`, `pool_snapshot`, `pool_hash` and `modifiers` on the spin, and
     record the stock-exclusion re-picks (`spins.ts:469-506`) in order inside `modifiers`.
  5. The verify page (`boosts.ts:186-230` + `page.tsx`) re-hashes the snapshot, rebuilds the
     RNG, re-runs `pickPrizeWithPity` (plus focus/chase) and shows "Odds used for this spin"
     as a table. It reports a pass only when the replayed prize equals the recorded one.
- **Honest limit, shown on the verify page:** the odds are fixed when the spin runs, not when
  the page loaded, because a creator may edit a wheel in between. v3 proves the published
  odds produced the result. It does not prove the odds were the same ones on the fan's
  screen. The client can compare its own displayed-pool hash with the `poolHash` in the spin
  response and show "Odds were updated since you opened this page" if they differ.
- **Back-compat.** v1/v2 spins keep verifying as today, and `fair_version` selects the path.
  The mock store (`mock.ts`) must use the same derivation (also see COR-6).
- **Migration 0049.** Effort M. No new dependency.
- **Tests:** a replay test that, for 10k random pools, modifiers and seeds, the verifier
  reproduces the server's pick; a tamper test where changing one weight or one excluded id
  makes the replay fail; a v2 regression test that old spins still verify; a mock/real
  parity test (extends `spinParity.test.ts`).

### F3. Shared `RewardReveal` component (ships with RM-1)
`src/components/reveal/RewardReveal.tsx` replaces `PrizeModal` (`SpinClient.tsx:521-635`).
It takes `{prize, tier, shareId, extra?}` where `extra` is a slot (#26 puts the revealed code
or link there; bingo puts the "Line complete!" bonus there). Every game uses it.

### F4. Game core (ships with RM-7, designed now so nothing blocks it)
`src/lib/games/core/` holds the prize pool, availability, weighted pick, pity, boosts and
the v3 RNG. These are moved, not rewritten, from `src/lib/games/wheel/engine.ts`, which
re-exports them so existing imports keep working. Each game is a module:
`play(pool, rng, state) → { prize, presentation, nextState }`. The wheel's presentation is
the slice index. A scratch ticket's is the 9-cell face. Bingo's is the drawn ball and the
updated card.

### F5. Fan-token route helper
Several new fan endpoints (check-in, reminders, break, reward reveal, manifest) authenticate
only with the link token. A `withFanToken(req, fn)` helper does three things: it rate-limits
by IP + token through `rateLimitOr429`, resolves the fan with the service client (as
`resolveFanByToken` in `boosts.ts` does), and refuses blocked, inactive or paused links in
one place. Fans have no Supabase session, so these use `createServiceClient()` server-side
only, as `selfExclude` does today (`fans.ts:664-674`).

### F6. Engagement gate
`fanEngagementAllowed(fan)` returns false when the fan is blocked, any of their links is
self-excluded, or they are on a break (RM-6). Every "come back / keep going" surface checks
it: the streak glow, the win-back list, install nudges, and push about a specific fan.

### F7. Side effects after the response
`afterResponse(fn)` wraps Next's `after()` for webhooks and push, so neither can delay or
break a spin and neither gets cut off.

### F8. One notification item builder
Push and the bell must say the same thing. Split `buildNotificationFeed`
(`src/lib/data/notificationFeed.ts:99-186`) into per-kind `toNotificationItem(kind, source)`
builders that both the bell and the push sender call.

---

## RM-1 · Reveal theater (rarity-tiered win animation)

**In plain words:** Winning a legendary should feel like an event. Commons keep today's quick
pop. Rares get a spotlight on the winning slice. Epics and legendaries get a short build-up
just before the wheel stops (the screen dims and the rarity colour glows), a bigger burst and
a deeper sound. The outcome is decided on the server first, as it is today; the animation
only celebrates it. Fans who prefer reduced motion get a calm version, and anyone can tap to
skip.

**Effort:** M · **Depends on:** nothing · **New dependencies:** none (`motion` is already a
dependency, used by `PityBeat.tsx`) · **Migration:** none

### Decision for you
- **D1. When does the rarity show?** (a) only after the stop; **(b) a build-up in the last
  ~1s of the spin for epic/legendary, plus tap-to-skip (recommended)**; (c) a full cut-scene
  for every rare-or-better win. Option (b) is the gacha "rainbow" moment the research rates
  as the top lever (RESEARCH_FAN_VIEW 1.2). Option (c) slows repeat play and makes commons
  feel like losses.

### What the fan sees
On the spin page (`/spin/[token]`, `SpinClient.tsx`):

| Tier | During the spin | At the stop | Modal |
|---|---|---|---|
| Common / uncommon | unchanged (4.4s, `Wheel.tsx:32`) | the winning slice lifts and pulses for 250ms | today's pop |
| Rare | unchanged | spotlight plus a ring burst in rare blue | slightly larger medallion |
| Epic | the last ~1s slows (+500ms) and the page dims to 70% with a purple edge glow | particle burst, then confetti | big medallion and the epic stinger |
| Legendary | the last ~1.2s slows (+1.0s) and holds on the slice ("…"), with gold light rays and a sub-bass rumble | gold burst, confetti, the legendary stinger and a haptic pattern | gold frame, with **Share** as the primary button |

The extra time is capped: legendary adds at most 1.5s, and common adds 0. "Tap to skip"
appears after the first spin of a session.

### How it works
- **Pure config** in `src/components/reveal/revealTiers.ts`: per-rarity extra decel ms,
  dim level, colours from `RARITY_COLORS` (`types.ts:23-29`), haptic pattern and confetti
  count. It has a unit test.
- **`Wheel.tsx`:** the spin effect (`Wheel.tsx:334-398`) takes an optional `tier` prop.
  The total duration becomes `SPIN_MS + tier.extraMs`, eased with a longer tail
  (easeOutQuint for the final 20%). A new `onNearStop` callback fires at t≈0.8 so the parent
  can dim. The slice spotlight is drawn on the canvas after the stop. The reduced-motion
  branch (`Wheel.tsx:349-357`) stays a 400ms jump with no dim.
- **`SpinClient.tsx`:** `handleSpin` (`119-164`) already has the server's prize before
  animating, so the tier comes from `data.prize.rarity`. `handleSpinEnd` (`186-219`) opens
  `RewardReveal` (F3) instead of `PrizeModal`. `PityBeat`/`NearMissBeat` keep their current
  precedence. The theater overlay is lazy-loaded the same way `PityBeat` is (`SpinClient.tsx:18-19`).
- **`sound.ts`:** extend `playWin` (`sound.ts:93-131`) with a layered pad for rare and a
  rumble for the legendary hold. Mute is respected as today.
- **The watchdog** (`SpinClient.tsx:156-159`, 9s) is raised to cover the longest theater
  (4.4 + 1.5 + margin).

### Risks and guardrails
- **Fairness:** none. The theater runs only after the server decides and reads only the
  returned rarity. The near-miss beat stays derived from real slice positions (`fan/nearMiss.ts`).
- **Spend safety:** the intensity follows rarity, never spend, and commons still get a warm
  reveal ("every spin wins"). The extra time is capped, so play doesn't speed up or slow down
  in a manipulative way. No new loss-framed copy.
- **Accessibility:** the screen-reader announcement stays (`SpinClient.tsx:567-569`). The
  page dims rather than flashes: no full-screen flash, and nothing over 3 flashes/s (WCAG 2.3.1).
  Confetti and rays are skipped under reduced motion, as `Confetti` does today
  (`SpinClient.tsx:639-657`). Focus moves into the modal as today.
- **Performance:** one canvas overlay on transform/opacity only. A budget of +15KB gzipped,
  lazy-loaded. Target 60fps on a mid-range Android, checked with a Preview trace.

### Tests
- Unit: `revealTiers` (durations increase with rarity, reduced motion adds no time, total
  stays under the watchdog).
- e2e (mock mode, forced legendary): the modal appears within 4.4+1.5+0.5s, skip works, and
  the axe scan on the modal passes at phone width (extend `e2e/a11y.mjs`).
- Abuse/regression: a test asserts the client never sends anything but `{token, clientSeed}`
  to `/api/spin`, so the theater cannot influence the outcome.

---

## RM-2 · Show stock to fans ("3 left")

**In plain words:** Limited prizes show how many are really left ("3 left", or "Claimed ✨"
when gone) on the wheel page, in the Prize Book and on your public page. The numbers are the
real stock and update after every spin. The same change stops your prize costs being sent to
fans' browsers, which happens today.

**Effort:** S · **Depends on:** nothing (ships F1) · **New dependencies:** none · **Migration:** 0045

### Decision for you
- **D2. How is stock shown?** (a) the exact count on every limited prize, always (what the
  Prize Book already does, `PrizeBook.tsx:68-71`); **(b) the exact count with a per-wheel
  "Show stock to fans" switch, default on (recommended)**; (c) "Only N left" once a prize
  reaches 5 or fewer. Option (b) keeps the honest-scarcity default and lets a creator hide it
  for a prize they restock often.

### What the fan sees
- **Under the wheel:** a slim "Limited" row with a chip for each limited prize, in rarity
  colour: `📸 Signed Polaroid · 3 left`. Sold-out prizes read `Claimed ✨` and are dimmed.
- **Prize Book** (`PrizeBook.tsx`): already shows `N left`; it now also shows real odds on tap.
- **TopUpMoment** (`fan/TopUpMoment.tsx`): when the rarest unwon prize is limited, the teaser
  adds "only 2 left".
- **Win modal:** winning a limited prize adds "You got 1 of the last 3!"
- **Public page** `/c/[slug]`: the same chips on the prize teaser.

**The creator sees:** Wheels editor → wheel settings → toggle **Show stock to fans**
(default on), next to Title/Brand colour.

### How it works
- **F1 projection** (section 4) replaces `toWheelConfig` on the fan and public paths. When
  `show_stock=false` it sends `soldOut: boolean` instead of the count.
- **Live updates:** after the stock decrement (`spins.ts:484-490`), the spin response adds
  `stock: { [prizeId]: n }` for the wheel's limited prizes, read once after the insert, and
  `SpinClient` merges it into local state. The existing refresh when the tab becomes visible
  (`SpinClient.tsx:71-82`) covers changes made by other fans.
- **Migration 0045:** `wheels.show_stock boolean not null default true`, plus
  `create index spins_fan_created_idx on spins(fan_id, created_at desc)` (problem 6).

### Risks and guardrails
- **Overselling:** display only. The real guard stays the compare-and-swap in
  `takeStockUnit` (`spins.ts:329-353`), with sold-out prizes excluded and re-picked
  (`spins.ts:469-506`). A stale "1 left" can never cause an oversell. The worst case is that
  the fan wins a different prize, which the wheel animates to honestly.
- **Honesty:** counts appear only when `stock` is set, never invented
  (RESEARCH_FAN_VIEW rule). No countdown timers.
- **Privacy:** this fixes the `cost` leak (problem 1).
- **Fairness:** none (no change to odds).

### Tests
- **Negative:** fan payload and `/api/public/wheel/[id]` contain no `cost` key (new
  `fanProjection.test.ts`); with `show_stock=false` no numeric stock is present.
- Existing `spinStock.test.ts` still passes, and a new case covers "displayed stock 1,
  concurrent spins → exactly one wins it".
- e2e: win a limited prize, see the count drop without a reload.

---

## RM-6 · Spend-awareness guardrail for fans

**In plain words:** Fans can see how much they've played ("38 spins this week") and set an
optional reminder ("check in with me after 50 spins a day"). When they hit it, a gentle
"Want a breather?" card appears before the next spin. They can tap "Keep playing" or take a
break for 24 hours, 7 days or 30 days. There are no caps and no loss-framed copy. The
creator sees only that a fan is "on a break" (so they don't DM a link), never the fan's
settings.

**Effort:** M · **Depends on:** nothing · **New dependencies:** none · **Migration:** 0046

### Decisions for you
- **D3. What does the fan see?** **(a) spin counts only (recommended)**; (b) spin counts
  plus the creator-recorded dollar amounts; (c) nothing until they set a reminder. Dollar
  amounts are entered by the creator off-platform and can be wrong. The research also says
  "never show spend totals to the fan" (RESEARCH_FAN_VIEW line 150).
- **D4. Can a creator switch this off?** **(a) No, it's platform-wide (recommended)**; (b)
  a creator opt-out. A guardrail that the person profiting can turn off doesn't protect the
  brand or the payment-processor relationship.

Note: "per-fan spend limits" are explicitly *not* being built (ROADMAP_PHASE7 back burner),
and this proposal keeps that. Reminders are set by the fan and are soft. Breaks are chosen by
the fan and are enforced on the server.

### What the fan sees
- **"Your play" card**, a collapsed row under the spins chip next to the Safety menu
  (`SpinClient.tsx:279-338`, `fan/SafetyMenu.tsx`): "12 spins today · 38 this week". It also
  has **Set a reminder** (Off / 20 / 50 / 100 a day) and **Take a break** (24h / 7d / 30d).
- **Reminder card:** when today's spins reach their number, the next SPIN tap shows "You've
  played 50 spins today 💖 Your prizes are saved." with two buttons of equal weight: **Keep
  playing** and **Take a break**. It shows once per threshold per day.
- **On a break:** SPIN is disabled with "You're taking a break until Fri 9pm. Your spins
  and prizes are safe." Breaks can't be shortened (that's the point). They end on their own.
- **Existing "Pause my link"** stays as the permanent option (`fans.ts:664-674`).

### What the creator sees
- **Fan drawer** (`FanDetailDrawer.tsx`) shows a neutral "On a break until …" badge. Top-up
  and Copy DM are disabled with "Paused by the fan".
- Fans on a break drop out of win-back (RM-5), the push "out of spins" event (Web push), and
  `out_of_spins` in the bell (that already happens for self-excluded fans, `notifications.ts:229-234`).

### How it works
- **Data (0046):** `fans.play_reminder_daily int null check (play_reminder_daily between 10 and 500)`
  and `fans.break_until timestamptz null`. Fans have no auth. Writes go through new routes
  `POST /api/fan/reminder` and `POST /api/fan/break` (F5, service client, token-scoped,
  rate-limited). They can only *lengthen* a break, enforced in SQL with
  `break_until = greatest(coalesce(break_until, now()), $new)`.
- **Server enforcement:** redefine `claim_spin` (latest at `supabase/schema.sql:2316-2373`)
  to add `and (f.break_until is null or f.break_until <= now())` to the fan lookup. `spin()`
  then maps that refusal to a new `on_break` error (`spins.ts:259-275`), and `spinErrors.ts`
  gets the friendly copy. The function is mirrored into `schema.sql` and
  `migrations_combined.sql` (enforced by `sqlSync.test.ts`). The revoke from
  `public, anon, authenticated` is kept.
- **Counts:** `getFanPass` adds `play: { today, week, reminder, breakUntil }`, counted from
  `spins` by `fan_id` over rolling 24h/7d windows using index 0045. Rolling windows avoid
  time-zone games.
- **Reminder trigger:** the spin response includes `reminderDue: true` when `today` crosses
  the threshold, and the client shows the card before the *next* spin. This is soft by design
  (one tap continues), so it is client-side. The break is the hard part, and it is enforced
  on the server.

### Risks and guardrails
- **Spend safety:** this item *is* the guardrail. Copy rules: no countdowns, no "don't lose",
  and equal visual weight for Keep playing and Take a break. Legal/copy review is noted in
  section 7.
- **Fairness / economics:** none. Balances are untouched (`fans == SUM(passes)` holds, since
  nothing writes `fan_passes`).
- **Privacy:** the creator never sees the reminder number or the counts the fan sees, only
  the break state.
- **Security:** a token holder can only slow *themselves* down. The routes can't shorten a
  break or touch any other fan.

### Tests
- **Negative:** `claim_spin` refuses during a break, in a runtime test added to
  `scripts/security/rls-runtime-test.mjs` via the service role. A break can't be shortened
  (POST with an earlier time → unchanged). A token for creator A can't change a fan of creator B.
- Unit: rolling counts and `reminderDue` crossing logic.
- e2e: set a reminder at 20 in mock mode, spin 20 times, the card appears; take a 24h break,
  SPIN is disabled and `/api/spin` returns 403 `on_break`.

---

## RM-3 · Streak / daily check-in glow (no free spins)

**In plain words:** Fans who come back often get a warm glow around their spin counter and
the creator's photo, brighter the more days they've visited in the last week. It's purely
visual: no free spins, no better odds, and no "don't lose your streak" messages. Opening the
link counts; you never have to spin. Creators see who their regulars are.

**Effort:** S–M · **Depends on:** RM-6 (hide the glow during a break) · **New dependencies:**
none · **Migration:** 0047

### Decision for you
- **D5. How does it behave?** (a) a classic consecutive-day streak that resets to 0;
  **(b) a rolling glow of days visited out of the last 7, with no reset cliff (recommended)**;
  (c) a streak with one grace day. Options (a) and (c) create the "don't break the chain"
  pressure the research warns against (RESEARCH_FAN_VIEW lines 79-88, 153). Option (b) gives
  the momentum without a loss moment.

### What the fan sees
- **Glow levels:** 1–2 of the last 7 days is a faint ring, 3–4 is warm, 5–7 is full brand
  glow with a small "Regular ✨" tag. It surrounds the spins chip (`SpinClient.tsx:281-286`)
  and the creator avatar in `fan/CreatorNote.tsx`.
- **Milestones** (7 visits in 7 days, 20 in 30): a one-time celebratory toast, "You've
  stopped by every day this week — {creator} sees you 💖". No reward.
- **No message ever** when the glow fades.

### What the creator sees
- **Fan drawer stat:** "Visited 5 of last 7 days".
- **Fans list:** a "Regulars" filter. This is useful for VIP care and isn't a spend signal.

### How it works
- **Data (0047):** `fan_checkins(fan_id uuid references fans on delete cascade, creator_id uuid, day date, primary key (fan_id, day))`.
  RLS is enabled with a select policy of
  `(creator_id = auth.uid() and current_user_active()) or can_act_for(creator_id,'view') or is_admin()`,
  matching the existing per-table pattern. There is no insert/update policy for
  `authenticated`: writes come only from the service client.
- **Write:** `POST /api/fan/checkin {token, localDate}` (F5). It is called by the client
  **after hydration while the page is visible**, not during server render. That way the link
  preview bots that unfurl links in DMs don't create check-ins. `localDate` is clamped to UTC
  today ±1 day. The insert is an upsert on the primary key (idempotent).
- **Read:** `getFanPass` adds `glow: { last7: n, milestone?: … }` from at most 30 rows by
  primary key.
- **Engagement gate (F6):** no glow and no write while blocked, paused or on a break.

### Risks and guardrails
- **Spend safety:** a visit counts, a spin never does, and there is no mechanical reward.
  The copy rules from RM-6 apply. This is the one item where the owner decision conflicts
  with an earlier research rail ("no daily-streak meters"). Option (b) is the version that
  stays inside the spirit of that rail.
- **Economics / fairness:** none. Odds and balances are untouched.
- **Privacy:** check-ins are visible only to the owning creator (RLS). The public pages and
  the leaderboard never show them.
- **Performance:** one tiny upsert per visit, and a primary-key read.

### Tests
- **Negative:** creator B can't read A's `fan_checkins` (runtime test). Anon can't insert
  (static plus runtime). A paused link's check-in is refused.
- Unit: glow levels from day sets; date clamping.
- e2e: render without JS → no check-in row (proves bots don't count).

---

## RM-5 · Win-back DM automation

**In plain words:** The Analytics "Win-back" list becomes a to-do queue. Tap **Start**, and
for each quiet fan FanFunnel fills your saved message with their name, last win and fresh
link, copies it, and marks them as contacted. Then you paste it into your DMs and tap
**Next**. Fans you've messaged are snoozed for 14 days. Fans who blocked, paused or are on a
break never appear. You'll see how many came back.

**Effort:** S–M · **Depends on:** RM-6 (break state) · **New dependencies:** none · **Migration:** 0048

### Decision for you
- **D6. What does "automation" mean?** (a) one-tap Copy DM per fan; **(b) (a) plus a
  "work the queue" mode and a 14-day snooze (recommended)**; (c) also auto-send an in-app chat
  message. Real DMs live off-platform (OnlyFans etc.), and automating those breaks their
  terms. An in-app message (c) is only seen when the fan reopens the link, which a dormant
  fan won't do.

### What the creator sees
- **Analytics › Audience › Win-back card** (`CrmPanel.tsx:89-99`): each row gets **Copy DM**
  (a template picker) and a status ("Contacted 3d ago", "Came back ✓"). A **Start win-back**
  button opens the queue.
- **Queue sheet** (bottom sheet on phones, drawer on desktop, reusing the
  `FanDetailDrawer` patterns): fan name, days quiet, last win and the filled message preview.
  The buttons are **Copy & next**, **Skip**, and **Snooze 30d**.
- **Today › "Needs you now"**: the existing `winback` card (`src/lib/data/analytics.ts:592-602`)
  CTA opens the queue instead of copying one link.
- **Templates** (Fans › Manage messages, `FansPanel.tsx:555-680`) gain tokens: `{name}`,
  `{link}`, `{lastWin}`, `{days}`, `{creator}`. The current `{link}` substitution
  (`FanDetailDrawer.tsx:256-262`) moves to a shared `fillTemplate()`.

### How it works
- **Fix the list first** (problem 2): `listFans` (`fans.ts:247-252`) adds `blocked_at`,
  `break_until` and pass `is_active, self_excluded_at`. `getCreatorCrm` (`fans.ts:362-395`)
  drops anyone failing F6. `primaryToken` becomes the newest **active, non-paused** pass
  (today it's the newest of any, `fans.ts:324`).
- **Data (0048):** `fan_outreach(id, creator_id, fan_id, template_id null, kind text check (kind in ('winback')), contacted_at, snoozed_until null)`.
  RLS uses the standard creator/`can_act_for(creator_id,'message')`/admin pattern for select
  and insert. Update is limited to `snoozed_until`.
- **Came back** is derived: any spin by that fan after `contacted_at`. This needs no extra
  writes. A small "Win-back: 6 contacted · 2 came back" stat sits on the card.
- **Snooze:** the dormant list excludes fans with outreach in the last 14 days or
  `snoozed_until > now()`.
- **Routes:** `POST /api/crm/outreach` (session client + RLS; the creator id always comes
  from `auth.getUser()`, never the body).

### Risks and guardrails
- **Spend safety:** the list is ranked by lifetime spend, which is the most sensitive
  targeting in the product. Mandatory exclusions (F6) and a 14-day minimum between contacts
  are hard-coded, not settings.
- **Privacy:** the message is filled in the creator's browser from data they can already see.
  Nothing is sent anywhere by FanFunnel.
- **Security:** org seats (`chatter`) can use the queue only through
  `can_act_for(creator,'message')`.

### Tests
- **Negative:** a blocked fan, a fan with a self-excluded pass, and a fan on a break never
  appear in `dormant` (unit test on `getCreatorCrm` with `fakeSupabase`). Creator B can't read
  or insert A's `fan_outreach` (runtime). The copied link is never a paused token.
- Unit: `fillTemplate` with every token, missing values and HTML-ish input (plain text only).
- e2e: work the queue for 3 fans; snoozed fans disappear; a fan who spins shows "Came back".

---

## #26 · Instant-delivery / auto-fulfil prizes

**In plain words:** A prize can carry a digital reward: a link, an unlock code (one per
winner, from a list you paste in) or a short text. When a fan wins it, the reward is revealed
right in the win card and the prize is marked fulfilled automatically. You do nothing, and it
still shows in Fulfilment as "Auto-delivered" for your records. Codes are stored encrypted and
can never be seen before someone wins them.

**Effort:** M–L · **Depends on:** F1 (ships in RM-2), RM-1 (`RewardReveal`) · **New dependencies:**
none (Web Crypto AES-GCM) · **Migration:** 0050 · **External setup:** `REWARD_ENCRYPTION_KEY`

### Decision for you
- **D7. Can the fan reopen the reward later?** (a) once only; **(b) any time from their own
  link, with every view logged (recommended)**; (c) for 30 days. Fans lose screenshots, and
  option (a) turns every lost code into a support DM. The link token already identifies the
  fan, and the log shows the creator when it was viewed.

Scope note (not a decision): **links, codes and text only.** No hosted photos or videos. Instant
delivery of explicit media was explicitly parked until 2257 record-keeping and age verification
exist (ROADMAP_PHASE7 back burner; RESEARCH_ENHANCEMENTS S2/S4).

### What the creator sees
- **Wheels editor › prize card:** a new **Delivery** field: *Manual* (today) / *Instant link* /
  *Instant text* / *Code list*.
  - Link: an https URL, validated.
  - Text: up to 500 characters.
  - Code list: paste one code per line. The card shows "24 codes left". Codes are shown
    masked (`••••7F2K`) and never displayed back in full.
- **For a code-list prize, stock = codes left.** The stock field is locked and shows the
  code count, so the prize leaves the wheel when the codes run out (the existing stock
  machinery handles this).
- **Fulfilment** rows for these prizes show the status `Fulfilled` and an "Auto" tag, with
  "Viewed by fan · 2×, last Tue 9:14pm".

### What the fan sees
- **Win card (`RewardReveal`):** under the medallion, a "Your reward" box. Links show **Open
  ↗** (`rel="noopener noreferrer"`, opens off-site). Codes and text show a large copyable
  value.
- **My wins** (`fan/WinsGallery.tsx`): instant prizes get **View reward**.
- The share card (`/share/[id]`) and verify page **never** include the reward.

### How it works
- **Data (0050):**
  - `prize_rewards(prize_id pk references prizes on delete cascade, creator_id, kind text check (kind in ('link','text','codes')), cipher text, iv text, key_version smallint, updated_at)`
    holds the link or text encrypted. This is a separate table so `WHEEL_SELECT`
    (`shared.ts:108-110`) can't accidentally select it.
  - `prize_reward_codes(id, creator_id, prize_id, cipher, iv, key_version, spin_id uuid unique null references spins, assigned_at)`.
  - `redemptions.auto_fulfilled boolean not null default false`, plus `redemptions.reward_views int default 0`
    and `reward_last_viewed_at`.
  - RLS on both reward tables: creator/admin select and insert, scoped by `creator_id`. Rows
    hold only ciphertext, so even the creator's session can't read a plaintext code.
  - `claim_reward_code(p_prize uuid, p_spin uuid)` is a `security definer` function with
    `set search_path`. It picks one unassigned code with `for update skip locked`, sets
    `spin_id`, and returns its id. It is **revoked from `public, anon, authenticated`** and
    granted to `service_role` (the 0038 pattern). `serverOnlyRpc.test.ts` checks the call site.
- **Encryption:** `src/lib/rewards/crypto.ts` (server-only, `import "server-only"`) uses
  AES-256-GCM with a random 12-byte IV per value, and the key from `REWARD_ENCRYPTION_KEY`
  (base64 of 32 bytes). `key_version` allows key rotation. Plaintext exists only inside a
  server request.
- **Editor routes:** `PUT /api/prizes/[id]/reward` and `POST /api/prizes/[id]/codes`
  (session client; `can_act_for(creator,'edit')`; encrypt, insert, then
  `prizes.stock = stock + n`, in one function).
- **Spin path** (`recordClaimedSpin`, `spins.ts:355-606`):
  1. The pick and stock CAS are unchanged. A code prize's stock unit is taken by
     `takeStockUnit` as today.
  2. After the spin row is inserted (`spins.ts:556-573`), and only for instant prizes:
     - Code list: call `claim_reward_code(prize, spin)`.
     - Then insert the redemption with `status:'fulfilled', fulfilled_at:now(), auto_fulfilled:true`
       instead of `pending` (`spins.ts:575-579`).
  3. If the code claim fails (this should be impossible because stock equals codes left, but
     be defensive), **don't refund**. The win is already recorded, so insert a `pending`
     redemption with a note "Code pool empty — fulfil manually". The fan still wins and the
     creator sees it in the queue.
  4. The response carries `reward: { kind, value }`, decrypted on the server for this request
     only, with `Cache-Control: no-store` (the route already returns JSON).
  5. Webhooks fire `prize_delivered` (no payload) instead of `prize_pending` (`spins.ts:591-596`).
- **Re-view:** `GET /api/fan/reward/[shareId]?token=…` (F5) checks that the spin's `fan_id`
  is the token's fan, decrypts, increments `reward_views`, and returns `no-store`. It is
  rate-limited (10/min/IP+token).
- **Bell / push:** `pendingWins` only reads `pending` (`notifications.ts:70-76`), so
  auto-delivered wins don't nag the creator.

### Risks and guardrails
- **Security:** reward values can't reach the fan payload by construction (F1 and the separate
  table). The key is server-only (`REWARD_ENCRYPTION_KEY`, never `NEXT_PUBLIC_*`). Logs must
  never print values, so add a test that greps for console calls near decrypt. The reveal
  endpoint needs the fan's own token, and a share id alone reveals nothing.
- **Stock / overselling:** `stock == codes left` is an invariant, so a code can't be handed out
  twice (`spin_id unique`, plus `skip locked`). Restoring stock on rollback
  (`rollback_claimed_spin`, `schema.sql:2400-2412`) happens only before the spin is recorded,
  when no code is assigned yet. The order (claim after insert) means a refund can never strand
  an assigned code.
- **Economics:** none beyond today. Instant prizes are still picked by the same odds.
- **Adult context:** links go off-site and are the creator's responsibility. No media is hosted.
  The editor shows a one-line notice: "Links must comply with your platform's rules".
- **Ops:** losing the key makes the stored codes unreadable. The owner backs the key up
  (section 7).

### Tests
- **Negative:** the fan payload and the public teaser never contain `reward`/`cipher` (extends
  the F1 test). The reveal with another fan's token → 404. The reveal with a share id but no
  token → 400. `authenticated` can't execute `claim_reward_code` (static plus runtime).
  Creator B can't read A's `prize_reward_codes` (runtime).
- **Concurrency:** 20 parallel spins on a 5-code prize → exactly 5 distinct codes assigned,
  15 other prizes, stock 0, no duplicate `spin_id` (extends `spinStock.test.ts`).
- Crypto: round-trip, a tampered ciphertext fails, and the wrong key version fails.
- e2e: create a code prize, win it in mock mode, the code is shown, Fulfilment shows Auto, and
  View reward works from My wins.

---

## RM-4 · PWA install for the fan page

**In plain words:** Fans can add *their* spin link to their phone's home screen, so it opens
like an app straight to their wheel. Android shows a real Install button. iPhone shows a short
"Share → Add to Home Screen" guide. We offer it once after a win, never as a wall. By default
the icon is neutral, so an adult creator's face isn't on a fan's home screen unless the creator
chooses.

**Effort:** M · **Depends on:** nothing (web push reuses it) · **New dependencies:** none (icons
via the built-in `next/og` `ImageResponse`) · **Migration:** 0051

### Decision for you
- **D8. The home-screen icon and name:** (a) the creator's photo and name; (b) always neutral;
  **(c) the creator chooses, default neutral (recommended)**. Neutral means a wheel glyph in
  the creator's brand colour, named "Spins". It protects fans whose phones are seen by others.
  Creators who want "my own app" ownership can switch to their avatar.

### What the fan sees
- After their first win of a session, a small card under the SPIN button reads "Add
  {name} to your home screen ⭐". On Android/Chrome it shows **Install**, using the native
  `beforeinstallprompt`. On iOS Safari it shows **How** and a 2-step visual guide. Dismissing
  it hides the card for 14 days (`localStorage`, wrapped in try/catch).
- It is never shown when the page is already installed (`display-mode: standalone`), when the
  link is paused or on a break (F6), or before the age gate is accepted.
- The installed app opens **their** link, full screen, with the creator's brand colour as the
  theme colour.
- If a link is later deactivated, the app opens a friendly "This link has ended — ask
  {creator} for a new one" instead of a bare 404.

**The creator sees:** Settings › Public page › **Home-screen icon** (Neutral / My avatar).

### How it works
- **Per-link manifest:** `src/app/spin/[token]/manifest/route.ts` returns
  `application/manifest+json` with `start_url: /spin/<token>?src=pwa`,
  `scope: /spin/<token>`, `display: standalone`, the name per D8, `theme_color` from the brand,
  and icons. The spin page's `generateMetadata` sets `manifest` and `icons.apple` to these
  routes (`src/app/spin/[token]/page.tsx`). The response is `X-Robots-Tag: noindex` and
  `Cache-Control: private, max-age=300`.
- **Icons:** `src/app/spin/[token]/icon/[size]/route.ts` renders 192/512 PNGs (plus a maskable
  variant) with `ImageResponse`, either the glyph on the brand colour or the avatar from the
  public `avatars` bucket.
- **Root manifest** (`src/app/manifest.ts`) becomes the **creator dashboard app**:
  `start_url: /dashboard`, PNG icons. Today it points at `/` with a `.ico` only (problem 7).
  This is what web push needs on iPhone.
- **No service worker on fan pages.** No offline mode and no caching of secret pages. Next's
  PWA guide (`node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`) notes
  install prompts don't need offline support. We confirm on a real Android device that Chrome
  offers full install. If it only offers "Add shortcut", we add a no-fetch worker scoped to
  `/spin/<token>/`.
- **Data (0051):** `profiles.pwa_icon_mode text not null default 'neutral' check (pwa_icon_mode in ('neutral','avatar'))`
  is written through `set_pwa_icon_mode(text)`, a SECURITY DEFINER function on `auth.uid()`'s
  own row. `profiles` UPDATE is admin-only by contract, so it follows the `set_creator_note`
  pattern and is revoked from `anon` (0044 pattern).
- **Inactive tokens:** `getFanPass` returns null for inactive links (`spins.ts:46`). Add a
  small `getLinkStatus(token)` so the page can show "ended" without revealing anything about
  an unknown token.

### Risks and guardrails
- **Privacy:** the token lives on in the home-screen app. That is the intent, and it is equal
  to a bookmark. The referrer policy (`next.config.ts`) already stops the token leaking off-site.
  The neutral icon is the default.
- **Adult context:** the age gate still runs server-side on the first spin (`spins.ts:240-250`).
- **Security:** the manifest and icon routes reveal only the creator display name and brand
  colour to a valid token holder. They are rate-limited. Unknown tokens → 404.
- **Spend safety:** the install nudge appears once, after a win. It never appears at 0 spins,
  during a break, or as a gate.

### Tests
- Unit: the manifest for token X has `start_url`/`scope` bound to X; an inactive or unknown
  token → 404; the name and icon follow `pwa_icon_mode`.
- **Negative:** `set_pwa_icon_mode` can't change another profile (runtime); anon can't execute it.
- e2e: the manifest link is present and parseable, the icon routes return PNGs of the right
  size, and the nudge is hidden in standalone mode.
- **Manual (owner, real devices):** install on iPhone and Android, open from the icon, it lands
  on the right fan's wheel (see section 7).

---

## Web push · closed-tab notifications for creators

**In plain words:** Creators get real phone and desktop notifications for the things that
already appear in the bell: a fan won a prize, a new message, a prize running low, a fan out
of spins. They arrive even when FanFunnel is closed. You turn it on per device in Settings.
By default the lock screen just says "New activity on FanFunnel", so fan names and prize names
don't show on a locked phone unless you choose that. On iPhone you first add the dashboard to
your home screen (Apple's rule).

**Effort:** L · **Depends on:** RM-4 (root manifest and icons), F7, F8 · **New dependencies:**
**`web-push`** (see below) · **Migration:** 0052 · **External setup:** VAPID keys

### Decision for you
- **D9. Lock-screen content:** (a) full detail; (b) always generic; **(c) a per-device switch,
  default generic (recommended)**. Full detail ("Nova won 💋 Custom video") on a locked phone
  is an outing risk in this industry.

### What the creator sees
- **Settings › Notifications** (`SettingsPanel.tsx:641-720`), under the existing three
  toggles (new spin, low balance, messages):
  - **Push to this device** (on/off). On iPhone outside the installed app it shows "Add
    FanFunnel to your Home Screen first" with steps.
  - **Show names and prizes on lock screen** (off by default).
  - **Send a test**.
  - A list of devices ("iPhone · Safari, added Oct 30") with **Remove**.
- **Bell panel** (`NotificationBell.tsx`) footer: "Get these on your phone →" deep-links to
  that card.
- **Inbox "Enable alerts"** (`InboxPanel.tsx:168-185, 333`), the in-tab browser Notification
  API, is replaced by the same opt-in, so there aren't two systems.
- Tapping a notification opens the exact place: `/dashboard?section=prizes|inbox|editor|fans`
  (section ids in `dashboardSection.ts:4-15`).

### How it works
- **Data (0052):**
  - `push_subscriptions(id, user_id references profiles on delete cascade, endpoint text unique not null, p256dh text not null, auth text not null, show_details boolean not null default false, user_agent text, created_at, last_success_at, failures int default 0)`.
    RLS: select, update(`show_details`) and delete where
    `user_id = auth.uid() and current_user_active()`, or `is_admin()`. Insert with check
    `user_id = auth.uid()`.
  - `push_log(user_id, item_id text, sent_at, primary key (user_id, item_id))` stops the same
    feed item being pushed twice. RLS: select own. Writes are service-only.
- **Routes:** `POST /api/push/subscribe` and `DELETE /api/push/subscribe` (session client;
  the user id **always** comes from `auth.getUser()`); `POST /api/push/test`.
- **Service worker** `public/sw.js`: handles **only** `push` and `notificationclick`
  (`clients.openWindow`/`focus`). There is **no fetch handler**, so no page or API response
  is ever cached. It is registered from the dashboard with `scope: '/dashboard'`. The iOS
  installed app's `start_url` (`/dashboard`, RM-4) is inside that scope.
- **Sending:** event-driven, no cron.
  - Inside `/api/spin` (after a recorded win, after a stock decrement that crosses
    `LOW_STOCK_THRESHOLD=3` (`notificationFeed.ts:71`), and after a balance hits 0) and
    `/api/messages/fan` (after insert), call `afterResponse(() => notifyCreator(creatorId, event))` (F7).
  - `notifyCreator` (`src/lib/push/notify.ts`, `import "server-only"`) uses the service
    client with the `creator_id` taken from the server-side spin/message row (never from
    client input). It reads `notify_*` prefs (`schema.sql:2115-2130`). It builds the item
    with F8 so the text equals the bell. It applies `show_details` per subscription, skips
    item ids already in `push_log`, and sends with a 5s timeout.
  - A `410/404` response from the push service deletes the subscription, and 5 consecutive
    failures disable it.
  - Payload: `{title, body, url, tag}`. `tag` and the Web Push `Topic` header coalesce bursts:
    one notification per message thread, replaced in place.
  - Throttle: at most 1 push per thread per 2 minutes.
- **Why `web-push`:** it does the VAPID JWT signing (RFC 8292) and payload encryption
  (RFC 8291, aes128gcm), and Next's own guide uses it. **Avoidable?** Technically yes: about
  250 lines of Web Crypto (ECDH P-256, HKDF, AES-GCM, ES256). I recommend **not** hand-rolling
  this crypto. It is server-only and never in the browser bundle.
- **Fix in the same PR:** move `fireWebhooks` (`spins.ts:591`) to `afterResponse` (problem 3).

### Risks and guardrails
- **Privacy:** generic by default (D9). Payloads never include message bodies longer than
  the bell preview (120 characters, `notificationFeed.ts:77`), and never include reward values
  (#26) or spend.
- **Security / auth contract:** subscriptions are per auth user with RLS. The sender uses the
  service key only inside a server module. `VAPID_PRIVATE_KEY` is server-only and never
  `NEXT_PUBLIC_*`. Extend `serverOnly.test.ts` to fail if `web-push`, `src/lib/push/*` or
  `VAPID_PRIVATE_KEY` is reachable from a `"use client"` file. Org seats get push only for
  their own account in v1, because the bell is also owner-scoped (`notifications.ts:5-9`).
- **Performance:** sends run after the response (F7), in parallel per device with a timeout.
  The spin's response time is unchanged.
- **Ops:** subscriptions are tied to the VAPID public key. **Changing keys silently breaks
  every subscription**, so keys are set once per environment (section 7).

### Tests
- **Negative:** creator B can't read or delete A's subscriptions (runtime test). The subscribe
  route ignores a `user_id` in the body. `push_log` isn't writable by `authenticated`.
  `web-push` isn't in the client bundle (static).
- Unit: F8 builders give identical title/body for bell and push; discreet mode strips names
  and prize labels; prefs off → no send; the same item id → sent once; 410 → subscription deleted.
- Integration (mocked `web-push`): a spin win triggers exactly one send per active device
  after the response.
- **Manual:** desktop Chrome, Android Chrome, iPhone with the dashboard installed.

---

## #25 · Wishlist focus pack / chase pity

**In plain words:** You can sell premium packs tied to a prize a fan has wishlisted. A **Focus
pack** makes that prize, say, 3× more likely for the fan's next 10 spins. A **Chase pack**
guarantees the fan wins it within N spins. To guarantee that, one unit of the prize is set
aside the moment you grant the pack, so the promise can always be kept. You choose which
prizes can be boosted, and the editor shows what each pack is expected to cost you. The fan
sees honest, updated odds, and the fairness page proves the boost was applied as stated.

**Effort:** L (focus M, chase M) · **Depends on:** F2 Fairness v3, RM-6 · **New dependencies:**
none · **Migration:** 0053

### Decisions for you
- **D10. Which models at alpha?** (a) focus only; **(b) focus first, then chase pity with
  stock reservation (recommended)**; (c) chase only. Focus is a soft promise. Chase is a hard
  guarantee, so it only ships with reservation.
- **D11. The highest combined boost on one prize** (focus × happy hour): ×3 / **×5** / ×10.
  Only prizes you mark **Boostable** can be targeted.

### What exists today (and what is new)
| Exists | Where |
|---|---|
| Global pity: after 9 spins without a rare-or-better, the 10th is forced to a weighted in-stock rare+ prize; falls back if none in stock | `engine.ts:70-167` (`PITY_THRESHOLD=10`, `pickPrizeWithPity`) |
| Pity counter **per fan, across all their wheels** | `fans.pity_counter` (`schema.sql:464`); read `spins.ts:403,409`; written `spins.ts:524-530` (unguarded, problem 5) |
| A boost that multiplies rare+ weights (happy hour) | `applyRareBoost` `engine.ts:87-98`, used at `spins.ts:410` |
| Fan wishlists + creator demand view | `wishlists` (`schema.sql:510-528`), `addWishlist` (`boosts.ts`), `/api/wishlist-demand` |
| Packs (spins/price/bonus) | `campaign_packs` (`schema.sql:417-434`), `PackPresets`/`PackEditor` |
| Pity celebration UI | `PityBeat.tsx` |

**New:** a boost aimed at **one prize** for **one fan** for **N spins**. A per-target chase
counter with a hard guarantee. A "boostable" flag per prize. Stock reservation. EV preview.
Fan-facing focus status. Fairness v3 recording of all of it.

### What the creator sees
- **Wheels editor › prize card:** a **Boostable** toggle (default off), and for limited
  prizes a hint "Chase packs reserve 1 unit each".
- **Campaigns › Spin packs** (`PackEditor.tsx`): pack type *Spins* / *Focus* / *Chase*.
  - Focus: multiplier (1.5–×5) and spins (5–50).
  - Chase: "guaranteed within" (5–50 spins).
  - **EV preview:** "Raises 👑 VIP Month from 1.0% to 2.9% for 10 spins → about 0.19 extra
    wins, about $14 expected prize cost (from your prize cost). Pack price $20." It turns
    amber when the price is below the expected cost. Chase: "Guaranteed cost: 1 × $75."
- **Fans › drawer › Top-up** (`FanDetailDrawer.tsx:359-410`): choosing a Focus/Chase pack
  asks for a target prize, pre-filled from the fan's wishlist. It's disabled for fans on a
  break (RM-6). The drawer shows "Focus: 👑 ×3 · 7 spins left" or "Chase: 👑 · 4 to guarantee".
- **Fulfilment:** a chase or focus win shows a "Focus" tag.

### What the fan sees
- A chip above SPIN: "🎯 Focus on 👑 VIP Month · ×3 · 7 spins left". For chase, a progress
  ring "Guaranteed within 4 spins".
- **Prize Book** highlights the target and shows its boosted odds %.
- When the target is won: a `PityBeat`-style "Chase complete!" celebration.
- If a focus target sells out mid-pack: "👑 is sold out, so your focus is paused" (the focus
  spins are not used up). With chase reservation this can't happen to a chase.

### How it works
- **Engine** (pure, in F4 core):
  - `applyPrizeBoost(config, prizeId, mult)` (generalizes `applyRareBoost`).
  - `pickWithModifiers(config, {pity, focus?, chase?}, rng)`. The precedence is: **chase
    guarantee** (if `counter+1 >= within` → force the target) → pity → normal weighted pick.
  - A combined multiplier cap of `MAX_COMBINED_BOOST` (D11) is applied after happy hour.
- **Data (0053):**
  - `prizes.boostable boolean not null default false`.
  - `campaign_packs.pack_kind text not null default 'spins' check (pack_kind in ('spins','focus','chase'))`,
    `focus_multiplier numeric check (focus_multiplier > 1 and focus_multiplier <= 5)`,
    `focus_spins int`, `chase_within int`.
  - `fan_focus(id, creator_id, fan_id, prize_id, kind, multiplier, spins_left, chase_within, chase_counter int default 0, reserved boolean default false, grant_id references grants, status text check (status in ('active','done','paused','released')), created_at, completed_at)`.
    It has a partial unique index `(fan_id) where status='active'` (one active focus per fan,
    no stacking). RLS uses the standard creator/`can_act_for(creator_id,'grant')`/admin pattern.
    Spin-time writes are service-only.
  - `consume_focus_spin(p_focus uuid, p_expected_left int, p_won_target boolean)` is a
    service-only, revoked function. It does an atomic guarded update and returns the new state.
    `release_chase_reservation(p_focus uuid)` (service-only) puts the reserved unit back.
- **Granting** (`POST /api/fans/[fanId]/focus`, session client):
  1. Verify `can_act_for`.
  2. Verify the prize is boostable, on one of the fan's active wheels, and not sold out.
  3. Grant the pack's spins through the **existing `grantSpins` path** (`fans.ts:182`).
     **Focus never creates a second balance**, so `fans == SUM(passes)` is untouched.
  4. Insert `fan_focus`.
  5. For a chase on a limited prize, reserve 1 unit with the same CAS as `takeStockUnit`. If
     it's sold out, refuse before granting.
- **Spin** (`recordClaimedSpin`):
  1. The focus read joins the existing parallel read (`spins.ts:401-405`).
  2. If the target is on the resolved wheel, apply the boost or the chase. All of it goes into
     the v3 `modifiers` and `poolHash` (F2).
  3. When chase forces a **reserved** target, skip `takeStockUnit`, because the unit was
     already taken. A natural win of a reserved target also consumes the reservation rather
     than a second unit.
  4. After the spin row is recorded, call `consume_focus_spin`. Pity becomes the same kind of
     guarded update (fixes problem 5).
- **Release:** a chase is released (unit restocked) if the fan is blocked, self-excludes, or
  the creator cancels. The creator decides any refund off-platform.

### Risks and guardrails
- **Fairness:** every boost or guarantee is in the committed derivation (F2). The verify page
  shows "Focus ×3 on 👑 applied (7 of 10)". There's no hidden odds change, and the fan-facing
  odds show the boosted value.
- **Payout economics:** opt-in per prize. A ×5 combined cap. The EV preview uses `cost_cents`.
  A warning when the pack price is below the expected cost. One active focus per fan.
- **Stock overselling:** focus can't oversell (the CAS still guards). Chase **reserves at grant
  time**, so a guarantee can never meet an empty shelf. Reserved units are excluded from other
  fans' pools because they're already subtracted from `stock`. A test covers this.
- **Spend safety / adult context:** this is the most "loot-box" mechanic in the product. It
  requires RM-6 to be live. Packs can't be granted to fans on a break, copy never says "last
  chance", and focus ends silently.
- **Security:** grant routes check `can_act_for`; spin-time writes are service-only RPCs,
  revoked from anon/authenticated.

### Tests
- Engine: the boost touches only the target; the cap holds with happy hour; chase forces at
  exactly N; precedence chase > pity; a deterministic replay under v3.
- **Concurrency:** 10 parallel spins with one active focus with 3 spins left → exactly 3
  consumed; a chase reservation is never double-consumed; a reserved unit is never won by
  another fan (`spinStock.test.ts` style).
- **Invariant:** after a focus/chase grant and spins, `fans.spins_remaining == SUM(active passes)`
  (reuse `invariantHolds` from `editGrantLedger.test.ts`).
- **Negative:** creator B can't grant focus on A's prize or fan (runtime). A non-boostable
  prize → 400. A fan on a break → 409. anon/authenticated can't execute `consume_focus_spin`.
- Verify page replays a focused spin and a forced chase spin.

---

## Per-creator theming (fonts, background, photo hub)

**In plain words:** Each creator's fan page and public page can look like theirs. They pick a
headline font from a short curated list, a background (a few designed presets or their own
photo, kept readable automatically), and a small photo gallery. Everything stays SFW, every
photo is checked as a real image and stripped of hidden location data, and fans can report
anything inappropriate.

**Effort:** M–L (L with the photo hub) · **Depends on:** nothing (do before RM-7) · **New
dependencies:** **`sharp` as a direct dependency** (it's already installed as Next's optional
image library; making it explicit guarantees it's there for safe re-encoding). Avoidable with a
hand-written JPEG/PNG metadata stripper, which I don't recommend. · **Migration:** 0054

### Decisions for you
- **D12. Scope:** **fonts, background and photos per creator; brand colour stays per wheel as
  today (recommended)**, or all per wheel. The brand colour is stored per wheel today
  (`wheels.brand_color`; `brand-color/route.ts` sets the active wheel's). The rest is identity,
  not per-campaign.
- **D13. Photo rules:** **(a) SFW-only everywhere, creator attests, fans can report
  (recommended)**; (b) SFW on `/c/`, anything behind the age gate; (c) no uploads. Option (b)
  means hosting explicit media, which needs the parked 2257 and age-verification work. Photos in
  a public bucket can also be scraped and leaked.

### What the creator sees
**Settings › Public page** (`SettingsPanel.tsx:728`, `PublicPageSection`) gets a new **Look &
feel** card next to Brand colour, with the live preview that already exists (`ProfilePreview`,
`SettingsPanel.tsx:954`):
- **Headline font:** 6 choices (e.g. Bricolage Grotesque (default), Playfair Display,
  DM Serif Display, Syne, Fraunces, Unbounded), each previewed on the creator's name.
- **Background:** Glow (today), Velvet gradient, Grain noir, Aurora, Solid, or **Your photo**.
  An uploaded photo is blurred and darkened automatically.
- **Photo hub:** up to 12 photos, drag to reorder, an optional caption each, and a required
  "This photo is SFW" checkbox per upload.

### What the fan sees
`/spin/[token]` and `/c/[slug]`: the headline in the chosen font, the background, and a
swipeable **Gallery** strip under the creator note (`fan/CreatorNote.tsx`). The body text
stays Geist for legibility, and `--brand`, `readableInk` and `brandText` still drive every
accent (`src/lib/theme.ts`).

### How it works
- **Data (0054):**
  - `profiles.theme jsonb not null default '{}'`, validated by `set_creator_theme(p_theme jsonb)`.
    It is SECURITY DEFINER, checks the font/background keys against an allowlist and
    `bg_image` against the creator's own media, writes `auth.uid()`'s row only, and is revoked
    from anon. It is needed because `profiles` UPDATE is admin-only by contract (AGENTS rule 6).
  - `creator_media(id, creator_id, path, caption, sort_order, sfw_attested_at not null, created_at)`
    with the standard RLS.
  - A storage bucket `creator-media`, created in the migration (as `prize-photos` was,
    `schema.sql:576-590`). It has public read and **no direct client write policy**. Uploads
    go through the server route only.
- **Upload:** `POST /api/account/media` follows the avatar route
  (`src/app/api/account/avatar/route.ts`): auth, rate limit, magic-byte sniff via
  `imageSniff.ts` (rejects SVG), and a 5MB cap. Then **`sharp` re-encodes to WebP, max 1600px,
  with all EXIF/GPS metadata stripped**. The file gets a random UUID path under `<creator_id>/`
  and is uploaded with the service client.
- **Fonts:** `src/lib/theme/fanFonts.ts` declares the 6 fonts with `next/font/google`
  (`preload: false`, `display: 'swap'`). They are self-hosted at build, so fans' browsers
  never call Google. Only the chosen font's CSS variable is applied on the fan routes, and the
  dashboard is unaffected (`layout.tsx:10-17` unchanged).
- **Reports:** the Safety menu's report flow (`creator_reports`) gets the reason "Inappropriate
  photo". Admin gets **Remove media** on the account row.
- **Public page cache:** `/c/[slug]` revalidates every 60s (`src/app/c/[slug]/page.tsx`).
  Theme saves call the existing `revalidateMyPublicPage()`.

### Risks and guardrails
- **Adult context:** SFW attestation, reports, admin removal, and no explicit hosting (D13).
  Link-in-bio must stay postable on social platforms.
- **Privacy / security:** EXIF/GPS stripped (a photo's location can reveal a creator's home).
  Magic-byte checks, no SVG, random paths, server-only writes, and the theme is validated
  server-side so no arbitrary CSS or URLs.
- **Accessibility:** each preset is checked for contrast. Uploaded backgrounds get a scrim
  dark enough for `--color-ink` at 4.5:1. The axe scan covers every preset.
- **Performance:** a font costs about 20–40KB only when chosen. The background image is WebP,
  capped at 1600px, and lazy below the fold for the gallery. LCP is checked on Preview.

### Tests
- **Negative:** `set_creator_theme` can't write another profile and rejects unknown keys, a
  `url(...)` value, or another creator's media path. Creator B can't read or delete A's
  `creator_media` (runtime). The upload rejects SVG, oversize and polyglot files (extends
  `imageSniff.test.ts`). A fixture with GPS EXIF comes back with none.
- a11y: axe on the fan page × every background preset.
- e2e: change the font and background → the fan page reflects them after save.

---

## RM-7 · More games: scratch tickets and bingo

**In plain words:** Creators can offer a **scratch ticket** or **bingo** instead of (or
alongside) a wheel. They use the same prizes, odds, stock, fan links, balances, fulfilment and
fairness proof. A scratch ticket is a card the fan scratches with their finger; three matching
symbols reveal what they won, and every ticket wins. Bingo is a personal card: every play wins
the prize it draws, that prize gets marked on the card, and completing a line wins a bonus
prize. You switch these on per creator in Admin.

**Effort:** L (scratch M, bingo L) · **Depends on:** F2, F4, RM-1 (`RewardReveal`), theming
(renderers use theme tokens), and #26 if games carry instant prizes · **New dependencies:** none
(canvas + pointer events) · **Migrations:** 0055 (games), 0056 (bingo)

### Decisions for you
- **D14. Bingo shape:** **(a) a personal card; every play wins its drawn prize, and a line wins
  a bonus (recommended)**; (b) a live, shared bingo event; (c) a personal card that pays only
  on a line. Option (b) is real-time and multi-fan, and is legally close to a lottery. Option
  (c) breaks "every play wins", which keeps FanFunnel outside gambling law (README; `engine.ts:28-30`).
- **D15. Scratch decoys:** **(a) no engineered near-misses: any non-winning symbol shows at most
  once (recommended)**; (b) allow "2 of a legendary" teasers. Engineered near-misses on scratch
  cards are exactly what gambling regulators police.

Architecture note (my call unless you object): **a game reuses the existing "wheel" record as
its prize pool**, with a `game_kind` column. Links, campaigns, happy hours, stock, pity, packs,
analytics and fulfilment then all work unchanged. The alternative, a separate games table,
would touch every one of those.

### What the creator sees
- **Wheels section** (renamed **Games** in the UI only): "+ New" asks *Wheel / Scratch ticket
  / Bingo*. Scratch and bingo appear only when Admin has enabled them for the account
  (`src/lib/features.ts:11-15`; the `comingSoon` flags are removed; the toggle is in
  `AdminClient.tsx:537-566`).
- The editor is the same prize list, odds bar, stock and costs. Game settings:
  - Scratch: ticket style (theme-aware) and cell symbols (prize emoji).
  - Bingo: card size 3×3, **line prize** (pick a prize, falling back to a weighted rare+ pick
    if it's sold out), and an EV preview including the line bonus.
- Analytics split by game (`spins.game_kind`).

### What the fan sees
Same link `/spin/[token]`. The page renders by game kind:
- **Scratch:** a foil card over 9 cells. Scratch with a finger or mouse. **Reveal all** is
  always available (accessibility, and for the impatient). When three match → `RewardReveal`
  with the RM-1 tiers.
- **Bingo:** a 3×3 card of prize emoji. **Play** draws a "ball" (the prize) → that prize's
  `RewardReveal` → its cell lights up. A line → "Line complete!" bonus in the same reveal. A
  full card → a new card on the next play.
- Spins chip, Prize Book, Safety menu, RM-6 reminders, the RM-3 glow, the stock chips and the
  fairness hash all carry over unchanged.

### How it works
- **Core (F4):** `src/lib/games/core/play.ts` dispatches on `game_kind`. **Every game picks the
  prize with the same `pickWithModifiers` and the same v3 RNG**, then derives the presentation
  from the **following** RNG draws. The presentation is cosmetic and deterministic, so the
  verify page re-renders the exact ticket face or ball.
  - **Scratch face:** place the winning prize's symbol in 3 cells chosen by RNG. Fill the other
    6 cells with distinct other symbols, at most once each (D15), so there's never a second
    triple.
  - **Bingo:**
    - The card is built on the first play from that play's RNG: 9 distinct prizes, **only
      unlimited-stock prizes** so a cell can't become unmarkable.
    - Each play: pick → mark the cell if it's on the card → check the 8 lines.
    - A new line → a **bonus pick** from the following draws, through the stock CAS → a second
      `spins` row (`kind='bonus'`, `parent_spin_id`) plus its own redemption.
    - Card updates are guarded by a `version` column (CAS), so two parallel plays can't
      double-award a line.
- **API:** `/api/spin` stays the single play endpoint (`src/app/api/spin/route.ts`). The
  response adds `game` and `presentation`. `claim_spin`, balances and refunds are untouched:
  **one play = one spin credit**, so `fans == SUM(passes)` holds.
- **Data:**
  - **0055:** `wheels.game_kind text not null default 'wheel' check (game_kind in ('wheel','scratch','bingo'))`,
    `wheels.game_config jsonb not null default '{}'`, `spins.game_kind text`,
    `spins.presentation jsonb`.
  - **0056:** `bingo_cards(id, creator_id, fan_id, wheel_id, cells jsonb, marked jsonb, lines_awarded int default 0, version int default 0, status, created_at, completed_at)`
    with the standard RLS read and service-only writes. Also `spins.kind text default 'play' check (kind in ('play','bonus'))`
    and `spins.parent_spin_id uuid references spins`.
- **Feature gate:** the server refuses to create or save a scratch/bingo game unless
  `profiles.features[kind]` is true (read server-side, set only by admin). If a creator later
  loses the feature, existing links keep working (don't break paid fans) but no new games can
  be created.

### Risks and guardrails
- **Legal:** every play wins (D14a). No shared pot. No engineered near-misses (D15). The
  engine still throws if the pool is empty, which is then refunded (`spins.ts:507-517`).
- **Fairness:** the prize and the presentation both come from the v3 committed derivation. The
  verify page replays the ticket or ball and the bonus pick.
- **Economics:** the bingo line bonus is *extra* payout. The EV preview includes it (expected
  lines per card × bonus cost), with a warning if it exceeds a threshold of the pack price.
- **Stock:** the bonus goes through the same CAS. Bingo cells use unlimited prizes only. Card
  CAS prevents double awards.
- **Spend safety:** scratch "reveal all" is equally prominent. No auto-play, no "buy 10 tickets
  and scratch all" button, and RM-6 applies to plays exactly as to spins.
- **Accessibility:** a keyboard path (Reveal all, Play); the canvas has a text alternative; the
  bingo card is a labelled grid with `aria-live` on marks.

### Tests
- Engine: the scratch face always has exactly one triple (the prize) and other symbols at most
  once, over 10k seeds; bingo line detection; a bonus only on a *new* line; card generation
  excludes limited prizes.
- **Concurrency:** 5 parallel plays on one card → each line awarded once (version CAS).
- **Fairness:** the verify replay reproduces prize + presentation + bonus.
- **Negative:** a creator without the feature can't create a scratch game (server, not just
  UI); anon can't write `bingo_cards`; creator B can't read A's cards (runtime).
- **Invariant:** `fans == SUM(passes)` after mixed wheel/scratch/bingo play.
- e2e: scratch with the mouse and with Reveal all; play bingo to a line in mock mode with a
  forced seed.

---

## 6. Every migration, numbered

In build order. Each one is mirrored into `supabase/schema.sql` and
`supabase/migrations_combined.sql`; `sqlSync.test.ts` enforces this for functions, and the
`rls.test.ts` static checks cover every new table. Every new RPC is either revoked from `anon`
(self-service, the 0044 pattern) or revoked from `public, anon, authenticated` and granted to
`service_role` (server-only, the 0038 pattern). Every table enables RLS with a scoped policy
and no `using (true)`. Each one reaches the **test** DB before its Preview, and **prod** at the
merge to `main`.

| # | File | Item | Contents |
|---|---|---|---|
| 0045 | `0045_stock_visibility_spins_fan_idx.sql` | RM-2 | `wheels.show_stock`; index `spins(fan_id, created_at desc)` |
| 0046 | `0046_play_reminders_breaks.sql` | RM-6 | `fans.play_reminder_daily`, `fans.break_until`; **redefine `claim_spin`** to refuse during a break (re-revoke) |
| 0047 | `0047_fan_checkins.sql` | RM-3 | `fan_checkins` + RLS (read-only for creators) |
| 0048 | `0048_fan_outreach.sql` | RM-5 | `fan_outreach` + RLS |
| 0049 | `0049_fairness_v3.sql` | F2 | `spins.fair_version`, `pool_snapshot`, `pool_hash`, `modifiers` |
| 0050 | `0050_instant_rewards.sql` | #26 | `prize_rewards`, `prize_reward_codes` + RLS; `redemptions.auto_fulfilled`, `reward_views`, `reward_last_viewed_at`; `claim_reward_code()` (service-only) |
| 0051 | `0051_pwa_icon_mode.sql` | RM-4 | `profiles.pwa_icon_mode`; `set_pwa_icon_mode()` (revoke anon) |
| 0052 | `0052_push_subscriptions.sql` | Web push | `push_subscriptions`, `push_log` + RLS |
| 0053 | `0053_focus_packs.sql` | #25 | `prizes.boostable`; `campaign_packs.pack_kind/focus_multiplier/focus_spins/chase_within`; `fan_focus` + RLS; `consume_focus_spin()`, `release_chase_reservation()`, guarded pity update (all service-only) |
| 0054 | `0054_creator_theme_media.sql` | Theming | `profiles.theme`; `set_creator_theme()` (revoke anon); `creator_media` + RLS; `creator-media` bucket + storage policies |
| 0055 | `0055_games.sql` | RM-7 | `wheels.game_kind`, `wheels.game_config`; `spins.game_kind`, `spins.presentation` |
| 0056 | `0056_bingo.sql` | RM-7 | `bingo_cards` + RLS; `spins.kind`, `spins.parent_spin_id` |

RM-1 needs no migration. If the build order changes, renumber at PR time; numbers must stay
sequential.

---

## 7. Every external setup you must do

| When | What | Where |
|---|---|---|
| Before #26 Preview | **`REWARD_ENCRYPTION_KEY`**: run `openssl rand -base64 32` once **per environment** (test and prod get different keys). | Vercel → Project → Settings → Environment Variables. Add for **Preview** (one value) and **Production** (another). Mark it **Sensitive**. Never `NEXT_PUBLIC_`. **Also store both in your password manager.** If a key is lost, every stored code becomes unreadable. Redeploy after adding. |
| Before Web push Preview | **VAPID keys**: run `npx web-push generate-vapid-keys` once **per environment** (Preview and Production each get their own pair). | Vercel env vars: **`NEXT_PUBLIC_VAPID_PUBLIC_KEY`** (public half; Preview and Production values), **`VAPID_PRIVATE_KEY`** (private half; **Sensitive**, Preview and Production, never `NEXT_PUBLIC_`), **`VAPID_SUBJECT`** = `mailto:you@yourdomain` (both). Set them **once** and don't rotate casually, because changing a key breaks every device's subscription. Redeploy. |
| Development env | Don't add the push or reward keys to Vercel's **Development** environment unless you need them locally (Development now points at the **TEST** DB; OPS-4 was fixed 2026-10-23). | Vercel env vars |
| RM-4 and Web push testing | **Real devices**: an iPhone (iOS 16.4+) and an Android phone. Install a fan link and the dashboard to the home screen; turn on push on the installed dashboard; tap a test push. | Your phones, on the Preview URL |
| Before RM-6 and RM-3 go live | **Copy review** of the break/reminder text, and the long-open **/terms + /privacy** pages (UX-5). The age gate asks fans to accept Terms that don't exist yet. | Legal copy to the engineer |
| Before RM-7 Preview | In **Admin**, switch on Scratch / Bingo for your test creator account. | `/admin` → account → features |
| Strongly recommended before alpha | **Upstash Redis** (HARD-6). Five new public token endpoints (check-in, reminder, break, reward reveal, manifest) rely on rate limiting, and the current limiter is per-instance unless Upstash is set. | Upstash dashboard → add `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to Vercel Preview + Production |
| Theming | Nothing manual: the `creator-media` bucket is created by migration 0054. Check your Supabase plan's storage quota covers about 12 × 300KB per creator. | Supabase dashboard → Storage (check only) |

No new paid services are required. No Supabase Edge Functions or Vercel Cron are needed:
push is sent in response to events, not on a schedule.

---

## 8. What could go wrong: the riskiest three

### 1. #25 Focus pack / chase pity
- **The economics bite.** A creator boosts a $150 legendary ×5 on a $20 pack and doesn't read
  the EV preview. Ten whales buy it, and the creator owes more than they earned. *Mitigations:*
  prizes are off by default (opt-in Boostable), a ×5 cap, the amber warning, one active focus
  per fan. *Residual:* a creator can still ignore the warning. Consider making a below-cost
  price require a typed confirm.
- **The guarantee can't be honored.** Without reservation, a chase on a 1-of-1 prize promises
  something that another fan may win first. *Mitigation:* reserve at grant. *Residual:*
  reservation bugs (double-consumed or never released) quietly change stock. That needs the
  concurrency tests and a nightly invariant query ("active reserved chases ≤ units taken").
- **Optics.** This is the textbook loot-box mechanic, aimed at parasocial spenders. A press or
  payment-processor story would hurt. *Mitigations:* RM-6 must already be live, no packs for
  fans on a break, honest boosted odds, the fairness replay. *Residual:* real. That's why focus
  ships first, and why chase should be enabled for one test creator before anyone else.
- **Fairness regressions.** A bug in v3's recording of modifiers makes the verify page say
  "mismatch" on real spins, which looks like cheating. *Mitigation:* the 10k-seed replay
  property test, plus F2 soaking on Preview before #25 starts.

### 2. RM-7 Scratch tickets and bingo
- **Legal reclassification.** If any game ever pays nothing on a play, or a "bonus" turns into
  a pot shared across fans, the product moves toward lottery or gambling territory, along with
  payment-processor bans. *Mitigations:* D14a and D15, every play goes through the same
  never-empty engine, and there's no shared state between fans. *Residual:* future "fun" tweaks
  must be reviewed against this line. Write it into AGENTS.md.
- **Money-path regressions.** Moving the engine into `games/core` and adding a second
  `spins` row (the bingo bonus) touches the most sensitive code: claim, stock CAS, refund,
  seed rotation. A subtle bug could double-award or fail to refund. *Mitigations:* move the
  code without rewriting it (re-exports), run all existing spin tests unchanged
  (`spinLedger`, `spinStock`, `spinRefund`, `spinSeedRace`, `spinParity`), and add the card CAS.
  *Residual:* bingo's bonus row is new ledger semantics, so analytics must count it as a prize
  and not a spin. Audit every `spins` query for `kind`.
- **Scope creep.** Bingo is easily the largest item. If it slips, ship scratch alone; it covers
  most of the novelty value.

### 3. #26 Instant-delivery prizes
- **A secret leaks.** A future change selects `prize_rewards` into a fan or public payload, or
  logs a decrypted code. Codes are real value and can't be "un-leaked". *Mitigations:* the
  separate table, the F1 projection test, server-only crypto with `import "server-only"`, a test
  that fails if decrypt output reaches `console`, and `no-store`. *Residual:* the creator's own
  link (kind=link) is the same for every winner and can be forwarded. That's inherent; say so
  in the editor ("Everyone who wins gets this same link").
- **The key is lost or mismatched.** If Preview and Production are swapped, or a key is
  rotated without re-encrypting, every code fails to decrypt. Fans then see "Couldn't load your
  reward", and the auto-fulfilled rows are wrong. *Mitigations:* `key_version`, a startup self-check
  that decrypts a canary row and alerts if it fails, and keys backed up (section 7). *Residual:*
  this is an operations risk you own.
- **Stock drift between "stock" and "codes left".** If someone edits stock by hand or a code
  import half-fails, a code prize could be picked with no code left. *Mitigations:* the stock
  field is locked for code prizes and the import is one transaction. If it happens anyway, the
  win falls back to a manual pending redemption instead of failing (the fan still wins). Add a
  nightly invariant query.

Web push is the next riskiest, mainly for privacy (lock screens) and operations (key changes
break every subscription, and iPhones require the installed app). Both are covered by D9 and
section 7.
