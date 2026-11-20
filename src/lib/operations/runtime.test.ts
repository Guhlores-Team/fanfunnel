import assert from "node:assert/strict";
import { mock } from "node:test";
import { EXPECTED_SCHEMA_VERSION, INVARIANT_KEYS } from "./config";
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
  const { parseInvariants, parseSummary, runOperationalChecks, reportOperationalFailure, compareSchemaVersion, readSchemaVersion } = await import("./runtime");
  // A39: the database's migration level against the code's.
  check("equal level is current", compareSchemaVersion(67, 67).status === "current");
  check("a newer database is ahead (DB before code is the normal order)", compareSchemaVersion(68, 67).status === "ahead");
  check("an older database is behind", compareSchemaVersion(66, 67).status === "behind" && compareSchemaVersion(66, 67).applied === 66);
  check("a malformed level is unavailable, never current", ["67", 0, -1, 1.5, null, {}].every(raw => compareSchemaVersion(raw, 67).status === "unavailable"));
  const schemaOf = (reply: unknown) => readSchemaVersion({ rpc: (name: string) => { assert.equal(name, "schema_version"); return { abortSignal: async () => reply }; } } as never);
  check("a database without schema_version() (before 0067) is behind", (await schemaOf({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })).status === "behind");
  check("any other read error is unavailable", (await schemaOf({ data: null, error: { code: "42501", message: "permission denied" } })).status === "unavailable");
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
  let applied = EXPECTED_SCHEMA_VERSION;
  const svc = { rpc: (name: string) => ({ abortSignal: async () => { calls.push(name); return { data: name === "run_reward_ledger_invariants" ? diagnostic : name === "schema_version" ? applied : summary, error: null }; } }) };
  const healthy = await runOperationalChecks("manual", svc as never);
  check("complete authenticated checks persist and pass", healthy.ok && healthy.schema?.status === "current" && calls.join(",") === "run_reward_ledger_invariants,schema_version,record_system_health_check");
  check("healthy checks do not send alerts", stored === 0 && alerted === 0);
  applied = EXPECTED_SCHEMA_VERSION - 1;
  const behind = await runOperationalChecks("maintenance", svc as never);
  check("A39: a database behind the code fails the checks and alerts with a fixed message", !behind.ok && behind.schema?.status === "behind" && stored === 1 && alerted === 1 && messages.at(-1) === `Database schema is behind the deployed code: migration ${EXPECTED_SCHEMA_VERSION - 1} applied, ${EXPECTED_SCHEMA_VERSION} required`);
  applied = EXPECTED_SCHEMA_VERSION + 1;
  check("a database ahead of the code passes (migrations land before code)", (await runOperationalChecks("manual", svc as never)).ok && stored === 1);
  applied = EXPECTED_SCHEMA_VERSION; stored = 0; alerted = 0;
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
