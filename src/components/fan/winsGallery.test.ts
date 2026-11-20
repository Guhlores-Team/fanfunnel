import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { contrastRatio, parseHex, readableInk } from "@/lib/theme";

// "Your wins" tiles: the ×N duplicate badge sits on the prize's own colour.
// White text failed AA on the default epic purple (3.95:1) and on any light
// creator colour, so the badge text must come from readableInk.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

for (const [rarity, color] of Object.entries(RARITY_COLORS)) {
  const ratio = contrastRatio(parseHex(color)!, parseHex(readableInk(color))!);
  check(`×N badge text on ${rarity} (${color}) is AA (${ratio.toFixed(2)}:1)`, ratio >= 4.5);
}

const src = readFileSync(join(import.meta.dirname, "WinsGallery.tsx"), "utf8");
const badge = src.match(/<span[^>]*>\s*×\{g\.count\}/)?.[0] ?? "";
check("the ×N badge is found", badge !== "");
check("the ×N badge is not hard-coded white text", !/text-white/.test(badge));
check("the ×N badge colours its text with readableInk", /color:\s*readableInk\(c\)/.test(badge));

console.log(`winsGallery.test: ${passed} checks passed`);
