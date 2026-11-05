import assert from "node:assert";
import { mock } from "node:test";

// L6: anyone can reach GET /api/cron/retention. Negative tests: a flood from
// one client is cut off with 429 (no-store) before any work or alert, and the
// two alerts an unauthenticated caller can provoke (CRON_SECRET unset, a
// spoofed "vercel-cron/" User-Agent with a wrong secret) are recorded at most
// once per hour across every caller, then again in the next hour.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const captured: string[] = [];
mock.module("@/lib/monitoring/capture", {
  namedExports: {
    captureNow: async (e: { message: string }) => void captured.push(e.message),
    flushAlertDigest: async () => "none",
  },
});
mock.module("@/lib/supabase/server", {
  namedExports: { isSupabaseConfigured: () => false, createServiceClient: () => { throw new Error("never reached"); } },
});
mock.module("@/lib/data", { namedExports: { recordAudit: async () => {} } });

let now = Date.parse("2026-11-05T00:00:00Z");
Date.now = () => now;

async function main() {
  const { GET } = await import("./route");
  const SECRET = "s3cret-s3cret-s3cret-0123456789";
  let ip = 0;
  const call = (headers: Record<string, string> = {}, from = `198.51.100.${++ip % 250}`) =>
    GET(new Request("http://localhost/api/cron/retention", { headers: { "x-real-ip": from, ...headers } }));

  // Misconfigured: every caller gets 503, one alert per hour in total.
  delete process.env.CRON_SECRET;
  const unconfigured = await Promise.all(Array.from({ length: 20 }, () => call()));
  check("unset secret: every probe is refused with 503", unconfigured.every((r) => r.status === 503));
  check("unset secret: the alert is recorded once, not per probe", captured.filter((m) => /not configured/.test(m)).length === 1);
  now += 59 * 60 * 1000;
  await call();
  check("…and not again within the hour", captured.filter((m) => /not configured/.test(m)).length === 1);
  now += 2 * 60 * 1000;
  await call();
  check("…but again in the next hour (still broken, still loud)", captured.filter((m) => /not configured/.test(m)).length === 2);

  // Spoofed scheduler User-Agent with a wrong secret: 401, one alert per hour.
  process.env.CRON_SECRET = SECRET;
  captured.length = 0;
  const spoofed = await Promise.all(Array.from({ length: 20 }, () => call({ authorization: "Bearer guess", "user-agent": "vercel-cron/1.0" })));
  check("spoofed UA: every probe is 401", spoofed.every((r) => r.status === 401));
  check("spoofed UA: the mismatch alert is recorded once", captured.length === 1 && /does not match/.test(captured[0]));
  check("a plain probe is never alerted", (await call({ authorization: "Bearer guess" })).status === 401 && captured.length === 1);
  now += 61 * 60 * 1000;
  await call({ authorization: "Bearer guess", "user-agent": "vercel-cron/1.0" });
  check("the mismatch alert comes back in the next hour", captured.length === 2);

  // Per-client cap: one address flooding the route gets 429 before any work.
  captured.length = 0;
  delete process.env.CRON_SECRET;
  now += 61 * 60 * 1000;
  let last: Response | null = null;
  for (let i = 0; i < 31; i++) last = await call({}, "203.0.113.50");
  check("the 31st call in a minute from one client is 429", last!.status === 429);
  check("…with Retry-After and no-store", Number(last!.headers.get("retry-after")) >= 1 && last!.headers.get("cache-control") === "no-store");
  check("…and the flood raised exactly one alert", captured.length === 1);
  check("another client still gets the normal answer", (await call({}, "203.0.113.51")).status === 503);
  process.env.CRON_SECRET = SECRET;
  check("the scheduler with the right secret still runs (demo store)", (await call({ authorization: `Bearer ${SECRET}` }, "203.0.113.52")).status === 200);

  console.log(`retention cron abuse: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
