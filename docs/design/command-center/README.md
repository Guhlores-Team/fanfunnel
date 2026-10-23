# Handoff: FanFunnel Creator Command Center (Dashboard Redesign)

## Overview
A full redesign of the FanFunnel creator dashboard — the authenticated control panel where a
creator builds prize wheels, mints per-fan spin links, fulfils won prizes, runs campaigns/boosts,
chats with fans, and reads analytics. The redesign moves from a flat 8-tab horizontal bar to a
**grouped command-center** layout (left sidebar + top bar), fixes a tracked accessibility defect,
replaces emoji-as-icons with a line-icon set, and adds a surface-elevation visual system,
first-run/empty states, and a mobile layout.

## About the Design Files
The files in this bundle are **design references created in HTML** (Design Components). They are
prototypes that show the intended look, layout, and interaction — **not production code to copy
verbatim**. The task is to **recreate these designs inside the existing FanFunnel Next.js + React +
Tailwind codebase**, using its established components, hooks, data layer, and the
`src/app/globals.css` token system. Pull exact values (hex, spacing, radii, type) from this README.

Open the `.dc.html` files in a browser to interact with them. `FanFunnel Command Center.dc.html`
is desktop; `FanFunnel Mobile.dc.html` shows the phone layouts in a side-by-side canvas.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii, shadows, and interactions are all
intentional. Recreate pixel-for-pixel using the codebase's existing primitives (the `ui.tsx`
helpers, panel components, etc.). Where the prototype and the live app differ, the prototype is the
target — except for the **behavior spec** below, which marks what is real vs. mocked.

---

## Design Tokens

### Core palette (matches `src/app/globals.css`)
| Token | Value | Use |
|---|---|---|
| Base background | `#0c0a0e` | App canvas (tinted plum-charcoal, never pure black) |
| Surface raised (`--s1`) | `linear-gradient(180deg,#1c1825,#16131d)` | Primary cards |
| Surface recessed (`--s2`) | `#100d16` | Nested wells, inset areas |
| Input well | `#0c0a0e` | Text inputs inside cards |
| Hairline border (`--hair`) | `#241f2e` | Card borders |
| Secondary border | `#2a2533` | Inputs, chips, buttons |
| Text primary | `#f4f1f6` | Headings, values |
| Text muted | `#a09aa8` | Body, labels |
| Text faint | `#8b8494` / `#6b6472` | Captions, nav group labels |
| Brand (default) | `#ec4899` | Per-creator accent; CSS var `--brand` |
| Success | `#22c55e` | Positive deltas, fulfilled |
| Warning | `#f59e0b` / `#fcd34d` | Pending, unsaved |
| Danger | `#ef4444` / `#f87171` | Destructive actions |

### Elevation
- Card lift shadow (`--lift`): `0 1px 0 rgba(255,255,255,.045) inset, 0 14px 34px -26px rgba(0,0,0,.9)`
- The inset top-highlight + soft drop shadow is what makes cards read as raised. Apply to all
  primary cards; nested blocks use `--s2` with no shadow.

### Brand-adaptive foreground (**ACCESSIBILITY — important**)
`--brand` is creator-customizable, so a fixed white foreground fails WCAG on light brand colors
(this is the **tracked 3.52:1 white-on-brand defect**). The prototype computes a readable ink:
```
luminance(rgb) = 0.2126*L(r) + 0.7152*L(g) + 0.0722*L(b)   // L = sRGB→linear
contrast(a,b)  = (max(La,Lb)+0.05) / (min(La,Lb)+0.05)
brandInk = contrast(brand, white) >= contrast(brand, #160d12) ? "#ffffff" : "#160d12"
```
Use `brandInk` for **all** text/icons placed on a `--brand` fill (buttons, badges, pills, toggles).
For default pink it resolves to dark `#160d12` (~6:1, passes AA). Port this as a util
(e.g. `readableInk(hex)`).

### Rarity colors (matches `RARITY_COLORS` in `src/lib/games/wheel/types.ts`)
| Rarity | Hex |
|---|---|
| Common | `#6b7280` |
| Uncommon | `#22c55e` |
| Rare | `#3b82f6` |
| Epic | `#a855f7` |
| Legendary | `#f59e0b` |

### Typography
- **Geist** — all product UI (sidebar, panels, data). Weights 400–700.
- **Bricolage Grotesque** — reserved for brand surfaces / wordmark ONLY (do not use on data).
- Tabular numerals (`font-variant-numeric: tabular-nums`) on every metric, count, price, odds %.
- Scale: page title 22px/700; section header 15–16px/700 (with a 3px brand "tick" before it);
  card title 14–15px/600–700; body 13–13.5px; label/caption 11–12px uppercase tracked `.04em`.

### Radii & spacing
- Radii: cards 16px, rows 13px, inputs/buttons 9–10px, pills 999px, phone frame 46px.
- Page padding 28px; card padding 16–20px; grid/stack gaps 8–18px.
- Min tap target 36–44px (sidebar items 40px, mobile buttons 40–44px).

### Motion
- Entrance: `translateY(10px)→0`, .5s `cubic-bezier(.16,1,.3,1)`. **Never animate opacity 0→1 as the
  only reveal** — keep base `opacity:1` so content can't get stuck invisible.
- Hover lift: `translateY(-2px)` + brand-tinted border, .14–.16s.
- Drawer: slide-in from right .34s; toast: rise .26s, auto-dismiss ~2.4s.
- Respect `prefers-reduced-motion` (collapse durations).

---

## Screens / Views  → repo component map

The redesign maps onto your existing files. Recreate each screen by updating that component.

### Shell — sidebar + top bar  →  `src/components/dashboard/DashboardClient.tsx`
- **Left sidebar (252px)**: wordmark, workspace pill (avatar + handle + live dot), grouped nav,
  footer (Sign out). Nav groups: **Run** (Today, Inbox, Fulfilment), **Build** (Wheels, Campaigns),
  **Grow** (Fans, Boosts), **Measure** (Analytics), **Account** (Settings, Admin). Active item =
  brand-tinted bg + 3px left accent bar + `aria-current="page"`. Unread/queue counts as brand badges.
- **Top bar**: page title + context subtitle, search field, notification bell (with dot), primary
  "New fan link" button (brand fill, `brandInk` text). Sticky, blurred backdrop.

### Today  →  `src/components/dashboard/TodayPanel.tsx`
- **Pulse strip** (4 cards): Revenue / Spins / Active fans / To-fulfil. Each = label+icon, big
  tabular value, **sparkline** (absolute, bottom, ~45% opacity) + **trend chip** (▲% in a tinted
  pill) + muted note. Soft brand-glow bloom behind the strip.
- **"Needs you now"**: ranked priority cards (icon tile, title + impact tag, body, primary CTA →
  routes to the relevant section, dismiss ✕). Hover-lifts.

### First-run / empty account  →  `src/components/dashboard/GetStartedChecklist.tsx`
- When the account has no data: pulse cards show `$0/0/0/0` with muted "—" chips; the priority feed
  is replaced by **"Your first steps"** — a 5-item checklist (Create account ✓, Build first wheel,
  Mint first link, Share in bio, Fulfil first win) with progress count and per-step CTA. Sidebar
  badges hidden. Other sections show their empty states (below). In the prototype this is the
  `accountState: populated | new` tweak.

### Analytics  →  `src/components/dashboard/AnalyticsPanel.tsx` (+ `Sparkline.tsx`, `Funnel.tsx`, `CrmPanel.tsx`)
- 5-cell stat strip (hairline grid, recessed cells); Spins trend + Revenue trend cards (range
  toggle 14d/30d); "What's landing" (top prizes bars) + "Rarity mix" (stacked bar + legend);
  "Profit & prize costs" 4-cell grid.

### Wheels (editor)  →  `DashboardClient.tsx` WheelEditor + `Wheel.tsx`, `WheelSwitcher.tsx`, `OddsBar.tsx`, `PackEditor.tsx`, `PackPresets.tsx`, `TemplateLibrary.tsx`, `editorHelpers.ts`
- Wheel switcher chips (+ New wheel); unsaved-changes save bar; Title/Brand-color fields; **OddsBar**
  (proportional stacked bar); editable **prize cards** (drag handle in the corner only so text stays
  selectable; emoji, name, rarity pill that cycles, tickets, stock, cost, live odds %, color field);
  Add prize / Balance odds; **live canvas wheel** preview (radial-gradient wedges, labels, brand hub
  + pointer); prize/wheel library accordion. Empty wheel → "Add your first prize".
- **Odds math**: a prize's chance = its tickets ÷ Σ tickets; recompute live on every edit.

### Fulfilment  →  `DashboardClient.tsx` redemptions (+ `PendingClient.tsx`)
- Status filter chips (Pending/In progress/Fulfilled/Cancelled/All); redemption rows (emoji tile,
  prize, rarity·fan·time, status pill, action button that cycles Start→Fulfil→Reopen). Empty filter
  → "All clear here".

### Fans  →  `DashboardClient.tsx` fans + `FanDetailDrawer.tsx`, `ImportFans.tsx`, `QrButton.tsx`
- "Mint a fan link" form (handle, spins, $/spin, Create → prepends row); Search/Campaign/Tag
  filters; Import fans / Manage messages; fan rows (avatar, name, meta, tags, spins, copy-link).
  Click a row → **slide-out drawer**: 5 stats incl. Last active, Top-up/Copy/Message actions,
  removable tags + preset toggles, notes ("saved on click-away"), Wins-by-rarity, **By campaign**
  breakdown, Grant history, Pending prizes, Links, Block fan. Empty search → "No fans match".

### Campaigns  →  `src/components/dashboard/CampaignsPanel.tsx`
- Create form; per-campaign card with 8-cell stat grid, top-prize, pinned-wheel select, Spin packs
  / Rename / Delete. No campaigns → "No campaigns yet".

### Boosts  →  `src/components/dashboard/BoostsPanel.tsx`
- Link-in-bio (public `/c/` link + copy, **tip/buy-spins link**, **tagline** = the line shown on the
  public spin page); Public leaderboard toggle; Happy hours list; Wishlist demand; Referrals; Danger
  zone (Clear all data).

### Inbox  →  `src/components/dashboard/InboxPanel.tsx`
- Auto-messages bar + Enable alerts; thread list (avatar, name, last, unread badge); conversation
  pane (header, bubbles — own messages on brand w/ `brandInk`, fan messages on a light surface,
  composer with send on click/Enter). No threads → "No conversations yet". On mobile this is
  master→detail (list, tap opens conversation).

### Settings  →  account routes (`src/app/api/account/*`, `src/app/admin/page.tsx` for Admin)
- Profile (avatar, display name, handle, email, Save); Security (change password); Notification
  toggles.

### Admin  →  `src/app/admin/page.tsx`
- Cross-account stat strip; creator accounts list with Suspend/Reactivate + **Delete account** + New
  account. (Gate to admin role.)

### Mobile  →  responsive variants of the above (`FanFunnel Mobile.dc.html`)
- Sidebar → **bottom tab bar** (Today / Inbox / Wheels / Fans / More). Top bar compresses (avatar +
  title + bell). Pulse → 2×2 grid. Wheel editor stacks (wheel on top, prize cards below, sticky save
  bar). Fan detail → **bottom sheet** (grabber, slides up over dimmed list). Analytics/Campaigns →
  single column.

---

## Interactions & Behavior

### Real in the prototype (recreate as interactive)
Section nav; Inbox thread-switch + send (append, clear, Enter); Fulfilment filter + status cycle;
Fans search filter; Wheel prize add/remove/edit with **live odds recompute + wheel redraw**, rarity
cycle, balance; Campaign create/delete; Mint-fan-link prepends a row; Admin suspend/delete; Fan
drawer tag toggle + top-up; Today CTAs route + dismiss; leaderboard/notification toggles; toast +
clipboard on copy/save actions; brand-color live theming.

### Mocked in the prototype — wire to real services on port (do NOT ship the shortcut)
1. **Notifications** — bell is cosmetic; wire real notifications + web-push.
2. **Spin-pack quantity** — clicking a pack/qty must increment (e.g. 10-spins ×5 = 50), not replace.
3. **Realtime / no refresh** — all saves and brand-color changes must reflect immediately (optimistic
   update or subscription); never require a manual refresh.
4. **Debug console** — must be gated behind `?debug=1` AND admin role; not always-on.
5. **Onboarding persistence** — completing the tutorial must stay complete even if the wheel it was
   done on is later deleted/archived.
6. **Stock → odds** — while a prize has stock it keeps its ticket odds; when stock hits 0 it leaves
   the pool and remaining tickets renormalize. Reflect this in the editor.
7. **Provably-fair hash** — belongs on the public fan spin page, not this dashboard (a fan-page fix:
   the "next-spin commitment" hash currently clips under the wheel).

## State Management
Per-section: active section; inbox active thread + message lists + composer text; fulfilment filter
+ per-redemption status; wheel prizes array (emoji/label/rarity/color/tickets/stock/cost) with
derived odds; campaign list; fan overrides (tags, granted spins, notes); admin suspended/deleted
sets; toast message. Data fetching: wheels, prizes, fans, redemptions, campaigns, threads, analytics,
account — via your existing API routes under `src/app/api/*`. Brand color drives a `--brand` CSS var
on a root element.

## Assets
No external image assets — all icons are inline 1.7px-stroke line SVGs (replacing the prior
emoji-as-icons). Prize **content** emojis (🎬💋📸👑…) are data, not UI chrome, and stay. Fonts via
Google Fonts (Geist, Bricolage Grotesque). The wheel is drawn on `<canvas>`.

## Files
- `FanFunnel Command Center.dc.html` — desktop dashboard (all sections; `accountState` tweak toggles
  first-run; `brandColor` + `handle` tweaks).
- `FanFunnel Mobile.dc.html` — mobile layouts (Today, Inbox, Wheel editor, Fan bottom-sheet, bottom nav).
- `PORTING_CHECKLIST.md` — phased, PR-by-PR implementation plan (start here after this README).
- `screenshots/` — reference renders: 01 Today, 02 Analytics, 03 Wheels, 04 Fan drawer,
  05 First-run, 06 Mobile (Today/Inbox), 07 Mobile (Wheel/Fan sheet). Use for visual-diff QA.
- `support.js` — Design Component runtime (lets the `.dc.html` files open standalone in a browser).
