import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// RF-08 (static): the page background token is `--color-canvas`, so Tailwind's
// `text-base` is a font size (16 px: no iOS zoom on fan inputs) and never a
// colour. `--color-base` must not come back under any name, and no class may
// use `base` as a colour.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const root = join(__dirname, "..", "..", "..");
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
check("globals.css defines --color-canvas in @theme", /@theme\s*\{[^}]*--color-canvas:\s*#0c0a0e;/.test(css));
check("globals.css no longer defines --color-base", !css.includes("--color-base"));
check("the brand glow sits on the canvas token", css.includes("var(--color-canvas)"));

const files = execFileSync("git", ["ls-files", "src", "e2e", "scripts"], { cwd: root, encoding: "utf8" })
  // This file names the old token in order to refuse it.
  .split("\n").filter((f) => /\.(tsx?|css|mjs|js)$/.test(f) && f !== "src/lib/fan/colorTokens.test.ts");
const colourBase = /(?:^|[\s"'`{(])(?:bg|text|border|ring|from|to|via|fill|stroke|shadow|outline|divide|accent|caret|decoration|placeholder)-base(?:\/\d+)?(?=$|[\s"'`})])/;
const offenders: string[] = [];
let canvasUses = 0;
for (const f of files) {
  const text = readFileSync(join(root, f), "utf8");
  if (text.includes("--color-base")) offenders.push(`${f}: --color-base`);
  for (const line of text.split("\n")) {
    // `text-base` is the 16 px font size; every other `*-base` would be a colour.
    if (colourBase.test(line.replace(/text-base\b/g, ""))) offenders.push(`${f}: ${line.trim().slice(0, 80)}`);
  }
  canvasUses += (text.match(/\bbg-canvas\b|\btext-canvas\b|var\(--color-canvas\)/g) ?? []).length;
}
check(`no file uses "base" as a colour or the old token (${offenders.join("; ")})`, offenders.length === 0);
check("the canvas token is in use across the app", canvasUses >= 25);

// PA-01 (decision): any hex brand colour is accepted, so nothing may paint
// the raw `--brand`. UI paints `--brand-ui` (lifted to 3:1 on the page), text
// on it uses `--brand-ink`, brand-coloured text uses `--brand-text`. Only
// globals.css (the defaults and the decorative glow) names the raw variable.
const rawBrand = files.filter((f) => f.startsWith("src/") && f !== "src/app/globals.css" && !/\.test\.tsx?$/.test(f) && f !== "src/lib/theme.ts")
  .filter((f) => readFileSync(join(root, f), "utf8").includes("var(--brand)"));
check(`no component paints the raw brand colour (${rawBrand.join("; ")})`, rawBrand.length === 0);
const chat = readFileSync(join(root, "src/components/fan/ChatPanel.tsx"), "utf8");
check("the fan's chat bubbles read on any brand colour", !/background: "var\(--brand-ui\)",?\s*color: "#fff"/.test(chat) && (chat.match(/color: "var\(--brand-ink\)"/g) ?? []).length >= 2);

// The three fan inputs the audit named mean 16 px on phones: text-base + text-ink.
for (const f of ["src/components/fan/ChatPanel.tsx", "src/components/fan/FanLeaderboard.tsx"]) {
  const text = readFileSync(join(root, f), "utf8");
  check(`${f} keeps text-base (16 px) with an explicit ink colour on its input`, /text-base text-ink[^"]*sm:text-sm/.test(text));
}
console.log(`colorTokens.test: ${passed} checks passed`);
