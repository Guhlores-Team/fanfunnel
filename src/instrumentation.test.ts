import assert from "node:assert/strict";

// OPS-14: register() must return without waiting for the operational checks
// (Next holds the first request until it resolves). The check starter is
// swapped through the module's seam, not a module mock.
let started = 0;

async function main() {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  const { register, startupChecks } = await import("./instrumentation");
  startupChecks.start = () => { started++; return new Promise<void>(() => { /* never settles */ }); };
  const outcome = await Promise.race([
    register().then(() => "returned"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500).unref()),
  ]);
  assert.equal(outcome, "returned", "register() returns while the checks are still running");
  assert.equal(started, 1, "the checks were started");
  console.log("instrumentation: 2 checks passed; startup checks never block the first request");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
