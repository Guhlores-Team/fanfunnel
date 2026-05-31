# Visual verification screenshots

Captured headlessly via Playwright (Chromium) against a production build
(`npm run build && npm run start`) in **demo mode**, after Phases 1–5 + Phase 6
roadmap + Wave 3 (realtime chat). Fan surfaces at mobile viewport (390×844 @2x);
dashboard at 1280×900. Regenerate with `node scripts/shots.mjs` (server on :3212).

| File | What it proves |
|---|---|
| `01-fan-spin.png` | Fan spin page renders (mobile), wheel + SPIN + spins-left |
| `02-fan-agegate.png` | #24 age-gate / ToS blocking modal (assert: dialog visible) |
| `03-fan-win-modal.png` | Win modal + **per-rarity gradient medallion** (photos removed) |
| `04-fan-chat.png` | 💬 spin-gated chat panel open |
| `05-share-card.png` | #3 `/share/<id>` card with medallion |
| `06-verify.png` | #23 `/verify/<id>` provably-fair, "Hash matches" |
| `07-leaderboard.png` | #6 public leaderboard (auto-opt-in on spin) |
| `08-dashboard.png` | Dashboard landing |
| `09-dash-01..08-*.png` | Every dashboard tab: Wheel, Fans, Prizes, Campaigns, Boosts, Inbox, Analytics, Metrics |
| `10-dash-mobile.png` | Dashboard on mobile (scrollable tab nav — bug #2 fix) |

Programmatic asserts logged at capture time: `AGEGATE_VISIBLE: true`,
`WIN_MODAL_VISIBLE: true`. Realtime subscription + browser Notification
permission require a live Supabase project + real browser and aren't covered
headlessly (logic builds + type-checks; demo exercises the polling fallback).
