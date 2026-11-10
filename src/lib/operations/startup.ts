import "server-only";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { bootstrapEmptyCanary } from "./canary";
import { persistHealth, readSchemaVersion, reportOperationalFailure } from "./runtime";
import { STARTUP_DEADLINE_MS } from "./config";
import { hasSharedRateLimitStore, rateLimitShared } from "@/lib/rateLimit";

/** RS-12: one instance per deployment runs the startup check within this window. */
export const STARTUP_CHECK_ONCE_PER_DEPLOYMENT_MS = 6 * 60 * 60 * 1000;

/**
 * RS-12: on Vercel every cold start of every instance ran the check (a spike
 * multiplied the system_health_checks writes). With a shared store the first
 * instance of a deployment claims it; the others skip (the nightly job and
 * Admin's "Run checks now" cover everything after). Without a store, or when
 * the store is unreachable, every instance still runs it as before.
 */
export async function startupCheckClaimed(env: Record<string, string | undefined> = process.env, claim: (key: string) => Promise<{ ok: boolean }> = (key) => rateLimitShared(key, 1, STARTUP_CHECK_ONCE_PER_DEPLOYMENT_MS)): Promise<boolean> {
  const deployment = env.VERCEL_DEPLOYMENT_ID;
  if (!deployment || !hasSharedRateLimitStore(env)) return true;
  try { return (await claim(`startup-check:${deployment}`)).ok; } catch { return true; }
}

export function startupChecksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // Only the explicitly marked GitHub local validation server omits deployment
  // health I/O. Any present Vercel marker keeps real deployment checks enabled.
  const ciLocalServer = env.FANFUNNEL_CI_LOCAL_SERVER === "1"
    && env.CI === "true" && env.GITHUB_ACTIONS === "true"
    && env.VERCEL === undefined && env.VERCEL_ENV === undefined && env.VERCEL_URL === undefined;
  return env.NEXT_RUNTIME === "nodejs" && env.NEXT_PHASE !== "phase-production-build" && !ciLocalServer;
}
const globalStartup = globalThis as unknown as { __ffOperationalStartup?: Promise<void> };
/** Once per server instance. It reads/validates an anchor, never per request.
 * Runtime transport has abort signals; this outer deadline also bounds alerts
 * so a database/mail outage cannot prevent the server accepting requests. */
export async function registerOperationalChecks(): Promise<void> {
  if (!startupChecksEnabled() || !isSupabaseConfigured()) return;
  if (globalStartup.__ffOperationalStartup) return globalStartup.__ffOperationalStartup;
  globalStartup.__ffOperationalStartup = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      if (!(await startupCheckClaimed())) return;
      const svc = createServiceClient();
      const [canary, schema] = await Promise.all([bootstrapEmptyCanary(svc), readSchemaVersion(svc)]);
      await persistHealth(svc, "startup", canary);
      // A39: a database behind this code's migration is reported (alerted), not fatal.
      await reportOperationalFailure(canary, undefined, schema);
    })().catch(() => undefined);
    try {
      await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, STARTUP_DEADLINE_MS); timer.unref?.(); })]);
    } finally { if (timer) clearTimeout(timer); }
  })();
  return globalStartup.__ffOperationalStartup;
}
