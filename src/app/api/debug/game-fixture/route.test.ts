import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";
let configured = true, admin = false, searches = 0, clients = 0;
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => configured, createClient: async () => { clients++; throw new Error("no client"); }, createServiceClient: () => { clients++; throw new Error("no service client"); } } });
mock.module("@/lib/auth/admin", { namedExports: { requireAdminRoute: async () => admin ? { ok: true, userId: null } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) } } });
mock.module("@/lib/data/mock", { namedExports: { mockGameFixture: async (token: string, clientSeed: string, targetPrizeId: string) => { searches++; assert.deepEqual([token,clientSeed,targetPrizeId], ["fixture-token","fixture-seed","target"]); return { nextServerSeedHash: "a".repeat(64), attempts: 2 }; } } });
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const { POST } = await import("./route");
  const post = (body: unknown, raw = false) => POST(new Request("http://localhost/api/debug/game-fixture", { method: "POST", body: raw ? String(body) : JSON.stringify(body) }));
  const body = { token: "fixture-token", clientSeed: "fixture-seed", targetPrizeId: "target" };
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1"; admin = true;
  check("configured backend is404 before seed search or admin power", (await post(body)).status === 404 && searches === 0);
  configured = false; delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  check("debug-off demo is404 before any seed search", (await post(body)).status === 404 && searches === 0);
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1"; admin = false;
  check("ordinary user cannot access demo seed search", (await post(body)).status === 403 && searches === 0);
  admin = true;
  for (const bad of [{ ...body, creatorId: "forged" }, { ...body, seed: "chosen-raw-seed" }, { token: "fixture-token", targetPrizeId: "target" }, { ...body, clientSeed: "a".repeat(257) }, { ...body, token: "a/b" }, [], null]) check("malformed/extra authority is refused before search", (await post(bad)).status === 400 && searches === 0);
  check("malformed JSON is controlled400", (await post("{bad",true)).status === 400 && searches === 0);
  const good = await post(body), json = await good.json();
  check("debug admin gets only bounded search metadata and no-store", good.status === 200 && good.headers.get("Cache-Control") === "no-store" && Object.keys(json).sort().join() === "attempts,nextServerSeedHash" && searches === 1);
  check("fixture never opens real database clients", clients === 0);
  delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  console.log(`debug game fixture: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
