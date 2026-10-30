import assert from "node:assert/strict";
import { mock } from "node:test";
import { LEGAL } from "@/lib/legal";
const OWNER = "11111111-1111-4111-8111-111111111111";
const FAN = "22222222-2222-4222-8222-222222222222";
const PACK = "33333333-3333-4333-8333-333333333333";
const PRIZE = "44444444-4444-4444-8444-444444444444";
const PASS = "55555555-5555-4555-8555-555555555555";
let permissionAtMutation = true, revokeBeforeRpc = false, currentFocusId = PRIZE, releasedCount = 0;
let user: { id: string; user_metadata?: unknown } | null = null, permitted = false, visible = true, serviceClients = 0;
const calls: { name: string; args: Record<string, unknown> }[] = [];
type Resp = { data: unknown; error: null };
function query(data: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit"]) chain[method] = () => chain;
  chain.maybeSingle = async () => ({ data, error: null });
  chain.then = (resolve: (value: Resp) => unknown, reject: (error: unknown) => unknown) => Promise.resolve({ data, error: null } as Resp).then(resolve, reject);
  return chain;
}
const privateFocus = { id: "INTERNAL-FOCUS", fan_id: FAN, grant_id: "INTERNAL-GRANT", prize_id: PRIZE, prize_label: "Target", kind: "focus", multiplier: 3, total_spins: 5, spins_left: 5, chase_counter: 0, status: "active", cipher: "PRIVATE-REWARD" };
const service = {
  from: (table: string) => query(table === "fan_passes" ? { is_active: true, self_excluded_at: null, fan: { blocked_at: null, acked_at: "2026-01-01T00:00:00Z", acked_terms_version: LEGAL.version } } : []),
  rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "cancel_fan_focus") {
      if (revokeBeforeRpc) permissionAtMutation = false;
      if (args.p_actor !== user?.id || !permissionAtMutation) return { data: { status: "unavailable" }, error: null };
      if (args.p_focus !== currentFocusId) return { data: { status: "absent", focus: null }, error: null };
      releasedCount++;
      return { data: { status: "released", focus: { ...privateFocus, status: "cancelled" } }, error: null };
    }
    return { data: name === "grant_focus_pack" ? { status: "granted", focus: privateFocus, balance: 7, grantId: args.p_request, replayed: false }
      : name === "cancel_fan_focus" ? { status: "released", focus: { ...privateFocus, status: "cancelled" } }
      : name === "prepare_spin_attempt" ? { status: "declined", error: "no_spins" }
      : name === "get_spin_attempt_status" ? { status: "pending" }
      : { status: "ok", focus: privateFocus }, error: null };
  },
};
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: () => query(visible ? { creator_id: OWNER, blocked_at: null, break_until: null } : null),
    rpc: async (name: string) => ({ data: name === "can_act_for" ? permitted : false, error: null }) }),
  createServiceClient: () => { serviceClients++; return service; },
} });
mock.module("@/lib/rateLimit", { namedExports: { rateLimitShared: async () => ({ ok: true, retryAfter: 0 }) } });
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const creator = await import("@/app/api/fans/[fanId]/focus/route");
  const spin = await import("@/app/api/spin/route");
  const status = await import("@/app/api/spin/status/route");
  const context = { params: Promise.resolve({ fanId: FAN }) };
  const request = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const grant = { requestId: crypto.randomUUID(), packId: PACK, prizeId: PRIZE, passId: PASS, creatorId: "foreign", amountCents: 1, multiplier: 99, spins: 999 };
  check("anonymous creator grant401 and no privileged client", (await creator.POST(request("/api/fans/focus", grant), context)).status === 401 && serviceClients === 0);
  user = { id: OWNER, user_metadata: { role: "admin", is_admin: true } };
  check("client auth metadata cannot bypass explicit grant permission", (await creator.POST(request("/api/fans/focus", grant), context)).status === 403 && serviceClients === 0);
  permitted = true; visible = false;
  check("RLS-hidden foreign fan404 and no privileged client", (await creator.DELETE(request("/api/fans/focus", { focusId: PRIZE }), context)).status === 404 && serviceClients === 0);
  visible = true;
  const allowed = await creator.POST(request("/api/fans/focus", grant), context);
  const body = await allowed.json();
  check("authorized grant200 no-store", allowed.status === 200 && allowed.headers.get("Cache-Control") === "no-store");
  check("response strips internal focus/grant/fan/cipher fields", !/INTERNAL|PRIVATE|fan_id|grant_id|cipher/.test(JSON.stringify(body)));
  const write = calls.find(call => call.name === "grant_focus_pack")!;
  check("stored pack/prize references are the only supplied economics", write.args.p_creator === OWNER && write.args.p_fan === FAN && write.args.p_pack === PACK && write.args.p_prize === PRIZE && Object.keys(write.args).length === 7 && write.args.p_actor === OWNER);
  const before = calls.length;
  check("focus cancellation requires exact saved ID before RPC", (await creator.DELETE(request("/api/fans/focus", {}), context)).status === 400 && calls.length === before);
  const cancelled = await creator.DELETE(request("/api/fans/focus", { focusId: PRIZE }), context);
  const cancelledBody = await cancelled.json();
  check("focus cancellation binds exact target and response identity", cancelled.status === 200 && cancelledBody.focusId === PRIZE && calls.at(-1)?.args.p_focus === PRIZE && calls.at(-1)?.args.p_actor === OWNER);
  const manager = "66666666-6666-4666-8666-666666666666";
  user = { id: manager, user_metadata: { role: "admin" } };
  const agency = await creator.DELETE(request("/api/fans/focus", { focusId: PRIZE, actorId: OWNER }), context);
  check("authorized agency cancellation binds the actual actor, ignoring forged body actor", agency.status === 200 && calls.at(-1)?.args.p_actor === manager && calls.at(-1)?.args.p_creator === OWNER);
  const releasesBeforeRevocation = releasedCount;
  revokeBeforeRpc = true;
  const revoked = await creator.DELETE(request("/api/fans/focus", { focusId: PRIZE }), context);
  check("revocation after route admission is refused by the transaction boundary", revoked.status === 403 && (await revoked.json()).error === "forbidden" && releasedCount === releasesBeforeRevocation);
  check("revoked request preserves exact focus identity and actual actor", calls.at(-1)?.args.p_focus === PRIZE && calls.at(-1)?.args.p_actor === manager);
  revokeBeforeRpc = false; permissionAtMutation = true;
  currentFocusId = PACK;
  const stale = await creator.DELETE(request("/api/fans/focus", { focusId: PRIZE }), context);
  const staleBody = await stale.json();
  check("authorized stale focus cancellation cannot release a newer promise", stale.status === 200 && staleBody.focusId === PRIZE && staleBody.released === false && releasedCount === releasesBeforeRevocation);
  user = { id: OWNER };
  currentFocusId = PRIZE;
  const afterCancel = calls.length;
  check("invalid focus request UUID400 before write", (await creator.POST(request("/api/fans/focus", { ...grant, requestId: "bad" }), context)).status === 400 && calls.length === afterCancel);
  check("spin missing identity requires upgrade without RPC", (await spin.POST(request("/api/spin", { token: "valid-token" }))).status === 400 && calls.length === afterCancel);
  check("spin malformed identity400 without RPC", (await spin.POST(request("/api/spin", { token: "valid-token", requestId: "bad" }))).status === 400 && calls.length === afterCancel);
  check("spin oversized seed400 without RPC", (await spin.POST(request("/api/spin", { token: "valid-token", requestId: crypto.randomUUID(), clientSeed: "a".repeat(257) }))).status === 400 && calls.length === afterCancel);
  check("status requires token even with valid UUID", (await status.POST(request("/api/spin/status", { requestId: crypto.randomUUID() }))).status === 400 && calls.length === afterCancel);
  const payload = { token: "valid-token", requestId: crypto.randomUUID(), clientSeed: "bound", publishedSeedHash: "a".repeat(64) };
  const refused = await spin.POST(request("/api/spin", payload));
  check("atomic prepare refusal preserves domain code and no-store", refused.status === 409 && (await refused.json()).error === "no_spins" && refused.headers.get("Cache-Control") === "no-store");
  const pending = await status.POST(request("/api/spin/status", payload));
  check("pending remains authoritative pending and no-store", pending.status === 200 && (await pending.json()).status === "pending" && pending.headers.get("Cache-Control") === "no-store");
  const prepares = calls.filter(call => call.name === "prepare_spin_attempt");
  check("route sends exact browser identity and stable hashed binding", prepares[0]?.args.p_attempt === payload.requestId && prepares[0]?.args.p_request_hash === calls.find(call => call.name === "get_spin_attempt_status")?.args.p_request_hash);
  check("negative route cases never call old claim/refund writers", !calls.some(call => /claim_spin|rollback|credit_pass/.test(call.name)));
  console.log(`focus route boundaries: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
