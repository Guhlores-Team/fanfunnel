import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_GAME_TITLE, copyTitle } from "./copyTitle";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
check("a first copy says so", copyTitle("Spin to Win", ["Spin to Win"]) === "Spin to Win (copy)");
check("a second copy is numbered", copyTitle("Spin to Win", ["Spin to Win", "Spin to Win (copy)"]) === "Spin to Win (copy 2)");
check("copying a copy does not stack suffixes", copyTitle("Spin to Win (copy)", ["Spin to Win", "Spin to Win (copy)"]) === "Spin to Win (copy 2)");
check("taken titles compare without case", copyTitle("Bingo", ["bingo (COPY)"]) === "Bingo (copy 2)");
const long = "x".repeat(130);
check("the title stays within the limit, suffix kept", copyTitle(long, []).length === MAX_GAME_TITLE && copyTitle(long, []).endsWith(" (copy)"));
check("a blank title still gets a name", copyTitle("   ", []) === "Game (copy)");
for (const [file, marker] of [["../data/wheels.ts", "export async function duplicateWheel"], ["../data/mock.ts", "export function mockDuplicateWheel"]] as const) {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const body = src.slice(src.indexOf(marker), src.indexOf(marker) + 2500);
  check(`${file} names the copy with copyTitle`, /copyTitle\(/.test(body));
}
console.log(`copyTitle.test: ${passed} checks passed`);
