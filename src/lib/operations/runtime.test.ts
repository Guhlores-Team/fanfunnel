import assert from "node:assert/strict";
import { mock } from "node:test";
import { INVARIANT_KEYS } from "./config";
let configured = true, canary: { status: string } = { status: "healthy" }, stored = 0, alerted = 0;
const messages: string[] = [];
mock.module("@/lib/supabase/server", { namedExports: { createServiceClient: () => { throw new Error("test must supply service factory result"); }, isSupabaseConfigured: () => configured } });
mock.module("./canary", { namedExports: { bootstrapEmptyCanary: async () => canary } });
mock.module("@/lib/monitoring/capture", { namedExports: {
  cleanError: (value: { message: string }) => { messages.push(value.message); return value; },
  storeError: async () => { stored++; return { id: "synthetic", first: true }; },
  alertFor: async () => { alerted++; },
} });
let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
async function main() {
  const { parseInvariants, parseSummary, runOperationalChecks, reportOperationalFailure } = await import("./runtime");
  const counts = Object.fromEntries(INVARIANT_KEYS.map(key => [key, 0]));
  const diagnostic = { status: "healthy", counts, rowLimit: 100000 };
  check("complete zero counts are healthy", parseInvariants(diagnostic).status === "healthy");
  check("false healthy is refused", parseInvariants({ ...diagnostic, counts: { ...counts, codeStockMismatch: 1 } }).status === "unavailable");
  check("unknown count cannot leak inventory metadata", parseInvariants({ ...diagnostic, counts: { ...counts, cipher: 0 } }).status === "unavailable");
  check("missing healthy count cannot hide a check", parseInvariants({ ...diagnostic, counts: {} }).status === "unavailable");
  check("incomplete is never healthy", parseInvariants({ ...diagnostic, status: "incomplete", counts: {} }).status === "incomplete");
  check("negative and unbounded counts refused", parseInvariants({ ...diagnostic, counts: { ...counts, codeStockMismatch: -1 } }).status === "unavailable" && parseInvariants({ ...diagnostic, rowLimit: 100001 }).status === "unavailable");
  const summary = { canaryStatus: "healthy", canaryCheckedAt: new Date().toISOString(), canaryFailureAt: null, invariantsStatus: "healthy", invariantCounts: counts, invariantsCheckedAt: null, lastMaintenanceAt: null };
  check("summary parser keeps only safe known fields", !JSON.stringify(parseSummary({ ...summary, cipher: "synthetic-secret" })).includes("synthetic-secret"));
  const calls: string[] = [];
  const svc = { rpc: (name: string) => ({ abortSignal: async () => { calls.push(name); return { data: name === "run_reward_ledger_invariants" ? diagnostic : summary, error: null }; } }) };
  const healthy = await runOperationalChecks("manual", svc as never);
  check("complete authenticated checks persist and pass", healthy.ok && calls.join(",") === "run_reward_ledger_invariants,record_system_health_check");
  check("healthy checks do not send alerts", stored === 0 && alerted === 0);
  canary = { status: "mismatch" };
  const failed = await runOperationalChecks("maintenance", svc as never);
  check("key mismatch is nonhealthy and uses existing alert pipeline", !failed.ok && stored === 1 && alerted === 1);
  await reportOperationalFailure({ status: "healthy" }, { status: "violations", counts: { codeStockMismatch: 1 }, rowLimit: 100000 });
  check("invariant mismatch uses fixed redacted error", messages.at(-1) === "Reward ledger integrity check found stock, reservation or credit mismatches" && stored === 2);
  const unavailable = await runOperationalChecks("manual", { rpc: () => ({ abortSignal: async () => { throw new Error("synthetic secret transport detail"); } }) } as never);
  check("transport failure stays unavailable and response contains no raw error", !unavailable.ok && unavailable.invariants.status === "unavailable" && !JSON.stringify(unavailable).includes("synthetic secret"));
  check("fixed alert messages never include raw RPC or reward values", !messages.some(message => /synthetic secret|cipher|iv=/i.test(message)));
  check("service factory failure is explicit unavailable", (await runOperationalChecks("manual")).canary.status === "unavailable");
  configured = false;
  check("demo is explicitly unverified", (await runOperationalChecks("manual")).demo && !(await runOperationalChecks("manual")).ok);
  console.log(`operational runtime: ${passed} checks passed; alerts mocked, no emails sent`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
