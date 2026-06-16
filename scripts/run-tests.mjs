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
for (const f of files) {
  console.log("# " + f);
  // shell:true so `npx` resolves to npx.cmd on Windows.
  const r = spawnSync("npx", ["tsx", f], { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
