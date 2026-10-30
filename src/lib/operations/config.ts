// Public constants and response shapes only; no key or reward value lives here.
export const CANARY_CREATOR = "00000000-0000-4000-8000-000000000063";
export const CANARY_PRIZE = "00000000-0000-4000-8000-000000000064";
export const CANARY_TEXT = "FanFunnel reward key canary v1";
export const INVENTORY_PAGE_SIZE = 500;
export const INVENTORY_MAX_ROWS = 25_000;
export const DIAGNOSTIC_MAX_ROWS = 100_000;
export const DIAGNOSTIC_TIMEOUT_MS = 3_000;
export const STARTUP_DEADLINE_MS = 5_000;
export const CANARY_STATUSES = ["healthy", "missing", "configuration_missing", "configuration_invalid", "mismatch", "unavailable"] as const;
export type CanaryStatus = typeof CANARY_STATUSES[number];
export type CanaryResult = { status: CanaryStatus; initialized?: boolean };
export const INVARIANT_KEYS = ["codeStockMismatch", "heldReservationMismatch", "liveChaseMissingReservation", "heldCodeMismatch", "orphanReservedCode", "unwitnessedStockReservation", "fanCreditMismatch"] as const;
export type InvariantStatus = "healthy" | "violations" | "incomplete" | "unavailable";
export type InvariantResult = { status: InvariantStatus; counts: Partial<Record<typeof INVARIANT_KEYS[number], number>>; rowLimit: number };
export interface HealthSummary {
  canaryStatus: CanaryStatus | "not_run";
  canaryCheckedAt: string | null;
  canaryFailureAt: string | null;
  invariantsStatus: InvariantStatus | "not_run";
  invariantCounts: Partial<Record<typeof INVARIANT_KEYS[number], number>>;
  invariantsCheckedAt: string | null;
  lastMaintenanceAt: string | null;
}
export interface OperationalResult {
  demo: boolean;
  ok: boolean;
  canary: CanaryResult | { status: "demo" };
  invariants: InvariantResult | { status: "demo"; counts: Record<string, never>; rowLimit: number };
  summary: HealthSummary | null;
}
