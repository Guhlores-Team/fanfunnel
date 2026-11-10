import assert from "node:assert/strict";

// OPS-10: a slow or failing shared store answers from memory within
// RATE_LIMIT_STORE_TIMEOUT_MS, records when it happened (System health) and
// raises at most one alertable capture per instance per hour. The reporter is
// swapped through the module's seam, not a module mock. RS-06: after a failure
// the store is skipped for RATE_LIMIT_STORE_COOLDOWN_MS, then tried again.
// RS-08: a trailing slash on the store URL is tolerated. OPS3-10: the shared
// run lock uses the same store and the same fallback.
let reports = 0;

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const tick = () => new Promise((r) => setTimeout(r, 20));
/** Waits (up to 3 s) for the fire-and-forget report to land. */
async function settled(until: () => boolean) {
  for (let i = 0; i < 150 && !until(); i++) await tick();
}

async function main() {
  const keepAlive = setInterval(() => undefined, 1000);
  process.env.UPSTASH_REDIS_REST_URL = "https://up.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "uptok";
  const { rateLimitShared, rateLimitStoreLastFallbackAt, rateLimitStoreSkipFor, resetRateLimitStoreCooldown, tryAcquireSharedLock, upstashEnv, RATE_LIMIT_STORE_TIMEOUT_MS, RATE_LIMIT_STORE_COOLDOWN_MS, fallbackReporter } = await import("./rateLimit");
  check("RS-08: a trailing slash (or several) on the store URL is stripped", upstashEnv({ UPSTASH_REDIS_REST_URL: "https://up.example/", UPSTASH_REDIS_REST_TOKEN: "t" })?.url === "https://up.example" && upstashEnv({ KV_REST_API_URL: "https://kv.example// ", KV_REST_API_TOKEN: "t" })?.url === "https://kv.example");
  fallbackReporter.report = async () => { reports++; };
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
    await settled(() => reports >= 1);
    const at = rateLimitStoreLastFallbackAt();
    check("the fallback time is recorded", at !== null && Math.abs(Date.parse(at) - Date.now()) < 5000);
    check("one alertable capture", reports === 1);

    // RS-06: the failure started a cooldown: the next calls never touch the store.
    let storeCalls = 0;
    globalThis.fetch = (async () => { storeCalls++; return new Response("down", { status: 503 }); }) as typeof fetch;
    const t2 = Date.now();
    await rateLimitShared("fallback:b", 5, 60_000);
    await rateLimitShared("fallback:c", 5, 60_000);
    check(`RS-06: during the cooldown the store is skipped (no round trip, answered in ${Date.now() - t2} ms)`, storeCalls === 0 && Date.now() - t2 < 100 && rateLimitStoreSkipFor() > 0 && rateLimitStoreSkipFor() <= RATE_LIMIT_STORE_COOLDOWN_MS);
    check("the cooldown is 30 s", RATE_LIMIT_STORE_COOLDOWN_MS === 30_000);
    resetRateLimitStoreCooldown();
    await rateLimitShared("fallback:d", 5, 60_000);
    await tick();
    await tick();
    check("after the cooldown the store is tried once more (and a failure starts another)", storeCalls === 1 && rateLimitStoreSkipFor() > 0);
    check("repeats within the hour are not captured again", reports === 1);
    check("…but the time still moves", Date.parse(rateLimitStoreLastFallbackAt()!) >= Date.parse(at!));
    resetRateLimitStoreCooldown();
    globalThis.fetch = (async () => new Response(JSON.stringify([{ result: 1 }, { result: 1 }, { result: 60000 }]), { status: 200 })) as typeof fetch;
    check("a success ends the cooldown for good", (await rateLimitShared("fallback:e", 5, 60_000)).ok && rateLimitStoreSkipFor() === 0);

    // OPS3-10: the shared run lock (SET NX PX / DEL on the store).
    const sent: string[][][] = [];
    let setResult: unknown = "OK";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { const cmds = JSON.parse(String(init?.body)) as string[][]; sent.push(cmds); return new Response(JSON.stringify(cmds.map((c) => ({ result: c[0] === "SET" ? setResult : 1 }))), { status: 200 }); }) as typeof fetch;
    const lock = await tryAcquireSharedLock("cron:test", 1000);
    check("the lock is a SET NX PX on the shared store", lock.ok && sent[0][0][0] === "SET" && sent[0][0][3] === "NX" && sent[0][0][4] === "PX" && sent[0][0][5] === "1000" && !sent[0][0][1].includes("cron:test"));
    setResult = null;
    check("a second holder is refused while it is held", !(await tryAcquireSharedLock("cron:test", 1000)).ok);
    await lock.release();
    check("release deletes the key", sent.at(-1)?.[0][0] === "DEL");
    // Without a reachable store the lock is per instance, released the same way.
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const local = await tryAcquireSharedLock("cron:local", 1000);
    const again = await tryAcquireSharedLock("cron:local", 1000);
    await local.release();
    const after = await tryAcquireSharedLock("cron:local", 1000);
    check("store down: the lock still excludes a second holder on this instance and frees on release", local.ok && !again.ok && after.ok);
    await after.release();
    resetRateLimitStoreCooldown();
  } finally {
    globalThis.fetch = realFetch;
    clearInterval(keepAlive);
  }
  console.log(`rateLimitFallback: ${passed} checks passed`);
}
process.exitCode = 1;
main().then(() => { process.exitCode = 0; }, (e) => { console.error(e); process.exitCode = 1; });
