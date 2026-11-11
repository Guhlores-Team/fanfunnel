import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";

// FD-3 e2e support: the demo-only "suspend the demo creator" switch must be a
// 404 wherever real data exists, refuse non-admins, and touch no database.
let configured = true, admin = false, clients = 0;
const calls: boolean[] = [];
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => configured,
  createClient: async () => { clients++; throw new Error("no client"); }, createServiceClient: () => { clients++; throw new Error("no service client"); } } });
mock.module("@/lib/auth/admin", { namedExports: { requireAdminRoute: async () => admin ? { ok: true, userId: null }
  : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) } } });
mock.module("@/lib/data/mock", { namedExports: { mockSetDemoCreatorActive: (active: boolean) => { calls.push(active); return { active }; } } });
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const { POST } = await import("./route");
  const post = (body: unknown, raw = false) => POST(new Request("http://localhost/api/debug/creator-status", { method: "POST", body: raw ? String(body) : JSON.stringify(body) }));
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1"; admin = true;
  check("configured backend is a 404 before any change", (await post({ active: false })).status === 404 && calls.length === 0);
  configured = false; delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  check("a non-debug demo build is a 404", (await post({ active: false })).status === 404 && calls.length === 0);
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1"; admin = false;
  check("a non-admin cannot suspend the demo creator", (await post({ active: false })).status === 403 && calls.length === 0);
  admin = true;
  for (const bad of [{}, { active: "false" }, { active: false, creatorId: "other" }, [], null]) check("malformed body is a 400 " + JSON.stringify(bad), (await post(bad)).status === 400 && calls.length === 0);
  check("malformed JSON is a 400", (await post("{bad", true)).status === 400 && calls.length === 0);
  const res = await post({ active: false });
  check("debug admin suspends the demo creator, no-store", res.status === 200 && res.headers.get("Cache-Control") === "no-store" && (await res.json()).active === false && calls.join() === "false");
  check("no database client was opened", clients === 0);
  delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  console.log(`debug creator status: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
