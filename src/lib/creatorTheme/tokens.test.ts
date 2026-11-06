import assert from "node:assert";
import { contrastRatio, luminance, parseHex, readableInk, type RGB } from "@/lib/theme";
import { PRESET_BACKGROUNDS, THEME_BACKGROUNDS } from "./config";
import {
  MIN_TEXT_CONTRAST,
  NOIR_HI,
  NOIR_LO,
  PAGE_GRAIN_ALPHA,
  THEME_BASE,
  THEME_INK,
  THEME_MUTED,
  THEME_SURFACE,
  VELVET_DEEP,
  VELVET_MID,
  over,
  photoScrimAlpha,
  rotateHue,
  themeStyle,
  themeSurface,
  withGrain,
} from "./tokens";

// Per-creator theming: every text/background pairing on a themed page stays AA
// for ANY brand colour and ANY photo, by computation. These checks sweep the
// extremes (white, black, neon, greys, junk) plus 400 seeded random colours
// across every preset and the photo background.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}
const hex = (s: string) => parseHex(s)!;
const ink = hex(THEME_INK);
const muted = hex(THEME_MUTED);
const WHITE: RGB = { r: 255, g: 255, b: 255 };

const EXTREMES = [
  "#ffffff", "#000000", "#ffff00", "#00ffff", "#ff00ff", "#00ff00", "#ff0000", "#0000ff",
  "#fafafa", "#010101", "#808080", "#7f7f7f", "#ec4899", "#fde68a", "#a3e635", "#1e3a8a",
  "not-a-colour", "",
];
let seed = 0x5eed;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const RANDOM = Array.from({ length: 400 }, () =>
  "#" + [0, 0, 0].map(() => Math.floor(rand() * 256).toString(16).padStart(2, "0")).join("")
);
const BRANDS = [...EXTREMES, ...RANDOM];

// --- 1. Every colour every background can show keeps ink AND muted at AA -----
{
  let worstInk = Infinity;
  let worstMuted = Infinity;
  for (const bg of THEME_BACKGROUNDS) {
    for (const brand of BRANDS) {
      const plan = themeSurface(bg, brand);
      check(`${bg}/${brand}: has stops`, plan.stops.length > 0);
      for (const stop of plan.stops) {
        const worst = withGrain(stop, plan.grains);
        const ci = contrastRatio(ink, worst);
        const cm = contrastRatio(muted, worst);
        worstInk = Math.min(worstInk, ci);
        worstMuted = Math.min(worstMuted, cm);
        if (ci < MIN_TEXT_CONTRAST || cm < MIN_TEXT_CONTRAST) {
          assert.fail(`${bg}/${brand}: stop ${stop} fails (ink ${ci.toFixed(2)}, muted ${cm.toFixed(2)})`);
        }
        passed++;
        // Rarity / status pills tint the background with up to 16% of a colour
        // under ink text; white is the worst tint.
        const tinted = over(WHITE, 0.16, worst);
        check(`${bg}/${brand}: ink on a 16% tint of ${stop}`, contrastRatio(ink, tinted) >= MIN_TEXT_CONTRAST);
        // Translucent cards mix --color-surface with this colour: both ends
        // keep muted text AA, so every mix of them does (convexity).
        const card = over(hex(THEME_SURFACE), 0.4, worst);
        check(`${bg}/${brand}: muted on a 40% surface card over ${stop}`, contrastRatio(muted, card) >= MIN_TEXT_CONTRAST);
      }
      // Gradients paint the colours BETWEEN stops too: sample them (the
      // convexity argument says the stops are the worst; prove it on data).
      for (let i = 0; i + 1 < plan.stops.length; i++) {
        const a = hex(plan.stops[i]);
        const b = hex(plan.stops[i + 1]);
        for (let t = 0; t <= 1.0001; t += 0.05) {
          const mid = withGrain(
            "#" + [a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t]
              .map((v) => Math.round(v).toString(16).padStart(2, "0"))
              .join(""),
            plan.grains
          );
          if (contrastRatio(muted, mid) < MIN_TEXT_CONTRAST) assert.fail(`${bg}/${brand}: between-stop colour fails at t=${t}`);
          passed++;
        }
      }
    }
  }
  check("muted text is AA on the card surface itself", contrastRatio(muted, hex(THEME_SURFACE)) >= MIN_TEXT_CONTRAST);
  console.log(`  worst ink ${worstInk.toFixed(2)}:1, worst muted ${worstMuted.toFixed(2)}:1 across ${BRANDS.length} brands × ${THEME_BACKGROUNDS.length} backgrounds`);
}

// --- 2. Brand-coloured text is re-derived against the theme's lightest point --
{
  for (const bg of THEME_BACKGROUNDS) {
    for (const brand of BRANDS) {
      const { style, plan } = themeStyle({ background: bg }, brand, null);
      const s = style as Record<string, string>;
      const text = hex(s["--brand-text"]);
      for (const stop of plan.stops) {
        const c = contrastRatio(text, withGrain(stop, plan.grains));
        if (c < MIN_TEXT_CONTRAST) assert.fail(`${bg}/${brand}: --brand-text ${s["--brand-text"]} is ${c.toFixed(2)}:1 on ${stop}`);
        passed++;
      }
      // --brand-ink is still the better of the two inks on the brand fill.
      check(`${bg}/${brand}: brand-ink unchanged`, s["--brand-ink"] === readableInk(s["--brand"]));
      // The peak really is the lightest colour (rounded up, never under).
      const peakL = luminance(hex(s["--theme-bg-peak"]));
      check(
        `${bg}/${brand}: peak >= every stop`,
        plan.stops.every((st) => luminance(withGrain(st, plan.grains)) <= peakL + 1e-9)
      );
    }
  }
}

// --- 3. The photo scrim holds for a pure-white photo, and for any pixel -------
{
  const alpha = photoScrimAlpha();
  check("scrim alpha is a real fraction", alpha > 0.5 && alpha < 1);
  const scrim = hex(THEME_BASE);
  for (const px of ["#ffffff", "#ffff00", "#00ffff", "#ff0000", "#808080", "#000000"]) {
    const shown = over(scrim, alpha, hex(px));
    const worst = withGrain(
      "#" + [shown.r, shown.g, shown.b].map((v) => Math.ceil(v).toString(16).padStart(2, "0")).join(""),
      [PAGE_GRAIN_ALPHA]
    );
    check(`photo pixel ${px} under the scrim: ink AA`, contrastRatio(ink, worst) >= MIN_TEXT_CONTRAST);
    check(`photo pixel ${px} under the scrim: muted AA`, contrastRatio(muted, worst) >= MIN_TEXT_CONTRAST);
  }
  const s = themeStyle({ background: "photo" }, "#ffffff", null).style as Record<string, string>;
  check("photo theme exposes --theme-scrim", /^rgba\(12, 10, 14, 0\.\d+\)$/.test(s["--theme-scrim"]));
  console.log(`  photo scrim alpha ${alpha}`);
}

// --- 4. The CSS we emit is built from hex colours only (no url(), no input) ---
{
  for (const bg of THEME_BACKGROUNDS) {
    for (const brand of [...EXTREMES, "url(https://evil.example/x.png)", "red;background:url(x)", "#fff;}body{display:none"]) {
      const s = themeStyle({ background: bg }, brand, null).style as Record<string, string>;
      for (const [k, v] of Object.entries(s)) {
        if (typeof v !== "string") continue;
        check(`${bg}/${JSON.stringify(brand)}: ${k} has no url()`, !/url\s*\(/i.test(v));
        check(`${bg}/${JSON.stringify(brand)}: ${k} has no ; { }`, !/[;{}]/.test(v));
      }
      check(
        `${bg}: --theme-background uses only gradients, hex colours and numbers`,
        /^[a-z0-9#%(),.\s-]+$/.test(s["--theme-background"]) && !/url/.test(s["--theme-background"])
      );
      check(`${bg}: a junk brand falls back to the default brand`, /^#[0-9a-f]{6}$/i.test(s["--brand"]));
    }
  }
}

// --- 5. Presets look like themselves; the default glow keeps today's strength -
{
  const glow = themeSurface("glow", "#ec4899");
  check("default pink glow keeps its full 24% tint", glow.stops[0] !== THEME_BASE && glow.stops[0] === mixPct("#ec4899", 24));
  const white = themeSurface("glow", "#ffffff");
  check("a white brand gets a quieter glow", luminance(hex(white.stops[0])) < luminance(hex(mixPct("#ffffff", 24))));
  check("noir ignores the brand", JSON.stringify(themeSurface("noir", "#ff0000").stops) === JSON.stringify([NOIR_HI, NOIR_LO]));
  check("noir carries the extra grain", themeSurface("noir", "#ec4899").grains.length === 2);
  check("velvet carries its fixed plum", themeSurface("velvet", "#000000").stops.includes(VELVET_MID));
  check("velvet's tint starts from its deep plum", themeSurface("velvet", VELVET_DEEP).stops[0] === VELVET_DEEP);
  check("solid is a single flat colour", themeSurface("solid", "#1e3a8a").stops.length === 1);
  check("aurora uses two hues", new Set(themeSurface("aurora", "#22d3ee").stops).size === 3);
  check("rotateHue keeps greys grey", rotateHue("#808080", 140) === "#808080");
  check("rotateHue moves red toward green-cyan", rotateHue("#ff0000", 120) === "#00ff00");
  check("every preset is listed", PRESET_BACKGROUNDS.length === THEME_BACKGROUNDS.length - 1);
  const font = themeStyle({ background: "glow" }, "#ec4899", "'Syne', 'Syne Fallback'").style as Record<string, string>;
  check("a chosen font drives --ff-display and --theme-display", font["--ff-display"] === "'Syne', 'Syne Fallback'" && font["--theme-display"] === font["--ff-display"]);
  check("a chosen font also overrides inherited --font-display for public headings", font["--font-display"] === "'Syne', 'Syne Fallback', ui-sans-serif, system-ui, sans-serif");
  const none = themeStyle({ background: "glow" }, "#ec4899", null).style as Record<string, string>;
  check("the default font leaves --ff-display alone", !("--ff-display" in none) && none["--theme-display"] === "var(--ff-display)");
  check("default public headings inherit the app font with fallbacks", none["--font-display"] === "var(--ff-display), ui-sans-serif, system-ui, sans-serif");
}

function mixPct(brand: string, pct: number): string {
  const b = hex(brand);
  const base = hex(THEME_BASE);
  const t = pct / 100;
  return "#" + [b.r * t + base.r * (1 - t), b.g * t + base.g * (1 - t), b.b * t + base.b * (1 - t)]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("");
}

console.log(`creatorTheme/tokens.test.ts: ${passed} checks passed`);
