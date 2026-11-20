import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// TS-02 / public-text rule: nothing a fan reads ties a play to money or to
// games of chance. Every fan-facing source is scanned outside its comments,
// so a new string cannot bring the vocabulary back unnoticed.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const src = join(import.meta.dirname, "..", "..");
const BANNED = /\b(buy|buys|bought|paid|purchase|purchases|purchased|gamble|gambling|bet|bets|betting|lottery|lotteries)\b/i;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const files = [
  ...["components/fan", "components/reveal", "lib/fan", "app/spin", "app/share", "app/verify", "app/c", "app/leaderboard"].flatMap((dir) => sources(join(src, dir))),
  ...["components/Wheel.tsx", "components/SpinClient.tsx", "components/spinErrors.ts", "components/LegalLinks.tsx", "app/not-found.tsx"].map((file) => join(src, file)),
];
check("the fan-facing sources are found", files.length > 60);
for (const file of files) {
  const hit = BANNED.exec(withoutComments(readFileSync(file, "utf8")));
  check(`${file.slice(src.length + 1)} keeps purchase and gambling words out of fan-facing text (found: ${hit?.[0] ?? "none"})`, hit === null);
}
check("the scan itself sees a banned word in a string and skips one in a comment",
  BANNED.test(withoutComments('const a = "Buy more spins"; // fine')) && !BANNED.test(withoutComments("const a = 1; // never say buy\n/* or bet */")));

console.log(`fanCopyWords: ${passed} checks passed`);
