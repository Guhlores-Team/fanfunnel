import "server-only";
// OPS-08/09/10: what System health shows about the parts that fail SILENTLY:
// whether each optional service is configured (by name only: never a value,
// a length or a prefix), whether the daily maintenance job is still running,
// and when this deployment last fell back from the shared rate-limit store.
import { alertConfig } from "@/lib/monitoring/alert";
import { accountMailConfig } from "@/lib/account/accountMail";
import { vapidKeys } from "@/lib/push/keys";
import { hasSharedRateLimitStore, rateLimitStoreLastFallbackAt } from "@/lib/rateLimit";
import { MIN_CRON_SECRET_LENGTH } from "@/lib/privacy/cron";
import { HEARTBEAT_ROUTE, RATE_LIMIT_FALLBACK_ROUTE } from "@/lib/monitoring/opsAlerts";
import { currentEnvironment, type ErrorEnvironment } from "@/lib/monitoring/config";
import type { createServiceClient } from "@/lib/supabase/server";

/** The daily cron is late once its last run is older than this (a day plus slack). */
export const MAINTENANCE_STALE_HOURS = 30;

export type OpsFlags = {
  alertEmail: boolean;
  accountMail: boolean;
  push: boolean;
  sharedRateLimit: boolean;
  cronSecret: boolean;
  heartbeat: boolean;
};

/** Booleans only, derived with the same rules the features themselves use. */
export function operationalFlags(env: Record<string, string | undefined> = process.env): OpsFlags {
  const heartbeat = (env.HEARTBEAT_URL ?? "").trim();
  return {
    alertEmail: alertConfig(env as NodeJS.ProcessEnv).enabled,
    accountMail: !!accountMailConfig(env as NodeJS.ProcessEnv).apiKey,
    push: vapidKeys(env) !== null,
    sharedRateLimit: hasSharedRateLimitStore(env),
    cronSecret: (env.CRON_SECRET ?? "").length >= MIN_CRON_SECRET_LENGTH,
    heartbeat: /^https:\/\/\S+$/.test(heartbeat),
  };
}

/** Red on Production when the job has never run or last ran too long ago. */
export function maintenanceStatus(lastRanAt: string | null | undefined, environment: ErrorEnvironment, now = Date.now()): { lastRanAt: string | null; stale: boolean } {
  const at = lastRanAt && Number.isFinite(Date.parse(lastRanAt)) ? lastRanAt : null;
  if (environment !== "production") return { lastRanAt: at, stale: false };
  return { lastRanAt: at, stale: at === null || now - Date.parse(at) > MAINTENANCE_STALE_HOURS * 3_600_000 };
}

export type HeartbeatStatus = { configured: boolean; lastResult: "sent" | "failed" | "never" | "off"; at: string | null };

/**
 * OPS3-08: what the heartbeat actually did, not just whether a URL is set.
 * The cron pings right after it persists last_maintenance_at and records one
 * fixed Admin › Errors row (HEARTBEAT_ROUTE) when the ping is refused, so:
 * a failure row newer than the last run minus a minute = the last ping
 * failed; otherwise the last run's ping was accepted.
 */
export function heartbeatStatus(configured: boolean, lastMaintenanceAt: string | null | undefined, lastFailureAt: string | null): HeartbeatStatus {
  if (!configured) return { configured: false, lastResult: "off", at: null };
  const ran = lastMaintenanceAt && Number.isFinite(Date.parse(lastMaintenanceAt)) ? lastMaintenanceAt : null;
  if (!ran) return { configured: true, lastResult: "never", at: null };
  const failed = lastFailureAt && Number.isFinite(Date.parse(lastFailureAt)) && Date.parse(lastFailureAt) >= Date.parse(ran) - 60_000;
  return failed ? { configured: true, lastResult: "failed", at: lastFailureAt } : { configured: true, lastResult: "sent", at: ran };
}

/** The newest Admin › Errors row for a fixed ops route, in this environment, or null. */
export async function lastOpsRowAt(svc: ReturnType<typeof createServiceClient> | null, route: string, environment: ErrorEnvironment = currentEnvironment()): Promise<string | null> {
  if (!svc) return null;
  try {
    const { data } = await svc.from("app_errors").select("last_seen").eq("environment", environment).eq("route", route)
      .order("last_seen", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(3_000)).maybeSingle();
    return typeof data?.last_seen === "string" ? data.last_seen : null;
  } catch { return null; }
}

/** OPS3-08: the heartbeat's last outcome, from the summary and the failure row. */
export async function readHeartbeatStatus(svc: ReturnType<typeof createServiceClient> | null, lastMaintenanceAt: string | null | undefined, env: Record<string, string | undefined> = process.env, environment: ErrorEnvironment = currentEnvironment()): Promise<HeartbeatStatus> {
  const configured = operationalFlags(env).heartbeat;
  return heartbeatStatus(configured, lastMaintenanceAt, configured ? await lastOpsRowAt(svc, HEARTBEAT_ROUTE, environment) : null);
}

/**
 * OPS3-08: when Resend last ACCEPTED an alert e-mail (app_error_alerts keeps
 * one row per accepted send; a refused send releases its row), or null. A
 * configured key that is wrong shows as "never accepted" here.
 */
export async function lastAlertMailAcceptedAt(svc: ReturnType<typeof createServiceClient> | null): Promise<string | null> {
  if (!svc) return null;
  try {
    const { data } = await svc.from("app_error_alerts").select("sent_at").order("sent_at", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(3_000)).maybeSingle();
    return typeof data?.sent_at === "string" ? data.sent_at : null;
  } catch { return null; }
}

/** Latest fallback seen by ANY instance (its Admin › Errors row), or this one's own. */
export async function lastRateLimitFallbackAt(svc: ReturnType<typeof createServiceClient> | null, environment: ErrorEnvironment = currentEnvironment()): Promise<string | null> {
  const own = rateLimitStoreLastFallbackAt();
  let stored: string | null = null;
  if (svc) {
    try {
      const { data } = await svc.from("app_errors").select("last_seen").eq("environment", environment).eq("route", RATE_LIMIT_FALLBACK_ROUTE)
        .order("last_seen", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(3_000)).maybeSingle();
      stored = typeof data?.last_seen === "string" ? data.last_seen : null;
    } catch { stored = null; }
  }
  if (!own) return stored;
  if (!stored) return own;
  return Date.parse(own) > Date.parse(stored) ? own : stored;
}
