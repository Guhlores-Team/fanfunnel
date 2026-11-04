// 0065 "Change game for this fan only": setFanLinkGame authorizes from the
// signed session (can_act_for 'grant'), checks the game is the creator's own
// and playable, and only then calls the service RPC set_fan_pass_game with an
// actor context minted from that same session. The database side (actor
// recheck, tenant guard, playability) is proven in scripts/db/interplayProbe.mjs.
// AGENTS.md negative test: a creator can never set a game on another creator's
// fan link, nor point their own link at another creator's game, through the
// data layer or the route.
import assert from "node:assert/strict";
import { mock } from "node:test";
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
const CREATOR = "10000000-0000-4000-8000-000000000001", OTHER = "20000000-0000-4000-8000-000000000002";
const FAN = "30000000-0000-4000-8000-000000000003", PASS = "40000000-0000-4000-8000-000000000004";
const OTHER_FAN = "30000000-0000-4000-8000-0000000000aa", OTHER_PASS = "40000000-0000-4000-8000-0000000000aa";
const GAME = "50000000-0000-4000-8000-000000000005", OTHER_GAME = "50000000-0000-4000-8000-0000000000aa";
const TOKEN = "a".repeat(48), OTHER_TOKEN = "b".repeat(48);
let signedIn = true, allowed = true;
let wheel: Record<string, unknown> | null = { id: GAME, creator_id: CREATOR, archived_at: null, game_kind: "wheel", game_ready: true };
const otherWheel = { id: OTHER_GAME, creator_id: OTHER, archived_at: null, game_kind: "wheel", game_ready: true };
// Passes the session can read (RLS: its own, plus a creator it views for as a
// team member). Reading a pass is not authority to change it.
const passes = [
  { id: PASS, token: TOKEN, fan_id: FAN, creator_id: CREATOR, is_active: true },
  { id: OTHER_PASS, token: OTHER_TOKEN, fan_id: OTHER_FAN, creator_id: OTHER, is_active: true },
];
let serviceAnswer: unknown = { status: "ok" };
const service: { name: string; args: Record<string, unknown> }[] = [];
const permissionAsks: Record<string, unknown>[] = [];
const query = (table: string) => {
  const filters: Record<string, unknown> = {};
  const matches = (row: Record<string, unknown>) => Object.entries(filters).every(([key, value]) => row[key] === value);
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
    maybeSingle: async () => {
      if (table === "fan_passes") {
        const row = passes.find(matches);
        return { data: row ? { id: row.id, creator_id: row.creator_id } : null, error: null };
      }
      return { data: [wheel, otherWheel].find((row) => row && matches(row)) ?? null, error: null };
    },
  };
  return chain;
};
const session = {
  auth: { getUser: async () => ({ data: { user: signedIn ? { id: CREATOR } : null }, error: null }) },
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "can_act_for") { permissionAsks.push(args); return { data: allowed && args.target_creator === CREATOR && args.perm === "grant", error: null }; }
    if (name === "issue_creator_actor_context") return { data: "60000000-0000-4000-8000-000000000006", error: null };
    return { data: null, error: { message: "unexpected" } };
  },
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
  check(permissionAsks.at(-1)?.target_creator === CREATOR && permissionAsks.at(-1)?.perm === "grant", "authority is can_act_for(the link's creator, 'grant'), asked server-side");
  check("ok" in await setFanLinkGame(FAN, TOKEN, null) && service.at(-1)?.args.p_wheel === null, "null follows the campaign and live game again");
  const before = service.length;

  // Negative: another creator's fan link (readable, but not this creator's to change).
  const foreignLink = await setFanLinkGame(OTHER_FAN, OTHER_TOKEN, GAME);
  check("error" in foreignLink && foreignLink.error === "forbidden" && service.length === before, "a creator cannot set a game on another creator's fan link");
  check(permissionAsks.at(-1)?.target_creator === OTHER, "the permission asked is for the link's real owner, never the caller");
  const foreignLinkOwnGame = await setFanLinkGame(OTHER_FAN, OTHER_TOKEN, OTHER_GAME);
  check("error" in foreignLinkOwnGame && foreignLinkOwnGame.error === "forbidden" && service.length === before, "nor with that creator's own game");
  // Negative: this creator's link, another creator's game.
  const foreignGame = await setFanLinkGame(FAN, TOKEN, OTHER_GAME);
  check("error" in foreignGame && foreignGame.error === "not_found" && service.length === before, "a creator cannot point their fan's link at another creator's game");
  // Negative: a link token paired with the wrong fan id.
  const mismatched = await setFanLinkGame(FAN, OTHER_TOKEN, GAME);
  check("error" in mismatched && mismatched.error === "not_found" && service.length === before, "another fan's token under this fan's id is not found");

  wheel = { ...wheel!, archived_at: "2026-10-01T00:00:00Z" };
  const archived = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in archived && archived.error === "game_not_playable" && service.length === before, "an archived game is refused before any service call");
  wheel = { ...wheel!, archived_at: null, game_ready: false };
  const draft = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in draft && draft.error === "game_not_playable" && service.length === before, "a draft game is refused before any service call");
  wheel = null;
  const missing = await setFanLinkGame(FAN, TOKEN, GAME);
  check("error" in missing && missing.error === "not_found" && service.length === before, "a missing game is refused before any service call");
  wheel = { id: GAME, creator_id: CREATOR, archived_at: null, game_kind: "wheel", game_ready: true };
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
  serviceAnswer = { status: "ok" };

  // The route: body validation, then the data layer's answer as an HTTP status.
  const { POST } = await import("@/app/api/fans/[fanId]/link-game/route");
  const call = (fanId: string, body: unknown) => POST(new Request(`http://local/api/fans/${fanId}/link-game`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ fanId }) });
  const served = service.length;
  const routeOk = await call(FAN, { token: TOKEN, wheelId: GAME });
  check(routeOk.status === 200 && (await routeOk.json()).ok === true && routeOk.headers.get("Cache-Control") === "no-store" && service.length === served + 1, "the route sets this creator's own link");
  const routeForeign = await call(OTHER_FAN, { token: OTHER_TOKEN, wheelId: OTHER_GAME });
  check(routeForeign.status === 403 && (await routeForeign.json()).error === "forbidden" && service.length === served + 1, "the route answers 403 for another creator's fan link");
  const routeForeignGame = await call(FAN, { token: TOKEN, wheelId: OTHER_GAME });
  check(routeForeignGame.status === 404 && service.length === served + 1, "the route answers 404 for another creator's game");
  for (const body of ["{not json", { token: TOKEN }, { token: 5, wheelId: GAME }, { token: TOKEN, wheelId: 7 }]) {
    const bad = await call(FAN, body);
    check(bad.status === 400 && service.length === served + 1, `the route refuses a malformed body (${typeof body === "string" ? body : JSON.stringify(body)})`);
  }
  signedIn = false;
  check((await call(FAN, { token: TOKEN, wheelId: GAME })).status === 401 && service.length === served + 1, "the route answers 401 when signed out");
  signedIn = true;
  console.log(`fanLinkGame.test: ${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
