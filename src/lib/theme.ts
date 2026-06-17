// Brand-color theming helpers.
//
// Each creator picks a brand color applied via the CSS var --brand. A poorly
// chosen color (too light, too dark) makes text ON the brand fill — or the brand
// color used AS text — unreadable. These helpers derive companion vars so text
// stays legible on ANY brand color:
//   --brand       the chosen color (unchanged)
//   --brand-ink   #fff or #111 — whichever is readable as text ON the brand fill
//   --brand-text  the brand color nudged lighter until it's legible as TEXT on
//                 the dark app surface (fixes washed-out odds/weight labels)
//
// Pure, dependency-free, SSR-safe (no DOM), and unit-tested so the contrast
// guarantees can't silently regress.

import type { CSSProperties } from "react";

/** App's darkest surface (globals.css --color-base) — what brand-as-text sits on. */
const APP_BASE = "#0c0a0e";
/** Fallback brand if a creator's value is missing/invalid (globals.css default). */
export const DEFAULT_BRAND = "#ec4899";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const BLACK: RGB = { r: 17, g: 17, b: 17 }; // #111
const WHITE: RGB = { r: 255, g: 255, b: 255 };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Parse #rgb / #rrggbb (with or without leading #). Returns null if unparseable. */
export function parseHex(input: string | null | undefined): RGB | null {
  if (!input) return null;
  let h = input.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: RGB): string {
  const h = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(c: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast ratio between two colors (1 .. 21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * #fff or #111 — whichever is readable as text ON the given fill color.
 *
 * --brand-ink labels large, bold text on the brand fill (buttons), so AA-large
 * (3:1) is the bar. We prefer white (the established brand look) whenever it
 * clears that bar, and only fall back to dark text when white would be too faint
 * (e.g. a light-yellow brand). This keeps the default pink button white while
 * fixing the genuinely unreadable cases.
 */
export function readableInk(color: string): string {
  const rgb = parseHex(color) ?? parseHex(DEFAULT_BRAND)!;
  const cWhite = contrastRatio(rgb, WHITE);
  const cBlack = contrastRatio(rgb, BLACK);
  if (cWhite >= 3) return "#ffffff";
  return cBlack > cWhite ? "#111111" : "#ffffff";
}

/**
 * The brand color adjusted so it's legible as TEXT on the dark app surface.
 * Returns it unchanged when it already meets `min` contrast on --color-base;
 * otherwise mixes it toward white (preserving hue) until it does. This is what
 * fixes brand-colored accent text (odds, weights, ×multiplier) going invisible
 * when a creator picks a dark brand color.
 */
export function brandText(color: string, min = 4.5): string {
  const base = parseHex(APP_BASE)!;
  const rgb = parseHex(color) ?? parseHex(DEFAULT_BRAND)!;
  if (contrastRatio(rgb, base) >= min) return toHex(rgb);
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const mixed: RGB = {
      r: rgb.r + (255 - rgb.r) * t,
      g: rgb.g + (255 - rgb.g) * t,
      b: rgb.b + (255 - rgb.b) * t,
    };
    if (contrastRatio(mixed, base) >= min) return toHex(mixed);
  }
  return "#ffffff";
}

/**
 * CSS custom properties to spread into a `style={}` so brand text stays readable.
 * Use everywhere we currently write `style={{ "--brand": color }}`.
 *
 *   <div style={brandVars(creator.brandColor)}>…</div>
 */
export function brandVars(color: string | null | undefined): CSSProperties {
  const safe = parseHex(color) ? (color as string) : DEFAULT_BRAND;
  return {
    ["--brand"]: safe,
    ["--brand-ink"]: readableInk(safe),
    ["--brand-text"]: brandText(safe),
  } as CSSProperties;
}
