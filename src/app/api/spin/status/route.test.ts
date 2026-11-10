import assert from "node:assert/strict";
import { mock } from "node:test";

// RS-01 (0073): the status read for a token no link carries is a 404, which
// withFanToken counts against the caller's fan-token miss budget; a known but
// paused link stays 503, a conflict 409, everything else 200.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

let status: Record<string, unknown> = { status: "absent" };
mock.module("@/lib/data", { namedExports: { getSpinAttemptStatus: async () => status } });
const misses: string[] = [];
mock.module("@/lib/api/fanMiss", { namedExports: {
  withFanMissLimit: async (_req: Request, run: () => Promise<Response>, token?: string) => { const res = await run(); if (res.status === 404) misses.push(String(token)); return res; },
} });

async function main() {
  const { POST } = await import("./route");
  const call = (token: string) => POST(new Request("http://localhost/api/spin/status", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
    body: JSON.stringify({ token, requestId: crypto.randomUUID(), clientSeed: "seed" }) }));

  status = { status: "not_found" };
  let res = await call("unknown-token-0001");
  check("not_found → 404 {error:not_found}, no-store", res.status === 404 && (await res.json()).error === "not_found" && res.headers.get("cache-control") === "no-store");
  check("…and the miss is counted for that caller", misses.length === 1 && misses[0] === "unknown-token-0001");
  for (const [s, code] of [["absent", 200], ["pending", 200], ["unavailable", 503], ["conflict", 409]] as const) {
    status = { status: s };
    res = await call("known-token-0002");
    check(`${s} → ${code}`, res.status === code && (await res.json()).status === s);
  }
  status = { status: "declined", error: "db_error" };
  res = await call("known-token-0002");
  check("a declined (stale) attempt → 200 so the browser releases the saved request", res.status === 200 && (await res.json()).error === "db_error");
  check("only the unknown token was a miss", misses.length === 1);
  console.log(`spin status route: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
