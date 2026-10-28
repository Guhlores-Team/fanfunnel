import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// These are native child processes executing the actual e2e/run.mjs. A helper
// returning false cannot satisfy this check if the real orchestrator ignores it.
const scenarios = [
  ["success", 0], ["crash_before_first", 1], ["crash_after_pass", 1],
  ["crash_last_journey", 1], ["step_failure", 1], ["browser_signal", 1],
  ["server_setup_failure", 1], ["browser_setup_failure", 1],
  ["context_setup_failure", 1], ["screenshot_failure", 1],
  ["report_failure", 1], ["close_failure_after_crash", 1],
  ["close_failure_success", 0], ["stop_failure", 1],
] as const;
type Event = { type: string; detail: unknown };
type Receipt = { scenario: string; code: number; stepCount: number; failures: number; events: Event[] };
const root = resolve(".");
const results = scenarios.map(([scenario, expected]) => {
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", resolve("scripts/test/e2e-runner-fixture.mjs"), scenario], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined, `${scenario}: fixture must complete without a timeout/spawn error`);
  assert.equal(child.signal, null, `${scenario}: the runner must choose its process exit`);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith("E2E_RUNNER_FIXTURE:"));
  assert.ok(line, `${scenario}: actual runner fixture receipt missing\n${child.stderr}`);
  const receipt = JSON.parse(line.slice("E2E_RUNNER_FIXTURE:".length)) as Receipt;
  assert.equal(receipt.scenario, scenario);
  assert.equal(receipt.code, child.status, "the receipt agrees with the real child exit status");
  console.log(`e2e runner ${scenario}: expected=${expected} actual=${child.status} steps=${receipt.stepCount}`);
  return { scenario, expected, actual: child.status, receipt };
});

for (const result of results) assert.equal(result.actual, result.expected, `${result.scenario}: actual e2e/run.mjs must enforce completion and recorded failures`);
const result = (scenario: string) => results.find((entry) => entry.scenario === scenario)!.receipt;
const has = (receipt: Receipt, type: string) => receipt.events.some((entry) => entry.type === type);
const crashed = ["crash_before_first", "crash_after_pass", "crash_last_journey", "screenshot_failure", "close_failure_after_crash"];
for (const scenario of crashed) {
  const receipt = result(scenario);
  assert.ok(receipt.events.some((entry) => entry.type === "report" && entry.detail === true), "a report with only previous passing steps must not override an orchestration crash");
  assert.ok(receipt.events.some((entry) => entry.type === "log" && String(entry.detail).startsWith("Journey crashed:")), "orchestration crash reporting remains visible");
  assert.ok(has(receipt, "screenshot"), "the existing screenshot attempt also covers an orchestration crash");
  assert.ok(has(receipt, "browser_close") && has(receipt, "server_stop"), "crash cleanup still runs");
}
assert.equal(result("crash_before_first").stepCount, 0);
assert.equal(result("crash_after_pass").stepCount, 1);
assert.ok(result("crash_last_journey").stepCount > 1, "completion cannot be marked before all registered journeys return");
assert.equal(result("step_failure").failures, 1);
for (const scenario of ["step_failure", "browser_signal"]) {
  assert.ok(result(scenario).events.some((entry) => entry.type === "report" && entry.detail === false));
  assert.ok(has(result(scenario), "screenshot"));
}
for (const scenario of ["server_setup_failure", "browser_setup_failure", "context_setup_failure", "report_failure"]) {
  const receipt = result(scenario);
  assert.ok(receipt.events.some((entry) => entry.type === "log" && String(entry.detail).startsWith("E2E harness error:")));
  assert.ok(has(receipt, "server_stop"));
}
assert.ok(!has(result("server_setup_failure"), "launch"));
assert.ok(!has(result("browser_setup_failure"), "browser_close"));
assert.ok(has(result("context_setup_failure"), "browser_close"));
const success = result("success");
const called = success.events.filter((entry) => entry.type === "journey").map((entry) => entry.detail);
assert.equal(called[0], "creatorJourney");
assert.equal(called.at(-1), "firstRunJourney", "the account wipe remains the last registered journey");
assert.equal(called.length, success.stepCount, "every registered successful journey ran its step");
assert.ok(called.length >= 18, "the mock must exercise the actual full orchestrator");
assert.ok(!has(success, "screenshot"));
assert.ok(has(success, "browser_close") && has(success, "server_stop"));
assert.ok(has(result("close_failure_success"), "server_stop"), "existing best-effort browser close handling still stops the owned server");
assert.ok(has(result("stop_failure"), "browser_close") && has(result("stop_failure"), "server_stop"));
console.log(`e2eRunner.test: ${scenarios.length} actual-runner child exit scenarios passed, including crashes before/after passed steps and retained reporting/cleanup`);
