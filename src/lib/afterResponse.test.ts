import assert from "node:assert";
import { runAfterResponse } from "./afterResponse";

// runAfterResponse hands work to Next's after() inside a request (see
// src/lib/data/webhookAfter.test.ts). Outside one (unit tests, scripts) after()
// throws; the helper must not let that throw reach the caller — on the spin
// path that would fail (and refund) a spin that was already recorded — and must
// still run the task, swallowing its failure.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  let ran = 0;
  let threw = false;
  try {
    runAfterResponse(async () => {
      ran++;
    });
    runAfterResponse(async () => {
      ran++;
      throw new Error("endpoint down");
    });
  } catch {
    threw = true;
  }
  check("outside a request scope it does not throw", !threw);
  await new Promise((r) => setTimeout(r, 10));
  check("outside a request scope the task still runs", ran === 2);

  let unhandled = 0;
  process.on("unhandledRejection", () => unhandled++);
  runAfterResponse(() => Promise.reject(new Error("boom")));
  await new Promise((r) => setTimeout(r, 10));
  check("a failing task never surfaces as an unhandled rejection", unhandled === 0);

  console.log(`afterResponse.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
