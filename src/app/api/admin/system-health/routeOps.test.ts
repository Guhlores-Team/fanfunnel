import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";

// OPS-08/09/10: System health names what is configured (booleans only, never a
// value), flags a stale maintenance job on Production with an alert, and shows
// the last rate-limit store fallback. Admins only, like the rest of the route.
let allowed = true, lastMaintenanceAt: string | null = null, stale = 0;
mock.module("@/lib/auth/admin", { namedExports: { requireAdminRoute: async () => allowed ? { ok: true, userId: "00000000-0000-4000-8000-000000000001" } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) } } });
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => ({}), createServiceClient: () => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ abortSignal: () => ({ maybeSingle: async () => ({ data: { last_seen: "2026-11-01T10:00:00.000Z" } }) }) }) }) }) }) }) }),
}) } });
mock.module("@/lib/operations/canary", { namedExports: { readCanary: async () => ({ status: "healthy" }), initializeCanaryForAdmin: async () => ({}) } });
mock.module("@/lib/operations/runtime", { namedExports: { readHealthSummary: async () => ({ canaryStatus: "healthy", canaryCheckedAt: null, canaryFailureAt: null, invariantsStatus: "healthy", invariantCounts: {}, invariantsCheckedAt: null, lastMaintenanceAt }), readSchemaVersion: async () => ({ status: "current", applied: 71, expected: 71 }), reportOperationalFailure: async () => undefined, runOperationalChecks: async () => ({ ok: true }) } });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });
mock.module("@/lib/data/audit", { namedExports: { recordAudit: async () => undefined } });
mock.module("@/lib/monitoring/opsAlerts", { namedExports: { reportMaintenanceStale: () => { stale++; }, RATE_LIMIT_FALLBACK_ROUTE: "/rate-limit-store" } });

const SECRET_VALUES = ["re_live_SECRETKEY", "owner@example.com", "cron-secret-cron-secret-1234", "https://hc-ping.com/secret-uuid", "https://up.example", "uptok"];
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
async function main() {
  Object.assign(process.env, { VERCEL_ENV: "production", RESEND_API_KEY: SECRET_VALUES[0], ALERT_EMAIL_TO: SECRET_VALUES[1], CRON_SECRET: SECRET_VALUES[2], HEARTBEAT_URL: SECRET_VALUES[3], UPSTASH_REDIS_REST_URL: SECRET_VALUES[4], UPSTASH_REDIS_REST_TOKEN: SECRET_VALUES[5] });
  const { GET } = await import("./route");
  let res = await GET(), raw = await res.text(), body = JSON.parse(raw);
  check("config is booleans by name", JSON.stringify(body.config) === JSON.stringify({ alertEmail: true, accountMail: true, push: false, sharedRateLimit: true, cronSecret: true, heartbeat: true }));
  check("no configured value ever appears in the response", SECRET_VALUES.every((v) => !raw.includes(v)));
  check("never-run maintenance is stale on Production", body.environment === "production" && body.maintenance.stale === true && body.maintenance.lastRanAt === null);
  check("…and raises the alertable capture", stale === 1);
  check("the last store fallback comes from Admin › Errors", body.rateLimitLastFallbackAt === "2026-11-01T10:00:00.000Z");

  lastMaintenanceAt = new Date(Date.now() - 31 * 3_600_000).toISOString();
  body = await (await GET()).json();
  check("31 h old is stale", body.maintenance.stale === true && body.maintenance.lastRanAt === lastMaintenanceAt && stale === 2);
  lastMaintenanceAt = new Date(Date.now() - 20 * 3_600_000).toISOString();
  body = await (await GET()).json();
  check("20 h old is fine, no alert", body.maintenance.stale === false && stale === 2);

  delete process.env.RESEND_API_KEY;
  body = await (await GET()).json();
  check("alert e-mails off is reported", body.config.alertEmail === false && body.config.accountMail === false);

  process.env.VERCEL_ENV = "preview";
  lastMaintenanceAt = null;
  body = await (await GET()).json();
  check("a Preview never alerts on maintenance age", body.maintenance.stale === false && stale === 2);

  allowed = false;
  res = await GET();
  raw = await res.text();
  check("a non-admin gets 403 and no flags", res.status === 403 && !raw.includes("config"));
  console.log(`system health ops status: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
