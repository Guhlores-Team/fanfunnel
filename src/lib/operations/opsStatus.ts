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
import { RATE_LIMIT_FALLBACK_ROUTE } from "@/lib/monitoring/opsAlerts";
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
