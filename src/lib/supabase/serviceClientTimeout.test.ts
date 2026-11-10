import assert from "node:assert/strict";

// OPS3-02: createServiceClient({ timeoutMs }) aborts every call made through
// that client after timeoutMs, and the query builder reports it as an error
// (never a hang, never a throw the data layer does not expect).
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  const { createServiceClient } = await import("./server");
  const keepAlive = setInterval(() => undefined, 1000);
  const realFetch = globalThis.fetch;
  let signals = 0;
  let attempts = 0;
  let answer: (() => Response) | null = null;
  // A hang: the promise settles only when the SDK's own signal aborts it, with
  // whatever reason that signal carries (exactly what undici's fetch does).
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((resolve, reject) => {
    attempts++;
    if (answer) return resolve(answer());
    if (init?.signal) { signals++; init.signal.addEventListener("abort", () => reject(init.signal!.reason)); }
  })) as typeof fetch;
  try {
    const t = Date.now();
    const { data, error } = await createServiceClient({ timeoutMs: 100 }).from("fan_passes").select("id").eq("token", "x").maybeSingle();
    const took = Date.now() - t;
    check(`a hanging query ends as an error after ~100 ms (took ${took} ms)`, data === null && !!error && took < 1500 && signals === 1);
    check(`…in ONE attempt: the SDK's read retries (1/2/4 s backoff) are off on a bounded client (${attempts} attempts)`, attempts === 1);
    // A 503 (paused or overloaded project) is what the SDK retries most eagerly.
    attempts = 0;
    answer = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    const t503 = Date.now();
    const unavailable = await createServiceClient({ timeoutMs: 100 }).from("fan_passes").select("id").eq("token", "x").maybeSingle();
    check(`a 503 is reported once, at once, on a bounded client (${attempts} attempts, ${Date.now() - t503} ms)`, !!unavailable.error && attempts === 1 && Date.now() - t503 < 500);
    const plainRest = (createServiceClient() as unknown as { rest?: { retry?: boolean } }).rest;
    check("the SDK still exposes the retry flag the bounded client clears (an upgrade that renames it fails here)", !!plainRest && "retry" in plainRest && plainRest.retry === undefined);
    answer = null;
    const t2 = Date.now();
    const rpc = await createServiceClient({ timeoutMs: 100 }).rpc("prepare_spin_attempt", { p_token: "x" });
    check("a hanging RPC ends as an error too", rpc.data === null && !!rpc.error && Date.now() - t2 < 1500);
    const plain = createServiceClient().from("fan_passes").select("id").eq("token", "x").maybeSingle();
    const outcome = await Promise.race([plain.then(() => "answered"), new Promise<string>((r) => setTimeout(() => r("still waiting"), 300))]);
    check("without timeoutMs nothing is added (the call simply waits)", outcome === "still waiting");
  } finally {
    globalThis.fetch = realFetch;
    clearInterval(keepAlive);
  }
  console.log(`service client timeout: ${passed} checks passed`);
}
process.exitCode = 1;
main().then(() => { process.exitCode = 0; }, (e) => { console.error(e); process.exitCode = 1; });
