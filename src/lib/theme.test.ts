import assert from "node:assert";
import {
  parseHex,
  contrastRatio,
  readableInk,
  brandText,
  brandVars,
  DEFAULT_BRAND,
  APP_BASE,
  brandUi,
  checkBrandColor,
} from "./theme";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const base = parseHex("#0c0a0e")!;

// --- parseHex ------------------------------------------------------------
{
  check(
    "parseHex parses 6-digit",
    JSON.stringify(parseHex("#ec4899")) === JSON.stringify({ r: 236, g: 72, b: 153 })
  );
  check(
    "parseHex parses 3-digit shorthand",
    JSON.stringify(parseHex("#fff")) === JSON.stringify({ r: 255, g: 255, b: 255 })
  );
  check("parseHex tolerates missing hash", parseHex("ec4899") !== null);
  check("parseHex rejects garbage", parseHex("nope") === null);
  check("parseHex rejects empty/null", parseHex("") === null && parseHex(null) === null);
}

// --- readableInk: pick the HIGHER-contrast ink (white vs dark #160d12) -------
{
  const DARK_INK = "#160d12";
  check("light yellow brand -> dark ink", readableInk("#f5d90a") === DARK_INK);
  check("deep purple brand -> white ink", readableInk("#4a1d96") === "#ffffff");
  // The tracked defect: white-on-default-pink is only 3.52:1, so the fix flips
  // it to dark ink (~6:1, passes AA for normal text).
  check("default pink -> dark ink (fixes 3.52:1 defect)", readableInk(DEFAULT_BRAND) === DARK_INK);
  check(
    "default pink + chosen ink clears AA (>=4.5:1)",
    contrastRatio(parseHex(DEFAULT_BRAND)!, parseHex(readableInk(DEFAULT_BRAND))!) >= 4.5
  );
  check("white brand -> dark ink", readableInk("#ffffff") === DARK_INK);
  check("black brand -> white ink", readableInk("#000000") === "#ffffff");
  check("invalid color falls back readable", readableInk("garbage") === readableInk(DEFAULT_BRAND));
}

// --- brandText: legible as TEXT on the dark app surface ------------------
{
  const darkBrand = brandText("#4a1d96");
  check("dark brand text is lightened", darkBrand !== "#4a1d96");
  check(
    "dark brand text reaches >=4.5 contrast on base",
    contrastRatio(parseHex(darkBrand)!, base) >= 4.5 - 1e-6
  );
  const pink = brandText(DEFAULT_BRAND);
  check(
    "pink brand text is already legible on base",
    contrastRatio(parseHex(pink)!, base) >= 4.5 - 1e-6
  );
}

// --- brandVars: spreadable CSS custom properties ------------------------
{
  const v = brandVars("#4a1d96") as Record<string, string>;
  check("brandVars sets --brand", v["--brand"] === "#4a1d96");
  check("brandVars sets readable --brand-ink", v["--brand-ink"] === "#ffffff");
  check(
    "brandVars sets legible --brand-text",
    contrastRatio(parseHex(v["--brand-text"])!, base) >= 4.5 - 1e-6
  );
  const fallback = brandVars(null) as Record<string, string>;
  check("brandVars falls back to default brand when null", fallback["--brand"] === DEFAULT_BRAND);
}

{
  // PA-01: non-text UI in the brand colour must reach 3:1 on the page surface.
  for (const dark of ["#000000", "#0c0a0e", "#111111"]) {
    const ui = brandUi(dark);
    check(`brandUi lifts ${dark} to 3:1 on the base`, contrastRatio(parseHex(ui)!, parseHex(APP_BASE)!) >= 3);
    const vars = brandVars(dark) as Record<string, string>;
    check(`brandVars exposes --brand-ui for ${dark}`, vars["--brand-ui"] === ui && vars["--brand"] === dark);
    check(`the button ink is readable on the painted fill for ${dark}`, vars["--brand-ink"] === readableInk(ui));
    const verdict = checkBrandColor(dark);
    check(`checkBrandColor flags ${dark} with a plain reason (a verdict for the hint, not a refusal)`, !verdict.ok && verdict.ratio < 3 && /too dark/.test(verdict.reason ?? "") && verdict.uiColor === ui);
  }
  check("brandUi leaves the default pink alone", brandUi(DEFAULT_BRAND) === DEFAULT_BRAND);
  check("checkBrandColor accepts the default pink", checkBrandColor(DEFAULT_BRAND).ok && checkBrandColor(DEFAULT_BRAND).reason === null);
  check("checkBrandColor accepts mid grey", checkBrandColor("#808080").ok);
  check("checkBrandColor does not pass junk", !checkBrandColor("#e").ok);
}

console.log(`theme.test.ts: ${passed} checks passed`);
