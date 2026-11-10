import assert from "node:assert/strict";
import { mock } from "node:test";
import { LEGAL } from "@/lib/legal";

// FD-3: a suspended, deactivated or unapproved creator's fan link must not
// render as playable (no wheel, balance or tip link): getFanPass and the link's
// manifest read refuse it exactly as prepare_spin_attempt does (0071), and a
// prepare `unavailable` is a clear refusal, never "still being checked".
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let creator: Record<string, unknown> | null = null;
const selects: string[] = [];
const rpcs: string[] = [];
const PASS = () => ({
  id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", pinned_wheel_id: null, fan_id: "fan-1", is_active: true,
  spins_remaining: 3, next_server_seed_hash: "a".repeat(64),
  fan: { id: "fan-1", display_name: "Sam", handle: null, spins_remaining: 3, spins_granted_total: 3, referral_code: "R", acked_at: "2026-01-01T00:00:00Z", acked_terms_version: LEGAL.version, leaderboard_opt_in: false, blocked_at: null },
  creator,
});
function fakeClient() {
  const from = (table: string) => {
    const ops: { name: string; args: unknown[] }[] = [];
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => {
          const sel = String(ops.find(o => o.name === "select")?.args[0] ?? "");
          selects.push(`${table}:${sel}`);
          if (table !== "fan_passes") throw new Error(`a refused link must not read ${table}`);
          return Promise.resolve({ data: PASS(), error: null }).then(res);
        };
        return (...args: unknown[]) => { ops.push({ name: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return { from, rpc: async (name: string) => { rpcs.push(name); return { data: null, error: null }; } };
}
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true, createClient: async () => fakeClient(), createServiceClient: () => fakeClient(),
} });

async function main() {
  const { creatorCanHostPlay } = await import("./creatorPlayable");
  check("an active approved creator hosts play", creatorCanHostPlay({ is_active: true, approval_status: "approved", role: "creator" }));
  check("an active admin hosts play while unapproved", creatorCanHostPlay({ is_active: true, approval_status: "pending", role: "admin" }));
  check("a suspended creator does not", !creatorCanHostPlay({ is_active: false, approval_status: "approved", role: "creator" }));
  check("a suspended admin does not", !creatorCanHostPlay({ is_active: false, approval_status: "approved", role: "admin" }));
  check("a pending creator does not", !creatorCanHostPlay({ is_active: true, approval_status: "pending", role: "creator" }));
  check("a rejected creator does not", !creatorCanHostPlay({ is_active: true, approval_status: "rejected", role: "creator" }));
  check("an unknown standing does not", !creatorCanHostPlay({ approval_status: "approved" }) && !creatorCanHostPlay(null) && !creatorCanHostPlay(undefined));

  const { getFanPass } = await import("./spins");
  const { getFanAppInfo } = await import("./pwa");
  const token = "fan-token-standing";
  for (const [label, row] of [
    ["suspended", { is_active: false, approval_status: "approved", role: "creator" }],
    ["unapproved", { is_active: true, approval_status: "pending", role: "creator" }],
    ["rejected", { is_active: true, approval_status: "rejected", role: "creator" }],
    ["missing profile", null],
  ] as const) {
    creator = row === null ? null : { display_name: "Creator", tip_url: "https://tips.example/creator", leaderboard_enabled: false, creator_note: null, avatar_url: null, pwa_icon_mode: null, ...row };
    selects.length = 0; rpcs.length = 0;
    check(`${label}: the fan page is the "link not active" page (null)`, await getFanPass(token) === null);
    check(`${label}: no commitment, wheel or history read happens`, rpcs.length === 0 && selects.every(s => s.startsWith("fan_passes:")));
    selects.length = 0;
    check(`${label}: the link's manifest/icon read refuses it too`, await getFanAppInfo(token) === null
      && selects.some(s => s.startsWith("fan_passes:") && s.includes("is_active, approval_status, role")));
  }
  creator = { display_name: "Creator", tip_url: null, is_active: false, approval_status: "approved", role: "creator" };
  selects.length = 0;
  await getFanPass(token);
  check("getFanPass selects is_active, approval_status and role", /creator:profiles\([^)]*is_active[^)]*approval_status[^)]*role/.test(selects[0] ?? ""));

  // The spin path: prepare `unavailable` is a declined refusal the browser can release.
  const { FakeSpinLedger } = await import("./fakeSpinLedger");
  const { commitSpinAttempt } = await import("./spinAttempts");
  const l = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }], { balance: 4 }).init();
  l.prepareReply = { status: "unavailable" };
  const r = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "seed" }, l.client());
  check("prepare unavailable → blocked, not spin_pending", "error" in r && r.error === "blocked");
  // CC-02: the same refusal when the link/fan/creator went inactive BETWEEN
  // prepare and commit (commit answers `unavailable`), and on a cancel.
  const l2 = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }], { balance: 4 }).init();
  l2.commitReply = { status: "unavailable" };
  const r2 = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "seed" }, l2.client());
  check("CC-02: commit unavailable → blocked, never spin_pending", "error" in r2 && r2.error === "blocked");
  const l3 = await new FakeSpinLedger([{ id: "prize-1", weight: 1, stock: null }], { balance: 4 }).init();
  l3.prepareReply = { status: "ready", context: { ...(await (async () => { const c = l3.client(); const p = await c.rpc("prepare_spin_attempt", { p_attempt: crypto.randomUUID(), p_token: "tok", p_request_hash: "h" }); return (p.data as { context: unknown }).context as Record<string, unknown>; })()), wheel: { ...(l3.wheel as Record<string, unknown>), game_ready: false } }, balance: 4 };
  l3.commitReply = { status: "unavailable" };
  const r3 = await commitSpinAttempt("tok", { requestId: crypto.randomUUID(), clientSeed: "seed" }, l3.client());
  check("CC-02: cancel unavailable → blocked too", "error" in r3 && r3.error === "blocked");
  const { classifySpinStatus } = await import("@/components/fan/spinIntent");
  check("a declined blocked status releases the saved request", classifySpinStatus({ status: "declined", error: "blocked" }, true).kind === "declined");
  console.log(`fan pass creator standing: ${passed} checks passed`);
}
main().catch(e => { console.error(e); process.exit(1); });
