import assert from "node:assert";
import { rateLimitShared } from "./rateLimit";

// The shared limiter must find Vercel's Upstash integration (KV_REST_API_*), keep
// Preview and Production counters apart, and fall back to in-memory on errors.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Call = { url: string; auth: string; body: unknown[][] };
const calls: Call[] = [];
let failNext = false;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (failNext) {
    failNext = false;
    throw new Error("network down");
  }
  calls.push({
    url: String(url),
    auth: String((init.headers as Record<string, string>).Authorization),
    body: JSON.parse(String(init.body)),
  });
  return new Response(JSON.stringify([{ result: 1 }, { result: 1 }, { result: 60_000 }]), { status: 200 });
}) as typeof fetch;

const ENV_KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "VERCEL_ENV",
] as const;
function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

async function main() {
  setEnv({});
  await rateLimitShared("k1", 5, 60_000);
  check("no store configured: no network call (in-memory)", calls.length === 0);

  setEnv({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kvtok", VERCEL_ENV: "preview" });
  const r = await rateLimitShared("chat:1.2.3.4", 5, 60_000);
  check("Vercel's KV_REST_API_* vars are used", calls.length === 1 && calls[0].url === "https://kv.example/pipeline");
  check("with the KV token", calls[0].auth === "Bearer kvtok");
  check("the counter key is namespaced by environment", calls[0].body[0][1] === "rl:preview:chat:1.2.3.4");
  check("a call under the limit passes", r.ok);

  setEnv({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kvtok", VERCEL_ENV: "production" });
  await rateLimitShared("chat:1.2.3.4", 5, 60_000);
  check("production uses a separate counter from preview", calls[1].body[0][1] === "rl:production:chat:1.2.3.4");

  setEnv({
    UPSTASH_REDIS_REST_URL: "https://up.example",
    UPSTASH_REDIS_REST_TOKEN: "uptok",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "kvtok",
  });
  await rateLimitShared("k2", 5, 60_000);
  check("UPSTASH_* vars win when both pairs are set", calls[2].url === "https://up.example/pipeline" && calls[2].auth === "Bearer uptok");

  setEnv({ UPSTASH_REDIS_REST_URL: "https://up.example", KV_REST_API_TOKEN: "kvtok" });
  const before = calls.length;
  await rateLimitShared("k3", 5, 60_000);
  check("a URL is never paired with the other store's token", calls.length === before);

  setEnv({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kvtok" });
  failNext = true;
  const fallback = await rateLimitShared("k4", 5, 60_000);
  check("a store error falls back to in-memory instead of failing", fallback.ok === true);

  console.log(`rateLimitShared.test: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
