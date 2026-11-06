// Theme tokens: turn a creator's theme keys + brand colour into CSS custom
// properties and a background whose readability is COMPUTED, not assumed.
//
// The fan page and the link-in-bio page keep the app's light-on-dark text
// (--color-ink, --color-muted). So the guarantee is about the background:
// every colour a background can show (each gradient stop, each layer, plus the
// film grain painted over it at its worst) must keep BOTH ink and muted text at
// >= MIN_TEXT_CONTRAST. Why checking only those colours is enough:
//   * a gradient or a stack of translucent layers paints convex combinations of
//     its stop colours, and WCAG luminance is convex in sRGB, so the lightest
//     pixel is always one of the stops;
//   * grain (white noise at a small alpha) is worst when the noise is white,
//     and luminance only grows with each channel, so compositing white at the
//     grain's alpha onto each stop is the exact worst case;
//   * an uploaded photo can be anything, so its worst pixel is pure white, and
//     the scrim's alpha is solved so even white behind it stays readable.
// Brand-derived colours are mixed toward the base until they pass, so a white
// or neon brand gets a quieter glow instead of unreadable text. The same worst
// colour also re-derives --brand-text (theme.ts), so brand-coloured text stays
// AA on the lightest point of the themed page.
//
// RM-7's game renderers (scratch, bingo) read the exported CSS variables:
//   --theme-bg        the flat base colour of the page background
//   --theme-bg-peak   the LIGHTEST colour any part of the background can show
//   --theme-ink       primary text (>= 4.5:1 on every background colour)
//   --theme-muted     secondary text (>= 4.5:1 on every background colour)
//   --theme-surface   card surface (darker than the background, so text stays AA)
//   --theme-display   the creator's headline font stack (also --ff-display)
//   --theme-background the full CSS background (built only from hex colours here)
//   --theme-scrim     the photo scrim colour (photo background only)
// plus --brand / --brand-ink / --brand-text from brandVars().
//
// Pure and SSR-safe; unit-tested in tokens.test.ts across extreme brand colours.

import type { CSSProperties } from "react";
import { APP_BASE, brandVars, contrastRatio, luminance, parseHex, toHex, type RGB } from "@/lib/theme";
import type { CreatorTheme, PresetBackground, ThemeBackground } from "./config";

export const THEME_INK = "#f4f1f6"; // globals.css --color-ink
export const THEME_MUTED = "#a09aa8"; // globals.css --color-muted
export const THEME_SURFACE = "#16131c"; // globals.css --color-surface
export const THEME_BASE = APP_BASE; // globals.css --color-base
/** WCAG AA for body text. */
export const MIN_TEXT_CONTRAST = 4.5;
/** Solved to this (a hair above AA) so browser dithering can't tip a pixel under. */
const TARGET_CONTRAST = 4.6;
/** globals.css .grain::before opacity; every themed page carries it. */
export const PAGE_GRAIN_ALPHA = 0.045;
/** "Grain noir" adds a second, heavier grain layer. */
export const NOIR_GRAIN_ALPHA = 0.06;

const WHITE: RGB = { r: 255, g: 255, b: 255 };

function rgb(hex: string): RGB {
  return parseHex(hex) ?? parseHex(THEME_BASE)!;
}

/** Source-over: `top` at `alpha` over `under` (sRGB, like the browser). */
export function over(top: RGB, alpha: number, under: RGB): RGB {
  return {
    r: top.r * alpha + under.r * (1 - alpha),
    g: top.g * alpha + under.g * (1 - alpha),
    b: top.b * alpha + under.b * (1 - alpha),
  };
}

/** `a` moved toward `b` by t (0 = a, 1 = b), rounded to a real hex colour. */
export function mixHex(a: string, b: string, t: number): string {
  return toHex(over(rgb(b), t, rgb(a)));
}

/** The worst (lightest) a colour can look once every grain layer is painted on it. */
export function withGrain(color: string, grains: readonly number[]): RGB {
  let c = rgb(color);
  for (const a of grains) c = over(WHITE, a, c);
  return c;
}

/** True when ink AND muted text keep the target contrast on `color` (+ grain). */
export function readableBehindText(color: string, grains: readonly number[], min = TARGET_CONTRAST): boolean {
  const worst = withGrain(color, grains);
  return contrastRatio(rgb(THEME_INK), worst) >= min && contrastRatio(rgb(THEME_MUTED), worst) >= min;
}

/**
 * `base` moved toward `target` by the LARGEST amount <= maxT that keeps text
 * readable. A dark or mid brand gets its full glow; white or neon gets less.
 */
export function fitTint(base: string, target: string, maxT: number, grains: readonly number[]): string {
  for (let i = Math.round(maxT * 100); i >= 0; i--) {
    const c = mixHex(base, target, i / 100);
    if (readableBehindText(c, grains)) return c;
  }
  return base;
}

/** Rotate a colour's hue by `deg` (HSL), keeping saturation and lightness. */
export function rotateHue(hex: string, deg: number): string {
  const { r, g, b } = rgb(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return toHex({ r, g, b });
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex({ r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 });
}

export interface ThemeSurfacePlan {
  /** The CSS `background` value (hex colours and gradients only). */
  background: string;
  /** The flat base colour (also the overscroll colour). */
  base: string;
  /** Every colour the background can show; the contrast guarantee covers each. */
  stops: string[];
  /** Grain layers painted over the background (alphas, worst-case white). */
  grains: number[];
  /** Photo background only: the scrim colour and alpha over the photo. */
  scrim: { color: string; alpha: number } | null;
}

/** Velvet's fixed deep plum and noir's fixed charcoal (contrast-tested too). */
export const VELVET_DEEP = "#2a0f22";
export const VELVET_MID = "#14080f";
export const NOIR_HI = "#1a191e";
export const NOIR_LO = "#070608";

/**
 * The scrim alpha that keeps text readable over ANY photo: solved against a
 * pure-white pixel behind the scrim (the worst a photo can be).
 */
export function photoScrimAlpha(scrim: string = THEME_BASE, grains: readonly number[] = [PAGE_GRAIN_ALPHA]): number {
  for (let i = 50; i <= 100; i++) {
    const a = i / 100;
    if (readableBehindText(toHex(over(rgb(scrim), a, WHITE)), grains)) return a;
  }
  return 1;
}

/** The background plan for one preset (or the photo) and brand colour. */
export function themeSurface(background: ThemeBackground, brandColor: string): ThemeSurfacePlan {
  const brand = parseHex(brandColor) ? brandColor : "#ec4899";
  const B = THEME_BASE;
  const page = [PAGE_GRAIN_ALPHA];
  switch (background as PresetBackground | "photo") {
    case "velvet": {
      const v1 = fitTint(VELVET_DEEP, brand, 0.3, page);
      return {
        background: `radial-gradient(120% 80% at 50% -10%, ${v1} 0%, ${VELVET_MID} 55%, ${B} 100%)`,
        base: B,
        stops: [v1, VELVET_MID, B],
        grains: page,
        scrim: null,
      };
    }
    case "noir": {
      const grains = [PAGE_GRAIN_ALPHA, NOIR_GRAIN_ALPHA];
      return {
        background: `radial-gradient(130% 90% at 50% 0%, ${NOIR_HI} 0%, ${NOIR_LO} 70%)`,
        base: NOIR_LO,
        stops: [NOIR_HI, NOIR_LO],
        grains,
        scrim: null,
      };
    }
    case "aurora": {
      const a1 = fitTint(B, brand, 0.3, page);
      const a2 = fitTint(B, rotateHue(brand, 140), 0.26, page);
      return {
        background:
          `radial-gradient(55% 45% at 12% 8%, ${a1} 0%, transparent 70%), ` +
          `radial-gradient(50% 45% at 88% 18%, ${a2} 0%, transparent 70%), ${B}`,
        base: B,
        stops: [a1, a2, B],
        grains: page,
        scrim: null,
      };
    }
    case "solid": {
      const s = fitTint(B, brand, 0.6, page);
      return { background: s, base: s, stops: [s], grains: page, scrim: null };
    }
    case "photo": {
      const alpha = photoScrimAlpha(B, page);
      // The scrim over a white pixel is the worst case; over darker pixels it
      // is darker still. Both bounds are listed so tests cover the range.
      return {
        background: B,
        base: B,
        stops: [toHex(over(rgb(B), alpha, WHITE)), B],
        grains: page,
        scrim: { color: B, alpha },
      };
    }
    case "glow":
    default: {
      const g = fitTint(B, brand, 0.24, page);
      return {
        background: `radial-gradient(60% 50% at 50% 12%, ${g} 0%, ${B} 70%), ${B}`,
        base: B,
        stops: [g, B],
        grains: page,
        scrim: null,
      };
    }
  }
}

/** The lightest colour the background can show, grain included (as hex). */
export function peakColor(plan: ThemeSurfacePlan): string {
  let best = rgb(plan.stops[0]);
  let bestL = -1;
  for (const s of plan.stops) {
    const w = withGrain(s, plan.grains);
    const l = luminance(w);
    if (l > bestL) {
      bestL = l;
      best = w;
    }
  }
  // Round UP each channel so the peak is never darker than the real worst.
  return toHex({ r: Math.ceil(best.r), g: Math.ceil(best.g), b: Math.ceil(best.b) });
}

/**
 * Everything a themed page spreads into `style`: brand vars (with --brand-text
 * re-derived against the theme's lightest colour), the theme tokens above, and
 * the creator's headline font. `fontFamily` comes from fonts.ts (a next/font
 * family name), never from user input.
 */
export function themeStyle(
  theme: Pick<CreatorTheme, "background">,
  brandColor: string | null | undefined,
  fontFamily: string | null
): { style: CSSProperties; plan: ThemeSurfacePlan } {
  const brand = brandColor && parseHex(brandColor) ? brandColor : "#ec4899";
  const plan = themeSurface(theme.background, brand);
  const peak = peakColor(plan);
  const display = fontFamily ?? "var(--ff-display)";
  const style: Record<string, string> = {
    ...(brandVars(brand, peak) as Record<string, string>),
    "--theme-bg": plan.base,
    "--theme-bg-peak": peak,
    "--theme-ink": THEME_INK,
    "--theme-muted": THEME_MUTED,
    "--theme-surface": THEME_SURFACE,
    "--theme-display": display,
    "--font-display": `${display}, ui-sans-serif, system-ui, sans-serif`,
    "--theme-background": plan.background,
    backgroundColor: plan.base,
  };
  if (fontFamily) style["--ff-display"] = fontFamily;
  if (plan.scrim) {
    const c = rgb(plan.scrim.color);
    style["--theme-scrim"] = `rgba(${c.r}, ${c.g}, ${c.b}, ${plan.scrim.alpha})`;
  }
  return { style: style as CSSProperties, plan };
}
