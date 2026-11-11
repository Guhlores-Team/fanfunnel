import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const scenarios = [
  ["normal_success", 0], ["dynamic_success", 0], ["failures_collect", 1],
  ["spawn_error_zero", 1], ["signal_zero", 1], ["null_status", 1],
  ["mixed_failures", 1], ["fallback_binary", 0], ["discovery_failure", 1],
  ["unsafe_semicolon", 1], ["unsafe_dollar", 1], ["unsafe_backtick", 1],
  ["unsafe_space", 1], ["unsafe_quote", 1], ["unsafe_pipe", 1],
  ["unsafe_parentheses", 1], ["traversal_escape", 1],
  ["traversal_reentry", 1], ["traversal_nested", 1], ["unsafe_backslash_entry", 1],
] as const;
type Call = { binary: string; args: string[]; options: { stdio: string; shell?: boolean }; result: { status: number | null; signal: string | null; error: string | null } };
type Receipt = { scenario: string; code: number; calls: Call[]; discovered: string[]; expectedPreloadPath: string };
const results = scenarios.map(([scenario, expected]) => {
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", resolve("scripts/test/unit-runner-fixture.mjs"), scenario], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined, "native fault fixture must actually execute");
  assert.equal(child.signal, null);
  const line = child.stdout.split(/\r?\n/).find((row) => row.startsWith("UNIT_RUNNER_FIXTURE:"));
  assert.ok(line, `${scenario}: missing native runner receipt\n${child.stderr}`);
  const receipt = JSON.parse(line.slice("UNIT_RUNNER_FIXTURE:".length)) as Receipt;
  assert.equal(receipt.scenario, scenario);
  assert.equal(receipt.code, child.status);
  console.log(`unit runner ${scenario}: expected=${expected} actual=${child.status} calls=${receipt.calls.length}`);
  return { scenario, expected, actual: child.status, receipt, stdout: child.stdout };
});
for (const result of results) assert.equal(result.actual, result.expected, `${result.scenario}: actual scripts/run-tests.mjs must enforce discovery and process results`);
const result = (scenario: string) => results.find((row) => row.scenario === scenario)!;
const ordinary = ["src/a.test.ts", "src/b.test.ts", "src/nested/c.test.ts", "src/z.test.ts"].map((file) => join(...file.split("/")));
const dynamic = ["src/app/api/creator-requests/[id]/route.test.ts", "src/app/docs/[...slug]/page.test.ts", "src/app/docs/[[...parts]]/route.test.ts", "src/plain.test.ts"].map((file) => join(...file.split("/"))).sort();
for (const scenario of ["normal_success", "dynamic_success", "failures_collect", "spawn_error_zero", "signal_zero", "null_status", "mixed_failures", "fallback_binary"]) {
  const row = result(scenario);
  assert.deepEqual(row.receipt.calls.map((call) => call.args.at(-1)), scenario === "dynamic_success" ? dynamic : ordinary, "all discovered suites run once in sorted order, including suites after a failure");
  for (const call of row.receipt.calls) {
    assert.deepEqual(call.args.slice(0, 3), ["tsx", "--experimental-test-module-mocks", "--import"]);
    assert.equal(call.args[3], row.receipt.expectedPreloadPath, "the server-only preload contract remains intact");
    assert.equal(call.args.length, 5, "each path is a single literal argument, not a shell/glob expression");
    assert.deepEqual(call.options, { stdio: "inherit" }, "no shell or output suppression is introduced");
  }
}
assert.ok(result("failures_collect").stdout.includes("2/4 test files passed"), "multiple failures are collected and reported together");
for (const scenario of ["spawn_error_zero", "signal_zero", "null_status"]) assert.ok(result(scenario).stdout.includes("3/4 test files passed"), "process error/signal/null exit fails one suite while the remaining suites still run");
assert.ok(result("mixed_failures").stdout.includes("1/4 test files passed"), "exit/error/signal failures are each retained");
assert.equal(result("fallback_binary").receipt.calls[0].binary, "npx", "existing binary fallback stays compatible");
assert.ok(result("normal_success").receipt.calls.every((call) => call.binary === join("/fixture-bin", process.platform === "win32" ? "npx.COM" : "npx")), "the resolved executable is invoked directly");
for (const [scenario] of scenarios.filter(([name]) => name.startsWith("unsafe_") || name.startsWith("traversal_") || name === "discovery_failure")) assert.equal(result(scenario).receipt.calls.length, 0, "unsafe discovery cannot execute a test or command");
console.log(`unitRunner.test: ${scenarios.length} actual-runner native-child scenarios passed; literal Next brackets, complete collection, preload, no shell and strict process/path failures`);
