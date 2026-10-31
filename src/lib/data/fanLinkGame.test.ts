// 0065 "Change game for this fan only": setFanLinkGame authorizes from the
// signed session (can_act_for 'grant'), checks the game is the creator's own
// and playable, and only then calls the service RPC set_fan_pass_game with an
// actor context minted from that same session. The database side (actor
// recheck, tenant guard, playability) is proven in scripts/db/interplayProbe.mjs.
import assert from "node:assert/strict";
import { mock } from "node:test";
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
const CREATOR = "10000000-0000-4000-8000-000000000001", FAN = "30000000-0000-4000-8000-000000000003", PASS = "40000000-0000-4000-8000-000000000004";
const GAME = "50000000-0000-4000-8000-000000000005", TOKEN = "a".repeat(48);
let signedIn = true, allowed = true, wheel: Record<string, unknown> | null = { id: GAME, archived_at: null, game_kind: "wheel", game_ready: true };
let serviceAnswer: unknown = { status: "ok" };
const service: { name: string; args: Record<string, unknown> }[] = [];
const query = (table: string) => {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
    maybeSingle: async () => table === "fan_passes"
      ? { data: filters.token === TOKEN && filters.fan_id === FAN && filters.is_active === true ? { id: PASS, creator_id: CREATOR } : null, error: null }
      : { data: wheel && filters.id === wheel.id && filters.creator_id === CREATOR ? wheel : null, error: null },
  };
  return chain;
};
const session = {
  auth: { getUser: async () => ({ data: { user: signedIn ? { id: CREATOR } : null }, error: null }) },
  from: query,
  rpc: async (name: string) => name === "can_act_for" ? { data: allowed, error: null } : name === "issue_creator_actor_context" ? { data: "60000000-0000-4000-8000-000000000006", error: null } : { data: null, error: { message: "unexpected" } },
};
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => session,
  createServiceClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { service.push({ name, args }); return { data: serviceAnswer, error: null }; } }),
} });

async function main() {
  const { setFanLinkGame } = await import("./fans");
  const ok = await setFanLinkGame(FAN, TOKEN, GAME);
  check("ok" in ok, "the creator sets this fan's link to their own playable game");
  check(service.length === 1 && service[0].name === "set_fan_pass_game", "one service RPC call");
  const args = service[0].args;
  check(args.p_creator === CREATOR && args.p_pass === PASS && args.p_wheel === GAME && args.p_actor === CREATOR && args.p_context === "60000000-0000-4000-8000-000000000006", "the RPC gets the pass, the game, the real actor and the minted context");
  check("ok" in await setFanLinkGame(FAN, TOKEN, null) && service.at(-1)?.args.p_wheel === null, "null follows the campaign and live game again");
  const before = service.length;
  wheel = { ...wheel!, archived_at: "2026-10-01T00:00:00Z" };
  const archived = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in archived && archived.error === "game_not_playable" && service.length === before, "an archived game is refused before any service call");
  wheel = null;
  const foreign = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in foreign && foreign.error === "not_found" && service.length === before, "another creator's (or a missing) game is refused before any service call");
  wheel = { id: GAME, archived_at: null, game_kind: "wheel", game_ready: true };
  allowed = false;
  const denied = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in denied && denied.error === "forbidden" && service.length === before, "no grant permission: refused before any service call");
  allowed = true; signedIn = false;
  const anonymous = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in anonymous && anonymous.error === "unauthorized" && service.length === before, "signed out: refused");
  signedIn = true;
  const wrongFan = await setFanLinkGame("30000000-0000-4000-8000-0000000000ff", TOKEN, GAME);
  check("error" in wrongFan && wrongFan.error === "not_found", "a token from another fan is not found");
  check("error" in await setFanLinkGame(FAN, TOKEN, "not-a-uuid") && service.length === before, "a malformed game id never reaches the database");
  for (const [answer, expected] of [[{ status: "forbidden" }, "forbidden"], [{ status: "game_not_playable" }, "game_not_playable"], [{ status: "not_found" }, "not_found"], [{ status: "weird" }, "db_error"], [null, "db_error"]] as const) {
    serviceAnswer = answer;
    const result = await setFanLinkGame(FAN, TOKEN, GAME);
    check("error" in result && result.error === expected, `RPC ${JSON.stringify(answer)} maps to ${expected}`);
  }
  console.log(`fanLinkGame.test: ${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
