// @ts-check
// Cross-platform unit-test runner. Finds every src/**/*.test.ts and runs each
// with tsx, collecting failures and reporting ALL of them at the end (so one
// broken suite doesn't mask the rest). Exits non-zero if any file failed.
//
// We resolve the `npx` binary on PATH ourselves and spawn it directly, instead
// of `spawnSync(..., { shell: true })` — that shell hop is what triggers Node's
// DEP0190 warning. Resolving the platform-specific binary (npx / npx.cmd) keeps
// Windows working without a shell.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * @param {string} dir
 * @returns {string[]}
 */
function findTests(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findTests(p));
    else if (entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Locate an executable on PATH, trying Windows extensions. Falls back to the
 *  bare name (let the OS resolve it) if nothing is found, so behavior never
 *  gets worse than the previous PATH lookup.
 *  @param {string} name */
function resolveBin(name) {
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

const files = findTests("src").sort();
const npx = resolveBin("npx");

/** @type {string[]} */
const failed = [];

for (const f of files) {
  console.log("# " + f);
  const r = spawnSync(npx, ["tsx", f], { stdio: "inherit" });
  if (r.status !== 0) failed.push(f);
}

console.log("\n================ TEST SUMMARY ================");
console.log(`${files.length - failed.length}/${files.length} test files passed`);
if (failed.length > 0) {
  console.log("Failed:");
  for (const f of failed) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✅ all test files passed");
