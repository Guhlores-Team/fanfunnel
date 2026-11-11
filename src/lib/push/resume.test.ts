import assert from "node:assert/strict";
import { PUSH_MAX_FAILURES } from "./config";
import { resumePausedPushDevices } from "./resume";

// OPS3-09: paused devices get one more try per maintenance run.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  const calls: { update?: unknown; opts?: unknown; filter?: [string, unknown] }[] = [];
  let fail = false;
  const svc = { from: (table: string) => ({ update: (values: unknown, opts: unknown) => ({ gte: async (col: string, v: unknown) => { calls.push({ update: { table, values }, opts, filter: [col, v] }); return fail ? { count: null, error: { message: "x" } } : { count: 3, error: null }; } }) }) };
  const r = await resumePausedPushDevices(svc as never);
  check("every paused device drops to one failure below the cap", "resumed" in r && r.resumed === 3 && JSON.stringify(calls[0].update) === JSON.stringify({ table: "push_subscriptions", values: { failures: PUSH_MAX_FAILURES - 1 } }));
  check("…only rows at or over the cap", calls[0].filter?.[0] === "failures" && calls[0].filter?.[1] === PUSH_MAX_FAILURES);
  fail = true;
  check("a database error is reported, not thrown", "error" in (await resumePausedPushDevices(svc as never)));
  console.log(`push resume: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
