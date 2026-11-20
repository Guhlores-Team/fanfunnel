import assert from "node:assert/strict";
import { rateLimit, rateLimitShared } from "./rateLimit";

const store = (globalThis as unknown as { __ffRateLimit: Map<string, { count: number; resetAt: number }> }).__ffRateLimit;
let checks = 0;
function check(value: unknown, message: string) { assert.ok(value, message); checks++; }
async function main() {
  store.clear();
  let now = 1_000_000_000;
  const clock = () => now;
  const privateKey = "reward:192.0.2.8:private-fan-bearer";
  check(rateLimit(privateKey, 1, 60_000, clock).ok, "first request passes");
  check([...store.keys()].every((key) => /^[a-f0-9]{64}$/.test(key)), "memory stores digest keys only");
  for (let i = 1; i < 10_000; i++) check(rateLimit(`other:${i}`, 5, 60_000, clock).ok, "fill bounded capacity");
  // A full table fails open on capacity (never on the count): a new identity
  // passes, room is made among windows still under their limit.
  check(rateLimit("overflow", 1, 60_000, clock).ok, "new identity passes at capacity");
  check(store.size <= 10_000, "unique identities cannot grow memory without bound");
  check(!rateLimit(privateKey, 1, 60_000, clock).ok, "overflow does not evict a blocked identity's limit");
  for (let i = 0; store.size < 10_000; i++) rateLimit(`refill:${i}`, 5, 60_000, clock);
  now += 60_000;
  check(rateLimit("overflow-2", 1, 60_000, clock).ok, "expired windows free capacity");
  check(store.size === 1, "expired counters are removed");
  store.clear();

  process.env.KV_REST_API_URL = "https://example.invalid";
  process.env.KV_REST_API_TOKEN = "fixture";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalFetch = globalThis.fetch;
  try {
    for (const [name, payload] of [
      ["missing", []],
      ["error", [{ error: "ERR" }, { result: 1 }, { result: 60000 }]],
      ["NaN", [{ result: "nonsense" }, { result: 1 }, { result: 60000 }]],
      ["zero", [{ result: 0 }, { result: 1 }, { result: 60000 }]],
    ] as const) {
      globalThis.fetch = (async (_url, init) => {
        check(init?.signal instanceof AbortSignal, "Redis transport has a bounded abort signal");
        return new Response(JSON.stringify(payload));
      }) as typeof fetch;
      check((await rateLimitShared(`bad-response:${name}`, 1, 60_000)).ok, "bad Redis reply falls back to local first request");
      check(!(await rateLimitShared(`bad-response:${name}`, 1, 60_000)).ok, "malformed Redis replies cannot bypass the fallback counter");
    }
  } finally { globalThis.fetch = originalFetch; }
  console.log(`rateLimitPrivacy: ${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
