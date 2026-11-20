import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";
import { mockFocusState, clearMockFocusState } from "@/lib/data/mockFocus";
let configured = true, allowAdmin = false, clients = 0;
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createClient: async () => { clients++; throw new Error("must not open a client"); },
  createServiceClient: () => { clients++; throw new Error("must not open a service client"); },
} });
mock.module("@/lib/auth/admin", { namedExports: { requireAdminRoute: async () => allowAdmin ? { ok: true, userId: null } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) } } });
let passed = 0;
function check(label: string, condition: unknown) { assert.ok(condition, label); passed++; }
async function main() {
  const { POST } = await import("./route");
  const post = (body: unknown, raw = false) => POST(new Request("http://localhost/api/debug/focus-fixture", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) }));
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1";
  allowAdmin = true;
  check("real backend debug build still404 without change", (await post({ chaseEnabled: true })).status === 404 && !mockFocusState().chaseEnabled);
  configured = false; delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  check("demo without debug404 without change", (await post({ chaseEnabled: true })).status === 404 && !mockFocusState().chaseEnabled);
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1"; allowAdmin = false;
  check("admin refusal never changes fixture", (await post({ chaseEnabled: true })).status === 403 && !mockFocusState().chaseEnabled);
  allowAdmin = true;
  check("malformed JSON never changes fixture", (await post("{bad", true)).status === 400 && !mockFocusState().chaseEnabled);
  check("unknown creator/extra keys are refused", (await post({ chaseEnabled: true, creatorId: "real-target" })).status === 400 && !mockFocusState().chaseEnabled);
  check("nonboolean never changes fixture", (await post({ chaseEnabled: "true" })).status === 400 && !mockFocusState().chaseEnabled);
  const enabled = await post({ chaseEnabled: true });
  check("mock debug admin enables fixture with no-store", enabled.status === 200 && enabled.headers.get("Cache-Control") === "no-store" && mockFocusState().chaseEnabled);
  check("fixture cleanup disables chase", (await post({ chaseEnabled: false })).status === 200 && !mockFocusState().chaseEnabled);
  check("no database client was opened", clients === 0);
  mockFocusState().chaseEnabled = true; clearMockFocusState();
  check("clear/reset removes fixture override", !mockFocusState().chaseEnabled);
  delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  console.log(`debug focus fixture: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
