import "server-only";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { bootstrapEmptyCanary } from "./canary";
import { persistHealth, reportOperationalFailure } from "./runtime";
import { STARTUP_DEADLINE_MS } from "./config";

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
      const svc = createServiceClient();
      const canary = await bootstrapEmptyCanary(svc);
      await persistHealth(svc, "startup", canary);
      await reportOperationalFailure(canary);
    })().catch(() => undefined);
    try {
      await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, STARTUP_DEADLINE_MS); timer.unref?.(); })]);
    } finally { if (timer) clearTimeout(timer); }
  })();
  return globalStartup.__ffOperationalStartup;
}
