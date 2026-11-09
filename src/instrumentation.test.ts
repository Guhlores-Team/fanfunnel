import assert from "node:assert/strict";
import { mock } from "node:test";

// OPS-14: register() must return without waiting for the operational checks
// (Next holds the first request until it resolves).
let started = 0;
mock.module("@/lib/operations/startup", {
  namedExports: { registerOperationalChecks: () => { started++; return new Promise<void>(() => { /* never settles */ }); } },
});

async function main() {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  const { register } = await import("./instrumentation");
  const outcome = await Promise.race([
    register().then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500).unref()),
  ]);
  assert.equal(outcome, "returned", "register() returns while the checks are still running");
  assert.equal(started, 1, "the checks were started");
  console.log("instrumentation: 2 checks passed; startup checks never block the first request");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
