// Operational failures that used to reach only the server log (OPS-05, N7,
// OPS-16, OPS-10). Each becomes one FIXED, token-free message in Admin › Errors,
// so repeats group into one row and the first one e-mails ALERT_EMAIL_TO.
// Never put an address, endpoint, key, token or name into these messages.
import { rateLimit } from "@/lib/rateLimit";
import { captureAfterResponse, type CaptureInput } from "./capture";

type Capture = (input: CaptureInput) => void;

export type AccountMailKind = "approval" | "agency_invite" | "application_alert";
export const ACCOUNT_MAIL_FAILED: Record<AccountMailKind, string> = {
  approval: "Account e-mail was not sent: creator approval notice (check Resend key, domain and quota)",
  agency_invite: "Account e-mail was not sent: agency invitation (check Resend key, domain and quota)",
  application_alert: "Account e-mail was not sent: new creator request alert (check Resend key, domain and quota)",
};

/** A send that Resend refused or could not be reached ("failed") is captured; "sent"/"skipped" are not. */
export function reportAccountMail(kind: AccountMailKind, result: "sent" | "skipped" | "failed", capture: Capture = captureAfterResponse): void {
  if (result === "failed") capture({ source: "server", message: ACCOUNT_MAIL_FAILED[kind], route: "/account-mail" });
}

export const PUSH_FAILED = "Push delivery failed for a device that is not expired (check the VAPID key pair and the push service)";
/** N7: a failed push that is not a 404/410 prune. At most once a minute per instance. */
export function reportPushFailure(capture: Capture = captureAfterResponse, allow: () => boolean = () => rateLimit("ops-alert:push-failed", 1, 60_000).ok): void {
  if (allow()) capture({ source: "server", message: PUSH_FAILED, route: "/push" });
}

const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;
/** OPS-16: an admin action succeeded but its audit row was not written. */
export function auditNotWrittenMessage(action: string): string {
  return `Admin action succeeded but its audit entry was not written (${ACTION.test(action) ? action : "unknown action"})`;
}
export function reportAuditNotWritten(action: string, capture: Capture = captureAfterResponse): void {
  capture({ source: "server", message: auditNotWrittenMessage(action), route: "/admin-audit" });
}

export const RATE_LIMIT_FALLBACK = "Rate limit store unreachable: limits fell back to per-instance counters (check Upstash status and quota)";
export const RATE_LIMIT_FALLBACK_ROUTE = "/rate-limit-store";
/** OPS-10: the shared store failed. Hourly per instance; the caller throttles. */
export function reportRateLimitFallback(capture: Capture = captureAfterResponse): void {
  capture({ source: "server", message: RATE_LIMIT_FALLBACK, route: RATE_LIMIT_FALLBACK_ROUTE });
}

export const HEARTBEAT_FAILED = "Heartbeat ping was not accepted: check HEARTBEAT_URL and the monitor (the daily job itself ran)";
export const HEARTBEAT_ROUTE = "/heartbeat";
/** OPS3-08: the daily job ran but its heartbeat ping failed. */
export function reportHeartbeatFailed(capture: Capture = captureAfterResponse): void {
  capture({ source: "server", message: HEARTBEAT_FAILED, route: HEARTBEAT_ROUTE });
}

export const MAINTENANCE_STEPS = ["cleanup", "applicants", "health", "deletions", "storage", "push", "digest"] as const;
export type MaintenanceStep = (typeof MAINTENANCE_STEPS)[number];
/** OPS3-10: one fixed message per step, so the alert names what failed. */
export function maintenanceStepFailedMessage(step: MaintenanceStep, how: "failed" | "timed_out"): string {
  return `Maintenance step ${how === "timed_out" ? "timed out" : "failed"}: ${step} (the rest of the run continued)`;
}

export const MAINTENANCE_STALE = "Maintenance job has not run for over 30 hours: check the Vercel cron and CRON_SECRET";
/** OPS-08: the daily cron stopped. At most once an hour per instance. */
export function reportMaintenanceStale(capture: Capture = captureAfterResponse, allow: () => boolean = () => rateLimit("ops-alert:maintenance-stale", 1, 60 * 60_000).ok): void {
  if (allow()) capture({ source: "server", message: MAINTENANCE_STALE, route: "/api/cron/retention" });
}
