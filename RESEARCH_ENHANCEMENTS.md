# FanFunnel — Enhancement Research & Recommendations

**Author:** Product strategy + design engineering pass
**Date:** 2026-05-31
**Status:** Research / planning only. No code in this doc.

## How to read this

This builds on what already ships (see `ROADMAP.md`). I deliberately do **not**
re-propose existing features (wheels, campaigns, pity, happy hour, wishlist,
leaderboard, referral spins, chat, share cards, provably-fair, webhooks,
analytics suite, admin panel) or the already-planned Phase 6 (gacha focus-pack,
instant-delivery prizes, web push). Everything here is net-new on top of that.

Each idea has: **what** · **why it matters here** · **effort** (S = hours, M = a
day-ish, L = multi-day) · **migration/risk** · **tier** (P0 must / P1
high-leverage / P2 nice).

Two lenses dominate the prioritization, because they *are* the business:
**(1) mobile-first fan delight & conversion** (70%+ of fans on phones, goal =
"spend more spins"), and **(2) creator monetization & retention**.

A note up front on ethics: the core loop is a paid, every-spin-wins gacha aimed
at people indulging a parasocial relationship. That is legitimate, but several
of the highest-converting mechanics below (streaks, countdowns, loss-framing,
near-miss) are the same ones regulators and app stores scrutinize as
"dark/predatory." I flag each one and recommend ethical guardrails so FanFunnel
stays on the right side of payment processors, app review, and the press. This
matters commercially, not just morally: adult + gambling-adjacent + predatory-UX
is exactly the combination that gets a processor to drop you.

---

## 1. Fan-facing delight & conversion

The fan surface (`SpinClient.tsx`) already has procedural tick/win audio
(`lib/sound.ts`), haptics (`navigator.vibrate`), near-miss + pity beats, and
reduced-motion support. What's missing is **persistence of momentum between
spins** and **social/scarcity context**. That's where the conversion lift is.

| # | Idea | Why it matters for this audience | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| F1 | **"Last spin" / low-balance moment.** When `spinsRemaining` hits 1 then 0, show a dedicated end-of-session card with the fan's session haul + a one-tap "Ask {creator} for more spins" that deep-links to chat (already gated) or a creator-set top-up link. | This is the single highest-intent moment in the whole funnel — the fan is engaged, just ran dry, and *wants* more. Right now hitting 0 is a dead end. Convert the urge while it's hot. | S | None (uses existing chat + a creator "top-up URL" field). Risk: keep copy warm, not nagging. | **P0** |
| F2 | **Session streak + "haul" reel.** Track consecutive spins this session; show a building combo ("3 in a row 🔥") and an animated end-of-session summary of everything won, as a single shareable card. | Streaks create a "just one more" loop and make a multi-spin session feel like an event, not N disconnected taps. The haul reel doubles as free social reach (reuses share-card infra). | M | None (client session state + reuse share OG route). **Ethics: cap the streak framing; never imply losing the streak loses prizes** — every spin already wins, so keep it celebratory not coercive. | **P1** |
| F3 | **Live scarcity on limited prizes.** The engine already supports `stock`. Surface it on the wheel/teaser: "Only 2 left" badge on rare slices, and a subtle "claimed by @fan 4 min ago" social-proof ticker. | Real scarcity (backed by actual stock) is the most honest FOMO lever you have and it's currently invisible to fans. Drives "spin now before it's gone." | M | None for stock display. Social ticker needs opt-in handles (leaderboard opt-in already models consent) — **never expose a fan who didn't opt in.** | **P1** |
| F4 | **Anticipation build on rare pulls.** Before the wheel result resolves, a short rarity-tiered build-up (screen dim, heartbeat haptic, rising tone) when the server result is epic/legendary — like a gacha "rainbow" tell. The server already returns rarity; the client can theatricalize honestly. | The *reveal* is the product. A flat spin under-monetizes the dopamine. Tiered theater makes legendaries feel legendary and gets retold to other fans. | M | None (client motion + existing `playWin` tiers). Respect `prefers-reduced-motion` (already wired). | **P1** |
| F5 | **Personalized wheel intro.** First load greets the fan by name ("Welcome back, {fanName} — you've won 3 rares for {creator}") using data already in `FanPassView` / `recentWins`. | Parasocial intimacy is the entire value prop. Personalization makes the link feel hand-made for them, raising willingness to spend. Near-zero cost — the data is already there. | S | None. | **P1** |
| F6 | **Idle "come back" hook on the fan page.** If a fan has 0 spins and lands on the link, show their best past win + "Next drop from {creator}: Fri 9pm" countdown (driven by scheduled wheels / happy hour, which already exist). | Turns a dead 0-spin visit into a re-engagement loop and advertises the creator's next monetizable moment. | S–M | None (reads scheduled-wheel / happy-hour windows). | **P2** |
| F7 | **Haptic + sound polish pass + a sound/haptic toggle.** Add distinct haptic patterns per rarity, a "wheel decelerating" rumble, and a persistent mute toggle (remembered in `localStorage`). | Mobile fans play with sound off in public; a visible, remembered mute keeps them spinning instead of bouncing. Per-rarity haptics deepen the tactile reward cheaply. | S | None. | **P2** |

---

## 2. Creator monetization & retention levers

Payments happen **off-platform** (grants are tied to tips elsewhere). So
FanFunnel's monetization job is to (a) maximize spins-per-grant and
grants-per-fan, and (b) give the creator scarcity/urgency tooling and pack
psychology. Campaign packs (`CampaignPack`: spins/amount/bonus) already exist —
the leverage now is *psychology and merchandising around packs*, plus win-back.

| # | Idea | Why it matters | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| M1 | **Win-back / dormant-fan worklist.** A dashboard view: fans with spins remaining who haven't spun in N days, and fans who went dry and never topped up. One-tap "Copy DM" using saved templates with `{link}`/`{lastWin}` tokens (templates already exist). | The cheapest revenue is a fan you already converted. Off-platform payments mean re-engagement is a *manual DM* today — this turns "who do I poke?" into a queue. Highest-ROI creator feature in this doc. | M | None (reads spins/last-activity). | **P0** |
| M2 | **Pack psychology: "best value" + bonus-spin anchoring.** In `PackPresets`/`PackEditor`, support a flagged "Most popular"/"Best value" tier, decoy mid-tier, and prominent "+N bonus spins" framing (bonus field already exists). Show effective price-per-spin. | Classic gacha/IAP price-laddering. The pack data model is there; the *merchandising* is the lever. Anchoring + a clear best-value tier reliably shifts buyers up a tier. | S–M | Maybe a `is_featured`/`badge` column on `campaign_packs`. **Ethics: real value, not fake discounts** — price-per-spin must be honest. | **P1** |
| M3 | **Scheduled drops with a fan-facing countdown.** Let a creator schedule a wheel/prize going live at a time, with a pre-announced countdown on the fan page and an optional push (web push is already planned). Builds on existing wheel scheduling. | Manufactured-but-honest scarcity ("Friday 9pm: new Legendary on the wheel") concentrates spending into events and gives the creator a recurring reason to DM the link. | M | None beyond existing `active_from/until`; pairs with planned web push. | **P1** |
| M4 | **VIP tier / whale program.** A per-creator VIP flag (or threshold on lifetime spend, which `totalSpent` already tracks) that unlocks a VIP-only wheel, better pity, or a VIP badge in chat/leaderboard. Tags already support "VIP"/"whale". | Whales drive the majority of revenue in every gacha economy; a named tier gives them status to chase and the creator a structured upsell ladder. | M | Small: `fans.vip` or a VIP wheel association. **Ethics: this is where spend can run away — pair with M? spend-awareness (see Safety S7).** | **P1** |
| M5 | **Bundle / multi-buy deals & gifting.** Pack presets that bundle a guaranteed prize ("10 spins + 1 guaranteed rare," reusing the pity engine) and a "gift spins to another fan" flow. | Guaranteed-rare bundles raise average pack size; gifting recruits new fans virally from inside the existing fan base (a referral the creator doesn't have to run). | M | Reuses pity engine + grants; gifting needs a fan→fan grant path. | **P2** |
| M6 | **"Creator's cut" awareness / payout preview.** Since prizes cost the creator real fulfillment (selfies, calls, VIP months), show a per-wheel expected-payout/EV preview so a creator doesn't accidentally build a money-losing wheel — and warn when a high-value prize's odds are set too generously. | Protects the creator's economics, which protects retention (a creator who gets buried in legendary fulfillments churns). Directly relevant before shipping the planned gacha focus-pack. | M | None (computable from weights/stock/`cost_cents`, all present). | **P1** |

---

## 3. Trust, safety & compliance

This is the category most under-built relative to the legal exposure, and it's
**adult content**. There is currently no age verification beyond a checkbox
(`fans/ack`), no content moderation, no media watermarking, no
record-keeping, and no fan-side block/report. For an adult platform these aren't
"nice to have" — they're the things that keep your payment processor and app
store, and keep you out of 18 U.S.C. § 2257 / CSAM / GDPR trouble.

| # | Idea | Why it matters | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| S1 | **Real age verification (creator side first).** The people whose content is sold and whose payouts you facilitate must be verifiably 18+. Integrate a third-party IDV/age-estimation provider (Yoti, Persona, Veriff, Stripe Identity) at creator onboarding; store only a pass/fail + verification id, never the raw ID image. | A checkbox is not age verification. Multiple jurisdictions (UK OSA, EU, and a growing list of US states) now mandate real age assurance for adult content; processors require it. This is table-stakes legal protection, not a feature. | L | New `verifications` table (status + provider ref, **no PII blobs**); vendor cost. **Risk of over-collection — store the minimum.** | **P0** |
| S2 | **2257-style record-keeping for prize media.** Any prize that delivers explicit media (selfie/video) needs an auditable record linking the performer's verified-18+ identity to the content set, with a custodian of records. Add a structured records store and a per-creator compliance status. | If creators deliver explicit media through (or attributable to) your platform, § 2257 record-keeping obligations are in play. Lacking it is an existential legal risk for an adult product. | L | New compliance schema; legal review required. Treat as a gate on launching instant-delivery explicit prizes. | **P0** |
| S3 | **Block / report for fans + creators.** A fan can report a creator/message; a creator can block a fan (revoke link, stop chat). Reports route to the admin panel (which already exists cross-account) with a moderation queue. | Safety + processor compliance both require a working abuse pipeline. Today a creator can't block a harassing fan and a fan has no recourse — both are liabilities. | M | New `reports`/`blocks` tables; admin queue UI. | **P0** |
| S4 | **Watermark + leak-protection on delivered media.** When a prize delivers an image/video (instant-delivery is planned), stamp a per-fan invisible/visible watermark and serve via short-lived signed URLs (Supabase Storage supports this). Optionally fingerprint for DMCA traceback. | Leaked content is the #1 creator fear and a top churn driver. Per-fan watermarking deters leaks and enables takedowns. Must land *with* instant-delivery, not after. | M | Storage signing + watermark pipeline (edge function). Pairs with planned #26. | **P1** |
| S5 | **Content moderation on uploads + chat.** Auto-scan creator-uploaded prize media and chat attachments against a CSAM hash database (e.g., a PhotoDNA-style service) and basic safety classifiers; block + flag on hit. | Non-negotiable for any platform hosting user media. A single CSAM incident is catastrophic. Even with adult content legal, illegal content must be impossible to pass through. | L | Vendor integration + quarantine flow; legal/NCMEC reporting path. | **P0** |
| S6 | **Payment-dispute / chargeback evidence pack.** Because money moves off-platform, disputes are messy. Give creators an exportable per-fan ledger (grants, spins played, prizes delivered, fulfillment timestamps, ToS acceptance) as chargeback evidence. | Off-platform tips + adult content = high chargeback risk. A clean evidence trail protects the creator's processor standing and reduces "I never got it" disputes. | M | None (data exists across grants/spins/redemptions/ack); add an export. | **P1** |
| S7 | **Spend-awareness / responsible-play guardrails.** Optional per-fan session/spend soft-caps with a gentle "you've spun a lot today" check-in, and a creator setting to enable cooldowns. Pair with not using loss-framed copy anywhere. | This is the ethical counterweight to the gacha mechanics above and a *defensive* one: "predatory loot-box UX targeting parasocial spenders" is a press/regulatory landmine. Shipping visible guardrails is both right and protective of the brand and processor relationship. | M | Small per-fan/creator settings. | **P1** |
| S8 | **Fan data privacy & deletion (GDPR/CCPA).** A documented data-retention policy, per-fan data export/delete on request, and PII minimization (handles, not legal names, where possible). Notes/tags about fans are sensitive personal data. | Creators store notes/tags ("whale," personal details) about fans — that's regulated personal data. You need a deletion/erasure path and a DPA story before EU/CA scale. | M | Cascade-delete tooling + policy; mostly process + a delete endpoint. | **P1** |

---

## 4. Creator workflow & operations

Goal: let a creator (or their VA) run hundreds of fans from a phone without
friction. The dashboard is feature-rich but built around one-at-a-time actions.

| # | Idea | Why it matters | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| W1 | **Bulk actions + saved views in the Fans tab.** Multi-select fans → bulk grant, tag, message (copy-DM), archive. Saved/filtered views ("VIPs with spins left," "dormant 14d," "pending fulfillment"). | At scale, the dashboard is death-by-a-thousand-clicks. Bulk grant/tag/DM is the difference between managing 30 fans and 500. Directly enables the win-back worklist (M1). | M | None (server bulk endpoints). | **P0** |
| W2 | **Team / VA access with scoped permissions.** Invite a manager/VA with a role (e.g., "fulfillment only," "chat only," "no payouts/settings"). Admin already models roles + invites. | Successful creators hire chatters/VAs. Sharing a full login is a security and trust disaster. Scoped seats are a retention moat — agencies *require* this. | L | New `memberships`/role rows + RLS on every table; meaningful RLS work. | **P1** |
| W3 | **Fulfillment SLA dashboard + reminders.** The redemption workflow has `dueAt`/status; add an SLA view (overdue/at-risk), aging buckets, and a daily "X prizes due today" digest (web push planned). | Slow fulfillment is the fastest way to lose a paying fan and trigger chargebacks. Make the queue self-driving so nothing rots. | M | None (data exists); pairs with push. | **P1** |
| W4 | **Mobile creator PWA.** Installable, mobile-first dashboard for the things creators do on their phone: reply to chat, grant spins, mark prizes fulfilled, see "due today." (See T-category PWA item.) | Creators live on their phones too. A fast home-screen app for grant + chat + fulfill is what makes FanFunnel a daily habit instead of a desktop chore. | M–L | PWA scaffolding (none exists today); see T3. | **P1** |
| W5 | **Keyboard shortcuts + command palette (desktop).** `Cmd-K` to jump to a fan, grant spins, switch wheel, open inbox. | Power creators on desktop run the business all day; a command palette is a large perceived-speed win for low effort. | S–M | None. | **P2** |
| W6 | **One-tap grant from chat / inbox.** When a fan asks for more spins in chat, grant + a pack preset inline without leaving the thread. | Collapses the highest-intent conversion path (fan asking to pay) into one tap, in context. | S | None (reuses grant + packs). | **P1** |

---

## 5. Analytics & intelligence

The analytics suite is already strong (heatmap, ROI, cohorts, funnel, revenue
trend). The next tier is **predictive + prescriptive**: tell the creator *who to
act on and what to do*, not just what happened.

| # | Idea | Why it matters | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| A1 | **Whale detection + LTV.** Rank fans by spend velocity and projected lifetime value (data: `grants`, `totalSpent`, recency/frequency). Surface a "top 5 fans to nurture this week" card. | Revenue concentration in whales is extreme in this category. Telling the creator exactly who to lavish attention on is the single most actionable insight you can give. Feeds VIP (M4) and win-back (M1). | M | None (computed from existing data). | **P0** |
| A2 | **Churn-risk scoring.** Flag fans whose spin/grant cadence is dropping before they go silent ("3 fans cooling off"). | Catching churn *before* it happens is worth more than any retention campaign after. Off-platform payments mean the only signal you have is in-app behavior — mine it. Feeds the win-back worklist. | M | None. | **P1** |
| A3 | **A/B testing wheels & packs.** Run two wheel configs (or pack ladders) across comparable fans/campaigns and report lift on spins-per-fan and revenue. | "Does this pity threshold / pack price / prize mix make more money?" is currently a guess. A/B turns the monetization knobs into evidence. Especially important before scaling the planned gacha focus-pack. | L | New assignment + experiment tables; care to keep provably-fair intact. | **P2** |
| A4 | **Anomaly & opportunity alerts.** Push/notify on: revenue spike or drop, a prize selling out, an unusually hot fan, a wheel paying out above its EV. | Turns analytics from a tab the creator forgets to open into proactive nudges at the moment they matter. | M | None (thresholds over existing series); pairs with push. | **P1** |
| A5 | **Recommended-actions feed.** A prioritized "do this now" list synthesizing the above: "DM these 4 dormant VIPs," "Legendary is 1 stock from sold out — schedule a drop," "Wheel X is paying out 20% over EV — tighten odds." | The creator-facing capstone. Most creators won't read charts; they'll act on a checklist. This is what makes the intelligence *land*. | M | None (orchestrates A1–A4 + M6). | **P1** |

---

## 6. Growth & virality

Referral spins + share cards + QR already exist. The gaps are **distribution
surfaces** (where the link lives) and a **business model for scale** (agencies).

| # | Idea | Why it matters | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| G1 | **Link-in-bio / public teaser landing.** A polished, SFW-safe public page per creator (or per wheel) showing the prize lineup, rarity odds, and a "DM me to play" CTA — shareable on socials where explicit links get banned. | Adult creators are constantly de-platformed from posting direct links. A clean, brand-adaptive teaser page is shareable on IG/TikTok/X bios and converts curiosity into a DM. Reuses the public wheel route + share-card aesthetics. | M | None (public read endpoints exist). **Must be SFW by default** to survive social moderation. | **P0** |
| G2 | **Embeddable widget.** A small embeddable "spin teaser" / "latest legendary winner" widget for creators with their own site/Linktree alternative. | Extends reach onto surfaces FanFunnel doesn't control, with FanFunnel branding — cheap top-of-funnel and light brand growth. | M | CORS/iframe + signed embed; SFW. | **P2** |
| G3 | **Agency / multi-creator management.** A role above creator: an agency that manages several creators' wheels, fans, and fulfillment from one console, with revenue rollups. Admin already does cross-account; productize a customer-facing version. | Agencies manage large stables of adult creators and will pay per seat/revenue-share. This is a whole B2B revenue line and a serious moat — and the cross-account plumbing partly exists. | L | Heavy RLS + org model (overlaps W2 team access). | **P1** |
| G4 | **Referral program upgrades.** Add referral tiers/milestones ("refer 5 → permanent bonus"), a fan-facing referral leaderboard, and shareable referral cards (reuse share infra). Builds on existing referral spins. | The referral primitive exists but is passive. Tiers + social proof + a shareable artifact make fans actually evangelize. | M | Small extensions to `referrals`. | **P2** |
| G5 | **Cross-creator discovery (opt-in, careful).** An opt-in "creators also on FanFunnel" rail or collab/shared-wheel events between creators. | Network effects + collab drops are big in the creator economy. **But** cross-promotion among adult creators raises consent/competition concerns — strictly opt-in, no auto-listing. | M | Opt-in flags; reputational care. | **P2** |

---

## 7. Technical / platform hardening

Stack: Next.js 16 app-router, React 19, Supabase, Tailwind v4, Vercel. Engine
and metrics are unit-tested; the gaps are **distributed-safety, mobile perf
budget, accessibility, i18n, PWA/offline, and route/E2E test coverage.**

> ⚠️ **NOTE for any implementer:** per `AGENTS.md`, this is a modified Next.js
> 16 with breaking changes — read `node_modules/next/dist/docs/` before writing
> any code for these items.

| # | Idea | Why it matters | Effort | Migration / risk | Tier |
|---|---|---|---|---|---|
| T1 | **Durable, distributed rate limiting + anti-fraud on the spin endpoint.** `lib/rateLimit.ts` is explicitly in-memory/single-instance and resets on cold starts — on Vercel serverless it's effectively unenforced. Move to a shared store (Upstash/Redis) and add per-fan/IP velocity + bot/abuse detection on `/api/spin`. | The spin endpoint mints real prize liability (creator payout). A trivially bypassable limiter on serverless is a fraud and cost hole. This is the most important hardening item. | M | New shared store dependency + env; logic already isolated behind `rateLimit()`. | **P0** |
| T2 | **Mobile performance budget + verification.** 70%+ mobile, motion-heavy. Set a budget (LCP/INP/JS size), code-split the wheel/motion, lazy-load dashboard panels, and add Lighthouse/Web-Vitals checks in CI. Audit `motion` bundle on the fan route. | Fan conversion is latency-sensitive; a janky first spin on a mid-range Android loses the sale. Today there's no budget enforcing this. | M | None (build config + CI). | **P0** |
| T3 | **PWA / installable + basic offline.** No manifest or service worker exists (`public/` has only SVGs). Add a manifest, installability, offline shell, and the service worker that web push (planned) needs anyway. | Enables home-screen install for both fans ("my wheel") and creators (W4), offline resilience on flaky mobile, and is a *prerequisite* for the already-planned web push. | M | New SW + manifest; coordinate with planned push. | **P1** |
| T4 | **Accessibility pass (WCAG 2.2 AA).** Audit the wheel for keyboard/AT operability, ensure result is announced (live region), color-contrast on rarity colors, focus management in modals/drawers, and confirm `prefers-reduced-motion` paths everywhere. | Legal exposure (ADA) + a meaningful slice of users. The motion-first design makes this non-trivial and worth a dedicated pass. The `accessibility`/`frontend-a11y` skills are available. | M | None. | **P1** |
| T5 | **i18n / localization.** No i18n library present (only `toLocaleString`). Add a framework + extract strings; localize currency/number/date and the fan surface first. | Creator economy is global; many adult markets are non-English. Localizing the *fan* surface widens every creator's addressable audience. | L | Routing + message extraction; do fan surface first. | **P2** |
| T6 | **Observability + error tracking.** Add structured logging, error tracking (Sentry), and uptime/SLO alerts on the spin + chat + webhook paths. | You can't run a live SaaS handling money-adjacent flows blind. A failed spin or lost chat message is lost revenue/trust you won't hear about otherwise. | S–M | Vendor SDK + env. | **P1** |
| T7 | **Test coverage: API routes + E2E.** Engine/metrics are well-tested; API routes and the critical fan-spin and grant flows are not. Playwright is already a dependency — add E2E for spin → win → fulfill and grant → top-up, plus route-level tests on `/api/spin`. | The money paths are exactly the ones with no integration tests. Cheap insurance against a regression that silently breaks spins or grants. | M | None (infra present). | **P1** |
| T8 | **Idempotency + integrity on spin/grant writes.** Ensure double-tap/retry on `/api/spin` and grant creation can't double-spend or double-grant (idempotency keys; server-authoritative decrement in a transaction). | Mobile networks retry; a double-decrement gives a free spin or a double charge. Server already authoritative — formalize idempotency. | M | Possible idempotency-key column; transactional decrement. | **P1** |

---

## Top 10 — "do these next"

Ranked across all categories, balancing impact vs. effort. Compliance items that
are genuine legal exposure are weighted up even at higher effort.

| Rank | Item | Why it's next (one line) |
|---|---|---|
| 1 | **T1 — durable rate limit + anti-fraud on spin** | The in-memory limiter is effectively off on serverless; this gates real prize liability. Fix before any growth. |
| 2 | **F1 — "last spin" top-up moment** | Highest-intent moment in the funnel is currently a dead end; tiny effort, direct conversion. |
| 3 | **M1 — win-back / dormant-fan worklist** | Cheapest revenue is a fan you already converted; turns manual guessing into a queue. |
| 4 | **A1 — whale detection + LTV** | Tells the creator exactly who to nurture; feeds VIP, win-back, and recommended-actions. |
| 5 | **S3 — block / report** | Safety + processor table-stakes; today a creator can't block a harasser. Medium effort, large risk reduction. |
| 6 | **W1 — bulk actions + saved views** | Removes the scaling ceiling on the dashboard; enables the win-back worklist to be actioned fast. |
| 7 | **G1 — link-in-bio / SFW teaser page** | Adult creators get de-platformed constantly; a shareable SFW page is top-of-funnel they can actually post. |
| 8 | **T2 — mobile perf budget** | 70% mobile; a janky first spin loses the sale and nothing currently guards against regressions. |
| 9 | **S1 — real age verification (creator side)** | Legal table-stakes for adult content under fast-moving age-assurance laws; a checkbox won't survive audit. Higher effort but non-negotiable. |
| 10 | **F4 — rarity-tiered reveal theater** | The reveal *is* the product; cheap motion work that makes legendaries feel legendary and get retold. |

---

## 3 big bets

1. **Agency platform (G3 + W2).** Productize the existing cross-account admin
   into a customer-facing agency console: one org managing many adult creators'
   wheels, fans, fulfillment, and revenue, with scoped VA seats. Agencies run
   large creator stables and will pay per-seat / rev-share. This is a new B2B
   revenue line *and* a defensible moat, and the cross-account plumbing already
   half-exists.

2. **Prescriptive "autopilot" growth engine (A1–A5 + M1 + M3).** Evolve
   analytics from charts into a daily, ranked "run your business" action feed
   that drafts the DMs, schedules the drops, flags the whales and the churn, and
   warns on payout EV — so a solo creator operates like one with a full ops
   team. The differentiator isn't more data; it's doing the thinking for them.

3. **Compliance-as-a-moat for adult creators (S1–S6).** Make verified age
   assurance, watermarked/leak-resistant delivery, CSAM-safe moderation, and
   chargeback-evidence the *reason* serious creators and agencies choose
   FanFunnel. In a category where everyone fears de-platforming and leaks, being
   the trustworthy, processor-safe option is a durable advantage most
   competitors won't invest in — and it de-risks your own business at the same
   time.

---

## Risks / mistakes in the current feature set

- **The rate limiter is effectively unenforced in production.** `lib/rateLimit.ts`
  is self-documented as in-memory, single-instance, reset-on-cold-start. On
  Vercel serverless that means the spin endpoint — which decrements real,
  money-backed spins and mints prize liability — has no reliable abuse ceiling.
  This is the most concrete current mistake. (→ T1.)

- **Compliance is the thinnest part of an adult product.** Age "verification" is
  a checkbox (`fans/ack`), there's no content moderation, no media watermarking,
  no 2257-style record-keeping, and no block/report. For adult + payments this
  is the category most likely to cause an actual existential event (processor
  drop, app-store removal, legal action). The feature work to date is
  conversion-rich and compliance-poor. (→ S1–S6.)

- **The mechanics stack is drifting toward "predatory loot box."** Pity,
  near-miss, happy-hour boosts, and the planned gacha focus-pack/chase-pity are
  individually fine, but in aggregate they target parasocial spenders with
  classic gambling-adjacent UX. There is currently *no* spend-awareness or
  responsible-play counterweight. Beyond ethics, "predatory adult loot boxes" is
  precisely the framing that draws regulators, app review, and hostile press —
  and the every-spin-wins design that keeps you out of gambling law won't save
  you from that narrative. Add visible guardrails (S7) *before* scaling the gacha
  mechanics, and keep all copy celebratory rather than loss-framed.

- **Cutting the daily free spin was right; just don't replace it with pressure.**
  ROADMAP correctly cut "daily free spin" ("not a casino — monetize instead").
  Good call. But ensure the monetization replacements (streaks, countdowns,
  scarcity) stay honest: real stock, real value-per-spin, no manufactured loss.

- **Money paths are the least-tested code.** The engine and metrics are
  well-unit-tested, but `/api/spin`, grants, and the fan-spin E2E flow — the
  literal revenue paths — have no route or integration tests despite Playwright
  being installed. One bad refactor could silently break spins or double-grant.
  (→ T7, T8.)

- **Dormant `imageUrl` / prize-photo path is a latent footgun.** Prize photos
  were built then cut, leaving `prizes.image_url` and share `imageUrl` dormant
  in schema/types. Harmless today, but if instant-delivery explicit media (#26)
  reuses this path, it must land *with* watermarking, signed URLs, and
  moderation (S4/S5) — not before.
