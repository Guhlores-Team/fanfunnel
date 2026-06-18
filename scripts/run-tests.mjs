// Cross-platform unit-test runner (the previous `for f in $(find ...)` was bash
// and failed on Windows PowerShell). Finds every src/**/*.test.ts and runs it
// with tsx, stopping at the first failure. Works on Windows, macOS, and Linux.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findTests(p));
    else if (entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = findTests("src").sort();
// `npx tsx <f>` runs through a shell (shell:true so npx resolves to npx.cmd on
// Windows), which means `f` is subject to shell interpretation. Refuse any test
// path with characters outside this strict allowlist so a maliciously named file
// (e.g. `src/a&calc.test.ts`) cannot inject shell commands.
const SAFE_PATH = /^[A-Za-z0-9_.\-/\\]+$/;
for (const f of files) {
  if (!SAFE_PATH.test(f)) {
    console.error("Refusing to run test file with an unsafe path: " + f);
    process.exit(1);
  }
  console.log("# " + f);
  // shell:true so `npx` resolves to npx.cmd on Windows (path validated above).
  const r = spawnSync("npx", ["tsx", f], { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
