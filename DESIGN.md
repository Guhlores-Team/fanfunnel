# FanFunnel — Design System

## Theme
Premium, indulgent dark. Tinted plum-charcoal base (never pure black), one brand
accent that adapts per creator. Atmosphere from film grain + a radial brand glow,
not from gradients-on-everything.

## Color (tokens in `globals.css` via Tailwind v4 `@theme`)
| Token | Value | Use |
|---|---|---|
| `--color-base` | `#0c0a0e` | page background |
| `--color-surface` | `#16131c` | panels, inputs |
| `--color-surface-2` | `#1f1b27` | raised elements |
| `--color-ink` | `#f4f1f6` | primary text (passes 4.5:1) |
| `--color-muted` | `#a09aa8` | secondary text |
| `--color-line` | `#2a2533` | hairline borders |
| `--brand` | `#ec4899` (default) | per-creator accent; set inline per page |

Strategy: **Restrained** in the dashboard (accent = actions/state only); **Committed**
on the fan page (brand glow + accent carry the surface).

## Typography
- **Display** (brand surfaces only): Bricolage Grotesque, weights 500–800, tracking ≤ -0.02em.
- **Body / all product UI**: Geist. Do not use the display font for dashboard labels/data.
- **Numerals**: Geist Mono via `.tnum` (tabular) for any metric.
- Scale: fluid `clamp()` allowed on brand surfaces; fixed rem on product UI.

## Components
- `.btn-brand` — primary action: brand fill, top highlight, brand-tinted shadow, `active` press.
- `.card` — elevated surface: `--color-surface`, hairline `--color-line`, soft tinted shadow (no flat black).
- `.ff-input` — fields with a brand focus ring (3px brand-tinted).
- `.grain` / `.brand-glow` — page atmosphere helpers.
- Every interactive element ships default/hover/focus/active/disabled. Skeletons for loading, teaching empty states.

## Layout
- Mobile-first; `min-h-[100dvh]` + `env(safe-area-inset-*)` so content clears the notch.
- Break symmetry on brand surfaces; refined density on product surfaces. No identical 3-card grids, no hero-metric template.

## Motion
- 150–250ms ease-out on product UI; expressive but purposeful on brand surfaces.
- Full `prefers-reduced-motion` fallback (already global in `globals.css`).
