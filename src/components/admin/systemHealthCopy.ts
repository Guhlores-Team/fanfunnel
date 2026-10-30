import { CANARY_STATUSES, INVARIANT_KEYS, type CanaryStatus, type HealthSummary } from "@/lib/operations/config";

export function canaryMessage(status: CanaryStatus | "demo"): string {
  switch (status) {
    case "healthy": return "Reward keys match the saved protection record.";
    case "missing": return "Reward key protection has not been initialized. Back up both reward keys before continuing.";
    case "configuration_missing": return "A required reward key is missing. Ask your operator to restore the saved environment configuration.";
    case "configuration_invalid": return "The reward key version is invalid. Ask your operator to restore the saved environment configuration.";
    case "mismatch": return "Reward keys do not match the saved record. Ask your operator to restore the original keys and version. Do not replace the protection record.";
    case "unavailable": return "Reward key protection could not be checked. Try again or ask your operator to check database access.";
    case "demo": return "Demo only. No connected database or real reward keys have been checked.";
  }
}
export function initializationMessage(outcome: unknown): string {
  switch (outcome) {
    case "initialized": return "Reward key protection initialized after verifying the existing inventory. Run checks now.";
    case "existing": return "A protection record already exists. It has been kept. Run checks to confirm its status.";
    case "recovery_required": return "Operator recovery is required: historical erased codes cannot validate the original fingerprint key. Keep the original keys and database backup; do not create a replacement record.";
    case "inventory_changed": return "Inventory changed during verification. Nothing was initialized. Try again when inventory is quiet.";
    case "inventory_limit": return "Inventory exceeds the safe initialization limit. Ask your operator for a reviewed migration plan.";
    case "validation_failed": return "Existing rewards could not be verified. Nothing was initialized. Restore the original keys and version with your operator.";
    case "forbidden": return "Your administrator account could not be verified. Sign in again with two-factor authentication.";
    default: return "Protection could not be initialized. Nothing has been replaced. Try again or contact your operator.";
  }
}
export function ledgerMessage(summary: HealthSummary | null): string {
  if (!summary || summary.invariantsStatus === "not_run") return "Inventory and credit checks have not completed. Run checks now.";
  if (summary.invariantsStatus === "healthy") return "The latest bounded inventory, reservation and credit checks passed.";
  if (summary.invariantsStatus === "violations") return "Inventory, reservation or credit mismatches need operator review. These checks do not repair balances or issue rewards.";
  return "Inventory and credit checks were incomplete or unavailable. Ask your operator to review the check limits and database access.";
}

export type SystemHealthStatus = { demo: boolean; canary: { status: CanaryStatus | "demo" }; summary: HealthSummary | null };
export function parseSystemHealthStatus(raw: unknown): SystemHealthStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>, canary = row.canary as Record<string, unknown> | undefined;
  if (typeof row.demo !== "boolean" || !canary || ![...CANARY_STATUSES, "demo"].includes(canary.status as CanaryStatus | "demo") || (row.demo !== (canary.status === "demo"))) return null;
  const summary = row.summary as Record<string, unknown> | null;
  if (summary !== null) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary) || ![...CANARY_STATUSES,"not_run"].includes(summary.canaryStatus as CanaryStatus | "not_run") || !["not_run","healthy","violations","incomplete","unavailable"].includes(String(summary.invariantsStatus))) return null;
    const counts = summary.invariantCounts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.entries(counts).some(([key,value]) => !INVARIANT_KEYS.includes(key as typeof INVARIANT_KEYS[number]) || !Number.isSafeInteger(value) || Number(value)<0)) return null;
    for (const key of ["canaryCheckedAt","canaryFailureAt","invariantsCheckedAt","lastMaintenanceAt"]) if (summary[key] !== null && (typeof summary[key] !== "string" || !Number.isFinite(Date.parse(summary[key] as string)))) return null;
  }
  return { demo: row.demo, canary: {status:canary.status as CanaryStatus | "demo"}, summary: summary as unknown as HealthSummary | null };
}
