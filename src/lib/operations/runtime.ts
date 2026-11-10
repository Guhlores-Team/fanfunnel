import "server-only";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { alertFor, cleanError, storeError } from "@/lib/monitoring/capture";
import { bootstrapEmptyCanary } from "./canary";
import { CANARY_STATUSES, DIAGNOSTIC_MAX_ROWS, DIAGNOSTIC_TIMEOUT_MS, EXPECTED_SCHEMA_VERSION, INVARIANT_KEYS, type CanaryResult, type CanaryStatus, type HealthSummary, type InvariantResult, type OperationalResult, type SchemaCheck } from "./config";

const asRecord = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
export function parseInvariants(raw: unknown): InvariantResult {
  const row = asRecord(raw), counts = asRecord(row?.counts);
  if (!row || !counts || !["healthy", "violations", "incomplete", "unavailable"].includes(String(row.status)) || !Number.isInteger(row.rowLimit) || Number(row.rowLimit)<1 || Number(row.rowLimit)>DIAGNOSTIC_MAX_ROWS) return { status: "unavailable", counts: {}, rowLimit: DIAGNOSTIC_MAX_ROWS };
  if (Object.keys(counts).some(key => !INVARIANT_KEYS.includes(key as typeof INVARIANT_KEYS[number]) || !Number.isSafeInteger(counts[key]) || Number(counts[key])<0)) return { status: "unavailable", counts: {}, rowLimit: DIAGNOSTIC_MAX_ROWS };
  if ((row.status === "healthy" || row.status === "violations") && INVARIANT_KEYS.some(key => !(key in counts))) return { status: "unavailable", counts: {}, rowLimit: DIAGNOSTIC_MAX_ROWS };
  const total = Object.values(counts).reduce<number>((sum, value) => sum + Number(value), 0);
  if ((row.status === "healthy" && total !== 0) || (row.status === "violations" && total === 0)) return { status: "unavailable", counts: {}, rowLimit: DIAGNOSTIC_MAX_ROWS };
  return { status: row.status as InvariantResult["status"], counts: counts as InvariantResult["counts"], rowLimit: Number(row.rowLimit) };
}
export async function readLedgerInvariants(svc: ReturnType<typeof createServiceClient>): Promise<InvariantResult> {
  try {
    const { data, error } = await svc.rpc("run_reward_ledger_invariants", { p_row_limit: DIAGNOSTIC_MAX_ROWS }).abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS));
    return parseInvariants(error ? null : data);
  } catch { return parseInvariants(null); }
}
/** A39: compare the database's migration level with the one this code needs. Only "behind" or "unavailable" need action. */
export function compareSchemaVersion(raw: unknown, expected: number = EXPECTED_SCHEMA_VERSION): SchemaCheck {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1) return { status: "unavailable", applied: null, expected };
  const applied = Number(raw);
  return { status: applied === expected ? "current" : applied > expected ? "ahead" : "behind", applied, expected };
}
// PostgREST answers PGRST202 (Postgres 42883) when the function does not exist: a database from before 0067.
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);
export async function readSchemaVersion(svc: ReturnType<typeof createServiceClient>): Promise<SchemaCheck> {
  try {
    const { data, error } = await svc.rpc("schema_version").abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS));
    if (error) return MISSING_FUNCTION.has(String(error.code)) ? { status: "behind", applied: null, expected: EXPECTED_SCHEMA_VERSION } : compareSchemaVersion(null);
    return compareSchemaVersion(data);
  } catch { return compareSchemaVersion(null); }
}
export const schemaHealthy = (schema: SchemaCheck) => schema.status === "current" || schema.status === "ahead";
function parseCounts(raw: unknown): HealthSummary["invariantCounts"] | null {
  const value = asRecord(raw);
  return value && Object.keys(value).every(key => INVARIANT_KEYS.includes(key as typeof INVARIANT_KEYS[number]) && Number.isSafeInteger(value[key]) && Number(value[key])>=0) ? value as HealthSummary["invariantCounts"] : null;
}
const dateOrNull = (raw: unknown) => typeof raw === "string" && Number.isFinite(Date.parse(raw)) ? raw : null;
export function parseSummary(raw: unknown): HealthSummary | null {
  const row = asRecord(raw), counts = parseCounts(row?.invariantCounts);
  if (!row || !counts || ![...CANARY_STATUSES, "not_run"].includes(row.canaryStatus as CanaryStatus) || !["not_run", "healthy", "violations", "incomplete", "unavailable"].includes(String(row.invariantsStatus))) return null;
  return { canaryStatus: row.canaryStatus as HealthSummary["canaryStatus"], canaryCheckedAt: dateOrNull(row.canaryCheckedAt), canaryFailureAt: dateOrNull(row.canaryFailureAt),
    invariantsStatus: row.invariantsStatus as HealthSummary["invariantsStatus"], invariantCounts: counts, invariantsCheckedAt: dateOrNull(row.invariantsCheckedAt), lastMaintenanceAt: dateOrNull(row.lastMaintenanceAt) };
}
export async function persistHealth(svc: ReturnType<typeof createServiceClient>, source: "startup" | "manual" | "maintenance", canary: CanaryResult, invariants?: InvariantResult): Promise<HealthSummary | null> {
  try {
    const { data, error } = await svc.rpc("record_system_health_check", { p_source: source, p_canary_status: canary.status, ...(invariants ? { p_invariants: invariants } : {}) }).abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS));
    return error ? null : parseSummary(data);
  } catch { return null; }
}
export async function readHealthSummary(svc: ReturnType<typeof createServiceClient>): Promise<HealthSummary | null> {
  try {
    const { data, error } = await svc.from("system_health_checks").select("canary_status,canary_checked_at,canary_failure_at,invariants_status,invariant_counts,invariants_checked_at,last_maintenance_at").eq("singleton", true).abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS)).maybeSingle();
    if (error || !data) return null;
    return parseSummary({ canaryStatus: data.canary_status, canaryCheckedAt: data.canary_checked_at, canaryFailureAt: data.canary_failure_at, invariantsStatus: data.invariants_status, invariantCounts: data.invariant_counts, invariantsCheckedAt: data.invariants_checked_at, lastMaintenanceAt: data.last_maintenance_at });
  } catch { return null; }
}
const CANARY_MESSAGES: Record<Exclude<CanaryStatus, "healthy">, string> = {
  missing: "Reward key protection needs verified initialization",
  configuration_missing: "Reward key protection failed: required key configuration is missing",
  configuration_invalid: "Reward key protection failed: key version configuration is invalid",
  mismatch: "Reward key protection failed: the immutable encryption or fingerprint anchor does not match",
  unavailable: "Reward key protection could not be checked",
};
/** Fixed messages only. The existing fingerprint upsert and hourly alert budget
 * deduplicate repeats; no crypto exception, inventory row or secret is logged. */
export async function reportOperationalFailure(canary: CanaryResult, invariants?: InvariantResult, schema?: SchemaCheck): Promise<void> {
  const messages: string[] = [];
  if (canary.status !== "healthy") messages.push(CANARY_MESSAGES[canary.status]);
  if (invariants && invariants.status !== "healthy") messages.push(invariants.status === "violations" ? "Reward ledger integrity check found stock, reservation or credit mismatches" : "Reward ledger integrity check was incomplete or unavailable");
  if (schema?.status === "behind") messages.push(`Database schema is behind the deployed code: migration ${schema.applied ?? "none (before 0067)"} applied, ${schema.expected} required`);
  if (schema?.status === "unavailable") messages.push("Database schema version could not be checked");
  for (const message of messages) {
    const clean = cleanError({ source: "server", route: "/api/admin/system-health", message });
    if (!clean) continue;
    const outcome = await storeError(clean);
    if (outcome) await alertFor(clean, outcome);
  }
}
export async function runOperationalChecks(source: "manual" | "maintenance", svc?: ReturnType<typeof createServiceClient>): Promise<OperationalResult> {
  if (!isSupabaseConfigured()) return { demo: true, ok: false, canary: { status: "demo" }, invariants: { status: "demo", counts: {}, rowLimit: DIAGNOSTIC_MAX_ROWS }, summary: null };
  let client: ReturnType<typeof createServiceClient>;
  try { client = svc ?? createServiceClient(); }
  catch { return { demo: false, ok: false, canary: { status: "unavailable" }, invariants: { status: "unavailable", counts: {}, rowLimit: DIAGNOSTIC_MAX_ROWS }, summary: null }; }
  const [canary, invariants, schema] = await Promise.all([bootstrapEmptyCanary(client), readLedgerInvariants(client), readSchemaVersion(client)]);
  const summary = await persistHealth(client, source, canary, invariants);
  await reportOperationalFailure(canary, invariants, schema);
  // OPS3-05: a healthy run is healthy. The persisted canary_failure_at latch
  // (one earlier blip, e.g. a 3 s timeout at an instance start) used to fail
  // every nightly run until an admin clicked "Run checks now", so the
  // heartbeat went silent and the monitor said "down" daily for a site that
  // was fine. It is still returned in summary.canaryFailureAt for System
  // health; the proposed 0073 change lets a healthy maintenance run clear it.
  return { demo: false, ok: canary.status === "healthy" && invariants.status === "healthy" && schemaHealthy(schema) && summary !== null, canary, invariants, schema, summary };
}
