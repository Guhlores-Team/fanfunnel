# FanFunnel — Design System

## Theme
Premium, indulgent dark. Tinted plum-charcoal base (never pure black), one brand
accent that adapts per creator. Atmosphere from film grain + a radial brand glow,
not from gradients-on-everything. The creator dashboard is the **Command Center**:
a grouped sidebar shell on desktop, a bottom tab bar on phones.

## Color (tokens in `globals.css` via Tailwind v4 `@theme`)
| Token | Value | Use |
|---|---|---|
| `--color-base` | `#0c0a0e` | page background, input wells |
| `--color-surface` | `#16131c` | panels, inputs |
| `--color-surface-2` | `#1f1b27` | raised elements, skeleton highlight |
| `--color-ink` | `#f4f1f6` | primary text (passes 4.5:1) |
| `--color-muted` | `#a09aa8` | secondary text |
| `--color-line` | `#2a2533` | hairline borders, inputs |
| `--brand` | `#ec4899` (default) | per-creator accent; set inline per page |
| `--brand-ink` | `readableInk(--brand)` | text/icons ON a brand fill (dark `#160d12` on pink) |
| `--brand-text` | `brandText(--brand)` | brand used AS text (`.text-brand`), ≥ 4.5:1 on base |

Elevation (Command Center): `--s1` raised card gradient, `--s2` recessed well,
`--hair` card hairline, `--lift` inset highlight + soft drop. Use `.surface-raised` /
`.surface-recessed`; nested blocks are wells, never cards-in-cards.

Always set brand through `brandVars(color)` (`src/lib/theme.ts`) so `--brand-ink` and
`--brand-text` follow it. The dashboard shell binds it to the editor's wheel, so a new
brand colour re-tints everything live.

Strategy: **Restrained** in the dashboard (accent = actions/state only); **Committed**
on the fan page (brand glow + accent carry the surface).

## Typography
- **Display** (brand surfaces only): Bricolage Grotesque, weights 500–800, tracking ≤ -0.02em.
- **Body / all product UI**: Geist. Do not use the display font for dashboard labels/data.
- **Numerals**: Geist Mono via `.tnum` (tabular) for any metric.
- Scale: fluid `clamp()` allowed on brand surfaces; fixed px/rem on product UI
  (section title 22px, card title 14–15px, labels 10.5–11px uppercase, body 13–13.5px).

## Components
- `.btn-brand` — primary action: brand fill, `--brand-ink` text, top highlight, press.
- `.card` — legacy elevated surface; Command Center panels use `.surface-raised`.
- `.ff-input` — fields with a brand focus ring (3px brand-tinted); `aria-invalid` turns it red.
- `.skeleton` — shimmer for every loading state. `.grain` / `.brand-glow` — atmosphere.
- Count badges: brand fill + `--brand-ink`, hidden at 0. Initials avatars: **ink** on a
  16–18% brand tint (brand-as-text drops below 4.5:1 on its own tint).
- Every interactive element ships default/hover/focus/active/disabled. Skeletons for
  loading, teaching empty states, two-step inline confirms for destructive actions
  (typed confirm for account reset and admin delete).

## Shell (`DashboardShell.tsx`, `DashboardClient.tsx`)
- **Sidebar** (`lg`+, 252px, sticky): wordmark, workspace pill (display name + email or
  the demo notice), grouped nav — Run (Today, Inbox, Fulfilment) · Build (Wheels,
  Campaigns) · Grow (Fans, Boosts) · Measure (Analytics) · Account (Settings, Admin) —
  footer with "Get started" (when dismissed, not done) and Sign out (form POST).
- Nav items are buttons with `aria-current="page"`, one Tab stop + Arrow/Home/End
  (roving tabindex). Active = 13% brand tint + 3px accent bar. Badges: Fulfilment
  (`metrics.pending`, a server count) and Inbox (unread).
- **Admin** exists only when the server says so (`is_admin()` via `checkAdmin`); never
  client state. Every `/api/admin` route re-checks.
- **Top bar** (sticky, blurred): section title + subtitle, fan search (`md`+, routes to
  the Fans filter), notification bell, "New fan link" (focuses the Fans mint form).
- Sections render in one `role="region"` named after the section; Campaigns, Inbox,
  Boosts, Settings, Admin and the deep Analytics are code-split with a skeleton fallback.

## Sections
Today (pulse strip, "Your first steps" for new creators, ranked "Needs you now"),
Inbox (auto-messages, threads, composer with quick replies/retry), Fulfilment (status
chips, search, rows with note/due/Cancel prize inline, pagination), Wheels (chips with
"Set active" + ⋯ Manage menu, Schedule card, editor + live `<Wheel>` preview, library),
Campaigns, Fans (mint form, filters, rows → drawer), Boosts, Analytics (designed cards,
then Profit, Audience, Timing), Settings (Profile, Public page, Security,
Notifications), Admin.

## Mobile (below `lg`)
- **Bottom tab bar** (`MobileTabBar.tsx`, fixed, 60px + safe area): Today · Inbox ·
  Wheels · Fans · More. It is the "Dashboard sections" nav at this width.
- **More sheet** (`MoreSheet.tsx`): every other section in sidebar order (Admin gated),
  Get started, Sign out. The More button shows the summed badge and reads as current
  when its section is open.
- **Bottom sheets**: the fan drawer and modals slide up from the bottom; the grabber
  drags to dismiss (`useSheetDrag`), Esc and Close always work.
- Bottom-fixed UI (toasts, the debug launcher, the wheel save bar) sits above the bar
  via `--ff-bottom-offset`; content reserves 60px. The bell panel opens under the top
  bar and stays above the tab bar.
- Compressed top bar: avatar, title, bell, "+" (New fan link).

## Layout
- Mobile-first; `min-h-[100dvh]` + `env(safe-area-inset-*)` so content clears the notch.
- No horizontal page scroll at 360px; wide tables scroll inside their card.
- Break symmetry on brand surfaces; refined density on product surfaces. No identical
  3-card grids, no hero-metric template.

## Motion
- Product UI: 150–250ms ease-out colour/border transitions; hover lift −2px on cards.
- Entrances are transform-only (`.lift-in`, 10px → 0 over .5s, `cubic-bezier(.16,1,.3,1)`):
  base opacity stays 1, so nothing can stick invisible. Toasts use it too.
- Drawer/sheets: `.drawer-in` (slide in from the right on `lg`, up from the bottom
  below), backdrop `.fade-in` .2s. Modals: `.modal-in`.
- Toasts: 3.5s (not the prototype's 2.4s, so the prize-removal Undo stays usable).
- Full `prefers-reduced-motion` fallback (global clamp in `globals.css`); JS smooth
  scrolling checks `prefersReducedMotion()`.

## Accessibility rules
- WCAG 2.1 AA, enforced by `npm run e2e:a11y` (axe, serious/critical block — contrast
  included — on every section, overlay and modal at desktop and phone width) and the
  first-run axe step in `npm run e2e`.
- `:focus-visible` ring (2px brand outline) on everything; inputs use the brand ring.
- Modals, the fan drawer and the More sheet are focus-trapped (`useFocusTrap`): Esc
  closes, focus returns to the trigger. Menus (wheel Manage, Copy DM) land on the
  first item, move with Arrow/Home/End, and hand focus back on Esc. The bell is a
  non-modal popover: Esc returns to the bell, tabbing out closes it.
- Counts are announced ("2 waiting", "1 unread"); icon-only buttons have labels.
