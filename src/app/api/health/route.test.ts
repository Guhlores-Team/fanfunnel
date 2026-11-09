import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";

// OPS-02: /api/health answers 200/503 from the database, uncached, with no detail.
let configured = true, limited = false, rpcError: unknown = null, hang = false, throws = false, rpcName = "";
mock.module("@/lib/api/limit", { namedExports: { limitRoute: async () => limited ? NextResponse.json({ error: "rate_limited" }, { status: 429 }) : null } });
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createServiceClient: () => {
      if (throws) throw new Error("Supabase is not configured: https://secret-ref.supabase.co");
      return { rpc: (name: string) => { rpcName = name; return { abortSignal: (signal: AbortSignal) => hang
        ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve({ data: 71, error: rpcError }) }; } };
    },
  },
});
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
async function main() {
  // AbortSignal.timeout's timer is unref'd: keep the loop alive for the hang case.
  const keepAlive = setInterval(() => undefined, 1000);
  const { GET, HEALTH_TIMEOUT_MS } = await import("./route");
  const get = () => GET(new Request("http://localhost/api/health"));
  const noStore = (r: Response) => /no-store/.test(r.headers.get("cache-control") ?? "");

  let r = await get();
  check("healthy → 200 {ok:true}, no detail", r.status === 200 && JSON.stringify(await r.json()) === '{"ok":true}' && rpcName === "schema_version");
  check("healthy is never cached", noStore(r));
  rpcError = { code: "PGRST301", message: "JWT expired for host db.secret" };
  r = await get();
  check("rpc error → 503 {ok:false} without the error", r.status === 503 && JSON.stringify(await r.json()) === '{"ok":false}' && noStore(r));
  rpcError = null; throws = true;
  r = await get();
  check("misconfigured service client → 503 {ok:false}", r.status === 503 && JSON.stringify(await r.json()) === '{"ok":false}');
  throws = false; hang = true;
  const t = Date.now();
  r = await get();
  check(`a hanging database answers 503 within the ${HEALTH_TIMEOUT_MS} ms timeout`, r.status === 503 && Date.now() - t < HEALTH_TIMEOUT_MS + 1500);
  hang = false; limited = true;
  r = await get();
  check("rate limited → 429, not cached", r.status === 429 && noStore(r));
  limited = false; configured = false;
  r = await get();
  check("demo mode → 200 with mode demo", r.status === 200 && JSON.stringify(await r.json()) === '{"ok":true,"mode":"demo"}' && noStore(r));
  clearInterval(keepAlive);
  console.log(`health route: ${passed} checks passed`);
}
process.exitCode = 1; // set to 0 only when every check ran
main().then(() => { process.exitCode = 0; }, (e) => { console.error(e); process.exitCode = 1; });
