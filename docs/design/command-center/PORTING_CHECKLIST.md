# Porting Checklist — FanFunnel Dashboard Redesign

A phased, PR-by-PR plan for implementing this redesign in the `fanfunnel` Next.js repo. Each phase is
a reviewable PR. Work on a branch off `main` (e.g. `dashboard-redesign`). Check items as you go.
Pair this with `README.md` (exact tokens, component map, behavior spec).

---

## Phase 0 — Setup
- [ ] Branch `dashboard-redesign` off `main`.
- [ ] Read `README.md` end-to-end; open both `.dc.html` files in a browser for reference.
- [ ] Confirm scope of the 7 behavior-spec items (which land now vs. follow-up).

## Phase 1 — Token & accessibility foundation  (do first; everything depends on it)
File: `src/app/globals.css` (+ a small util module)
- [ ] Add elevation tokens: `--s1` (raised gradient), `--s2` (recessed), `--hair`, `--lift` shadow.
- [ ] Confirm/centralize base palette + `--brand` plumbing per creator.
- [ ] Add `readableInk(hex)` util (WCAG-contrast white vs `#160d12`) and use it wherever text/icons
      sit on a `--brand` fill. **This closes the tracked 3.52:1 contrast defect.**
- [ ] Verify rarity colors match `src/lib/games/wheel/types.ts`.
- [ ] Add `:focus-visible` rings, `prefers-reduced-motion` handling.
- [ ] Adopt a line-icon set (replace emoji-as-UI). Keep prize *content* emojis.

## Phase 2 — Shell (sidebar + top bar)  →  `DashboardClient.tsx`
- [ ] Left sidebar (252px): wordmark, workspace pill, grouped nav (Run / Build / Grow / Measure /
      Account), footer.
- [ ] Active state: brand-tinted bg + 3px accent bar + `aria-current="page"`; brand count badges.
- [ ] Sticky top bar: title + subtitle, search, bell, "New fan link".
- [ ] Route each nav item; preserve existing data wiring.

## Phase 3 — Today  →  `TodayPanel.tsx`
- [ ] Pulse strip (4 cards): value + sparkline + trend chip + note; brand-glow bloom behind.
- [ ] "Needs you now" ranked priority cards (icon, impact tag, CTA→section, dismiss); hover-lift.

## Phase 4 — Panels (can be parallel PRs)
- [ ] **Analytics** → `AnalyticsPanel.tsx` (+ `Sparkline`, `Funnel`, `CrmPanel`): stat strip, trend
      cards, what's-landing, rarity mix, profit grid.
- [ ] **Wheels** → WheelEditor in `DashboardClient` + `Wheel.tsx`, `WheelSwitcher`, `OddsBar`,
      `PackEditor`, `PackPresets`, `TemplateLibrary`, `editorHelpers.ts`: switcher, save bar, fields,
      odds bar, editable prize cards (corner drag handle), **live canvas wheel**, library. Odds =
      tickets ÷ Σtickets, recompute live.
- [ ] **Fulfilment** → redemptions (+ `PendingClient`): filter chips, rows, status cycle.
- [ ] **Fans** → fans list + `FanDetailDrawer`, `ImportFans`, `QrButton`: mint form, filters, rows,
      slide-out drawer (stats, actions, tags, notes, wins, by-campaign, grants, links, block).
- [ ] **Campaigns** → `CampaignsPanel.tsx`: create, stat-grid cards, pinned-wheel, packs/rename/delete.
- [ ] **Boosts** → `BoostsPanel.tsx`: link-in-bio (public link + tip link + tagline), leaderboard
      toggle, happy hours, wishlist, referrals, danger zone.
- [ ] **Inbox** → `InboxPanel.tsx`: auto-messages, thread list, conversation, composer (send + Enter).
- [ ] **Settings / Admin** → account routes + `src/app/admin/page.tsx`: profile, security,
      notifications; admin accounts with suspend/delete (role-gated).

## Phase 5 — Empty & first-run states
- [ ] Per-section empty states (Fulfilment, Fans, Campaigns, Inbox, empty wheel).
- [ ] First-run dashboard: zeroed pulse + "Your first steps" checklist →
      `GetStartedChecklist.tsx`; hide sidebar count badges when no data.

## Phase 6 — Mobile  (`FanFunnel Mobile.dc.html`)
- [ ] Sidebar → bottom tab bar (Today/Inbox/Wheels/Fans/More); compressed top bar.
- [ ] Today pulse 2×2; panels single-column; wheel editor stacked w/ sticky save bar.
- [ ] Fan detail → bottom sheet. Analytics tables horizontally scroll or restack.

## Phase 7 — Behavior wiring (the mocked items)
- [ ] Notifications fire + web-push.
- [ ] Spin-pack quantity increments (10×5 = 50), not replace.
- [ ] Realtime / no-refresh: saves + brand-color reflect immediately.
- [ ] Debug console gated behind `?debug=1` AND admin role.
- [ ] Onboarding stays complete if its wheel is deleted/archived.
- [ ] Stock→odds: out-of-stock prize leaves pool, remaining tickets renormalize.
- [ ] (Fan page, separate) provably-fair "next-spin commitment" hash no longer clips under wheel.

## Phase 8 — QA
- [ ] axe/Lighthouse: AA contrast (incl. brand buttons), focus order, reduced-motion.
- [ ] Responsive sweep 360 → 1440px.
- [ ] Keyboard nav through nav, drawer, composer, editor.
- [ ] Visual diff vs. the screenshots in `screenshots/`.
