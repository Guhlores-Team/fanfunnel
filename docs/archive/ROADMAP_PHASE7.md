# Phase 7+ Roadmap — hardening, growth & big bets

Built on the `RESEARCH_ENHANCEMENTS.md` findings. Everything ships the house way:
mock-first → migration → data fn → route → UI → `tsc`/`eslint`/`build`/tests green
→ commit + push (auto-deploys) → screenshot-verify on mobile.

## ✅ Shipped (this phase)
- [x] **Risk 1 — durable spin rate limit.** `claim_spin` now enforces a rolling
      window (8 spins / 10s) inside the atomic decrement, so serverless instances
      can't race past it. Returns `-1` → HTTP 429. (migration 0012)
- [x] **Block / report.** Creator blocks a fan (drawer → Safety → Block; disables
      all their links via `claim_spin`). Fan reports a creator (spin page →
      Safety & privacy → Report) into an admin queue (`creator_reports`).
- [x] **Risk 3 — self-exclusion (no spend limits).** Fan can pause their own link
      from the spin page. We keep the "So close!" near-miss + chase mechanics.
- [x] **Last-spin top-up moment.** At 0 spins, tease the rarest unwon prize + a
      direct creator tip link instead of a dead end.
- [x] **Whale detection + LTV + win-back worklist.** Analytics tab: total/avg LTV,
      top spenders, and spent-but-dormant (14d+) fans with one-tap copy-link.
- [x] **SFW link-in-bio** `/c/[slug]` — postable landing page + dashboard editor.
- [x] **Gated signups** (request → admin approval queue). (migration 0011)

## 🔜 Next (high-leverage, low/medium effort)
- [ ] **Edge IP rate limit (layer 2).** Add `@upstash/ratelimit` + Upstash Redis
      keyed by IP on `/api/spin` as a second ceiling above the DB window. (S)
- [ ] **Spend-awareness (Risk 3 honest guardrail).** A subtle fan-visible "X spins
      this week" — celebratory, never loss-framed. No caps. (S)
- [ ] **Reveal theater.** Rarity-tiered win animation (epic/legendary get bigger
      moments) — the reveal *is* the product. (S–M, motion skills)
- [ ] **Streaks / daily check-in glow** (no free spins — just visual momentum). (S)
- [ ] **Stock visible to fans.** Engine already supports `stock`; show "3 left"
      on rare prizes for honest scarcity. (S)
- [ ] **Money-path tests.** Playwright E2E for spin/grant/fan flow; integration
      tests on `/api/spin` (the least-tested revenue code). (M, e2e-testing skill)
- [ ] **PWA / add-to-home.** manifest + service worker so the fan page installs
      and feels app-native on mobile. (M)
- [ ] **Win-back DM automation.** From the worklist, one-tap a saved DM template
      pre-filled with the dormant fan's link. (S, builds on CRM + dm_templates)

## 🧊 Back burner (your call — compliance/adult, deferred while testing 1 creator)
- Age verification beyond the checkbox (provider integration).
- Media watermarking / signed URLs / 2257 record-keeping.
- Instant-delivery explicit prize media (only with the above).
- Per-fan spend limits (explicitly NOT doing — we sell what you pay for).

## 🎯 Big bets (research plan → `RESEARCH_BIGBETS.md`)
1. **Agency console** — productize cross-account admin into a B2B multi-creator
   product with scoped VA seats.
2. **"Autopilot" action feed** — prescriptive daily to-dos (DM these whales, your
   hot slot is Tue 9pm, this prize is over-given).
3. **Compliance-as-a-moat** — verified-age + leak-resistant delivery as the
   reason serious creators/agencies pick FanFunnel.

Each big bet gets: problem framing → user/JTBD → data model sketch → phased
build → risks → success metric, in `RESEARCH_BIGBETS.md`.
