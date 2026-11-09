import assert from "node:assert/strict";
import { mock } from "node:test";

// OPS-10: a slow or failing shared store answers from memory within
// RATE_LIMIT_STORE_TIMEOUT_MS, records when it happened (System health) and
// raises at most one alertable capture per instance per hour.
let reports = 0;
mock.module("@/lib/monitoring/opsAlerts", { namedExports: { reportRateLimitFallback: () => { reports++; } } });

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const tick = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  const keepAlive = setInterval(() => undefined, 1000);
  process.env.UPSTASH_REDIS_REST_URL = "https://up.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "uptok";
  const { rateLimitShared, rateLimitStoreLastFallbackAt, RATE_LIMIT_STORE_TIMEOUT_MS } = await import("./rateLimit");
  check("timeout is a constant well under a second", RATE_LIMIT_STORE_TIMEOUT_MS === 800);
  check("no fallback recorded yet", rateLimitStoreLastFallbackAt() === null);

  const realFetch = globalThis.fetch;
  try {
    // A store that never answers: the abort signal must end the wait.
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
    const t = Date.now();
    const r = await rateLimitShared("fallback:a", 5, 60_000);
    const took = Date.now() - t;
    check(`a hanging store falls back after ~${RATE_LIMIT_STORE_TIMEOUT_MS} ms (took ${took} ms)`, r.ok && took >= RATE_LIMIT_STORE_TIMEOUT_MS - 50 && took < RATE_LIMIT_STORE_TIMEOUT_MS + 1000);
    await tick();
    const at = rateLimitStoreLastFallbackAt();
    check("the fallback time is recorded", at !== null && Math.abs(Date.parse(at) - Date.now()) < 5000);
    check("one alertable capture", reports === 1);

    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    await rateLimitShared("fallback:b", 5, 60_000);
    await rateLimitShared("fallback:c", 5, 60_000);
    await tick();
    check("repeats within the hour are not captured again", reports === 1);
    check("…but the time still moves", Date.parse(rateLimitStoreLastFallbackAt()!) >= Date.parse(at!));
  } finally {
    globalThis.fetch = realFetch;
    clearInterval(keepAlive);
  }
  console.log(`rateLimitFallback: ${passed} checks passed`);
}
process.exitCode = 1;
main().then(() => { process.exitCode = 0; }, (e) => { console.error(e); process.exitCode = 1; });
