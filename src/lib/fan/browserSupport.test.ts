import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// RF-04 (static): the fan page must answer on iOS 15.0 Safari and 2021
// Android WebViews. APIs newer than that stay behind the helpers in
// src/lib/fan/uuid.ts (randomUuid / hasOwn / lastOf) or are not used at all
// in any module the fan bundle can load.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const root = join(__dirname, "..", "..", "..");
const FAN_DIRS = ["src/components/fan", "src/components/reveal", "src/lib/fan", "src/lib/games", "src/lib/spinIntent", "src/components/Wheel.tsx", "src/components/SpinClient.tsx", "src/components/spinErrors.ts", "src/components/LegalLinks.tsx", "src/components/NotFoundView.tsx", "src/app/spin", "src/app/share", "src/app/verify", "src/app/c", "src/app/leaderboard"];
const files = execFileSync("git", ["ls-files", ...FAN_DIRS], { cwd: root, encoding: "utf8" })
  .split("\n").filter((f) => /\.(tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f));
check("the fan surface is covered", files.length > 60);

// [name, pattern, the one file allowed to use it (the fallback helper)]
const RULES: [string, RegExp, string | null][] = [
  ["crypto.randomUUID (Safari 15.4+)", /\brandomUUID\s*\(/, "src/lib/fan/uuid.ts"],
  ["Object.hasOwn (Safari 15.4+)", /\bObject\.hasOwn\b/, "src/lib/fan/uuid.ts"],
  ["Array.prototype.at (Safari 15.4+)", /\)\.at\(|\]\.at\(|\w\.at\(\s*-?\d/, null],
  ["structuredClone (Safari 15.4+)", /\bstructuredClone\s*\(/, null],
  ["findLast / findLastIndex (Safari 15.4+)", /\.findLast(?:Index)?\s*\(/, null],
  ["toSorted / toReversed / toSpliced / with (Safari 16+)", /\.(?:toSorted|toReversed|toSpliced)\s*\(/, null],
  ["Array.prototype.group / Object.groupBy (2024)", /\b(?:Object|Map)\.groupBy\s*\(|\.group\s*\(\s*\(/, null],
  ["Promise.withResolvers (Safari 17.4+)", /Promise\.withResolvers/, null],
  ["Set methods union/intersection (Safari 17+)", /\.(?:union|intersection|difference|symmetricDifference|isSubsetOf)\s*\(/, null],
  ["Intl.Segmenter (not in Android WebView < 87)", /Intl\.Segmenter/, null],
  ["navigator.userAgentData (no Safari)", /navigator\.userAgentData/, null],
];
for (const [name, re, allowed] of RULES) {
  const hits = files.filter((f) => {
    if (allowed && allowed.split("|").includes(f)) return false;
    const text = readFileSync(join(root, f), "utf8")
      // Comments may name the API they avoid.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return re.test(text);
  });
  check(`${name} is not used in the fan surface (${hits.join(", ")})`, hits.length === 0);
}
const uuid = readFileSync(join(root, "src/lib/fan/uuid.ts"), "utf8");
check("randomUuid falls back to getRandomValues", uuid.includes("getRandomValues"));
check("hasOwn uses Object.prototype.hasOwnProperty", uuid.includes("Object.prototype.hasOwnProperty.call"));
console.log(`browserSupport.test: ${passed} checks passed`);
