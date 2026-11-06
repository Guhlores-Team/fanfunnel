import assert from "node:assert/strict";
import { mock } from "node:test";
import { LEGAL } from "@/lib/legal";

let blockedAt: string | null = null;
let configured = true;
const selects: string[] = [];
const row = () => ({ id: "pass", creator_id: "creator", campaign_id: null, wheel_id: "wheel", fan_id: "own-fan", is_active: true,
  spins_remaining: 3, next_server_seed_hash: "a".repeat(64),
  fan: { id: "own-fan", display_name: "Fan", handle: null, spins_remaining: 3, spins_granted_total: 3, referral_code: "REF",
    acked_at: "2026-10-28T00:00:00Z", acked_terms_version: LEGAL.version, blocked_at: blockedAt },
  creator: { display_name: "Creator" } });
function client() {
  return { from(table: string) {
    const result = () => ({ data: table === "fan_passes" ? row() : table === "wheels"
      ? { id: "wheel", title: "Wheel", prizes: [{ id: "prize", label: "Award", rarity: "common", weight: 1 }] } : [], error: null });
    const chain: unknown = new Proxy({}, { get(_target, prop) {
      if (prop === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return (...args: unknown[]) => { if (prop === "select") selects.push(String(args[0])); return chain; };
    } });
    return chain;
  } };
}
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => configured, createServiceClient: client, createClient: client } });
mock.module("./wheels", { namedExports: { resolveWheelId: async () => "wheel", getActiveHappyHour: async () => null } });
mock.module("./playGuard", { namedExports: { readPlayState: async () => ({ today: 0, week: 0, reminder: null, breakUntil: null }) } });
mock.module("./checkins", { namedExports: { readFanGlow: async () => null } });
mock.module("./focus", { namedExports: { getFanFocusDisplay: async () => ({ focus: null }) } });
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const { getFanPass } = await import("./spins");
  for (const blocked of [false, true]) {
    blockedAt = blocked ? "2026-10-28T00:00:00Z" : null;
    const view = await getFanPass("own-token");
    check("configured own blocked link retains readable history", view && view.spinsRemaining === 3);
    check("configured projection carries own block boolean", view?.blocked === blocked);
    check("configured projection selects block state from the same fan relation", selects.some(select => /fan:fans\([^)]*blocked_at/.test(select)));
    check("fan projection carries no block timestamp or other fan identity", !JSON.stringify(view).includes("blocked_at") && !JSON.stringify(view).includes("own-fan"));
  }
  configured = false;
  const { mockCreatePass, mockSetFanBlocked } = await import("./mock");
  const fan = mockCreatePass("Own fan", 3);
  const other = mockCreatePass("Other fan", 4);
  check("mock active link starts explicitly unblocked", (await getFanPass(fan.token))?.blocked === false);
  mockSetFanBlocked(fan.fanId, true);
  const view = await getFanPass(fan.token);
  check("mock blocked link remains readable with explicit own block", view?.blocked === true && view.spinsRemaining === 3);
  check("another fan's block state is independent", (await getFanPass(other.token))?.blocked === false);
  check("mock public view contains no block timestamp or private identity", !JSON.stringify(view).includes("blockedAt") && !JSON.stringify(view).includes(fan.fanId));
  mockSetFanBlocked(fan.fanId, false);
  check("unblocking restores projection without reminting the link", (await getFanPass(fan.token))?.blocked === false);
  console.log(`fanEngagementProjection: ${passed} configured/mock own-fan projection checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
