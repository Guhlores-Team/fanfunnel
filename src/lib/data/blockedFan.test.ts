import assert from "node:assert";
import { mock } from "node:test";

// A4: blocking a fan really stops them reaching the creator. A blocked fan's
// chat sends, auto intro/outro, wishlist edits and leaderboard opt-in are
// refused server-side with 403 `blocked`; opting OUT of the leaderboard (a
// consent withdrawal) always works; unblocking restores everything.
//   - demo path through the real route handlers;
//   - Supabase path: the data layer reads fans.blocked_at behind the token and
//     never writes for a blocked fan.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- a scripted service client for the Supabase path --------------------------
type Write = { table: string; op: string; payload: unknown };
const writes: Write[] = [];
let PASS: Record<string, unknown> | null = null;
function fakeService() {
  return {
    from(table: string) {
      let op = "select";
      let payload: unknown = null;
      const result = (single = false) => {
        if (op !== "select") {
          writes.push({ table, op, payload });
          return { data: null, error: null, count: 0 };
        }
        if (table === "fan_passes") return { data: PASS, error: null };
        if (table === "prizes") return { data: { id: "p1", rarity: "common" }, error: null };
        if (table === "profiles") return { data: { chat_intro: "hello", chat_outro: "bye" }, error: null };
        // A published, playable wheel (0060/0061 game_kind + game_ready; liveGame.ts).
        if (table === "wheels") return { data: single ? { id: "w1", archived_at: null, game_kind: "wheel", game_ready: true } : [], error: null };
        return { data: null, error: null, count: 0 };
      };
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
            if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result(true));
            if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
              return (p?: unknown) => {
                op = prop;
                payload = p ?? null;
                return proxy;
              };
            }
            return () => proxy;
          },
        },
      );
      return proxy;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

let useSupabase = false;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => fakeService(),
    createServiceClient: () => fakeService(),
  },
});

async function main() {
  const data = await import("./index");
  const m = await import("./mock");
  const { POST: fanMessage } = await import("@/app/api/messages/fan/route");
  const { POST: wishAdd, DELETE: wishRemove } = await import("@/app/api/wishlists/route");
  const { POST: optIn } = await import("@/app/api/leaderboard/opt-in/route");

  const call = async (handler: (r: Request) => Promise<Response>, body: unknown, method = "POST") => {
    const res = await handler(new Request("http://localhost/api/x", {
      method,
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  // --- demo path, through the routes ---------------------------------------------
  const fan = m.mockCreatePass("Blocked Fan", 3);
  m.mockAckFan(fan.token);
  const prize = m.mockGetWheel().prizes[0].label;
  check("demo: before the block, chat works", (await call(fanMessage, { token: fan.token, body: "hi" })).status === 200);
  check("demo: before the block, wishlist works", (await call(wishAdd, { token: fan.token, prizeLabel: prize })).status === 200);
  check("demo: before the block, opt-in works", (await call(optIn, { token: fan.token, optIn: true, handle: "blockme" })).status === 200);

  await data.setFanBlocked(fan.fanId, true);
  const sent = await call(fanMessage, { token: fan.token, body: "let me in" });
  check("demo: a blocked fan's message → 403 blocked", sent.status === 403 && sent.body?.error === "blocked");
  const thread = await data.getThread(fan.fanId);
  check("demo: the message was not stored", Array.isArray(thread) && !thread.some((x) => x.body === "let me in"));
  const add = await call(wishAdd, { token: fan.token, prizeLabel: prize });
  check("demo: a blocked fan's wishlist add → 403 blocked", add.status === 403 && add.body?.error === "blocked");
  const remove = await call(wishRemove, { token: fan.token, prizeLabel: prize }, "DELETE");
  check("demo: a blocked fan's wishlist remove → 403 blocked", remove.status === 403 && remove.body?.error === "blocked");
  const join = await call(optIn, { token: fan.token, optIn: true, handle: "blockme" });
  check("demo: a blocked fan's leaderboard opt-in → 403 blocked", join.status === 403 && join.body?.error === "blocked");
  check("demo: …but opting out (withdrawing consent) still works", (await call(optIn, { token: fan.token, optIn: false })).status === 200);
  check("demo: auto intro refused", "error" in (await data.ensureChatIntro(fan.token)));
  check("demo: auto outro refused", "error" in (await data.sendChatOutro(fan.token)));

  await data.setFanBlocked(fan.fanId, false);
  check("demo: unblocked, chat works again", (await call(fanMessage, { token: fan.token, body: "back" })).status === 200);
  check("demo: unblocked, wishlist works again", (await call(wishRemove, { token: fan.token, prizeLabel: prize }, "DELETE")).status === 200);

  // --- Supabase path ----------------------------------------------------------------
  useSupabase = true;
  const blockedPass = {
    creator_id: "c1", campaign_id: null, wheel_id: "w1", fan_id: "f1",
    fan: { id: "f1", spins_remaining: 2, spins_granted_total: 3, blocked_at: "2026-10-29T00:00:00Z" },
  };
  PASS = blockedPass;
  writes.length = 0;
  check("supabase: blocked chat send", JSON.stringify(await data.sendFanMessage("tok-blocked", "hi")) === '{"error":"blocked"}');
  check("supabase: blocked wishlist add", JSON.stringify(await data.addWishlist("tok-blocked", "Prize")) === '{"error":"blocked"}');
  check("supabase: blocked wishlist remove", JSON.stringify(await data.removeWishlist("tok-blocked", "Prize")) === '{"error":"blocked"}');
  check("supabase: blocked opt-in", JSON.stringify(await data.setFanLeaderboardOptIn("tok-blocked", true, "name")) === '{"error":"blocked"}');
  check("supabase: blocked auto intro", JSON.stringify(await data.ensureChatIntro("tok-blocked")) === '{"error":"blocked"}');
  check("supabase: blocked auto outro", JSON.stringify(await data.sendChatOutro("tok-blocked")) === '{"error":"blocked"}');
  check("supabase: nothing was written for a blocked fan", writes.length === 0);

  PASS = { ...blockedPass, fan: null };
  check("supabase: chat with no readable fan row sends nothing", "error" in (await data.sendFanMessage("tok-x", "hi")));
  check("supabase: still nothing written", writes.length === 0);

  PASS = { ...blockedPass, fan: { ...blockedPass.fan, blocked_at: null } };
  check("supabase: an unblocked fan's message is stored", "ok" in (await data.sendFanMessage("tok-ok", "hi")));
  check("supabase: an unblocked fan's wishlist add is stored", "ok" in (await data.addWishlist("tok-ok", "Prize")));
  check("supabase: the writes happened", writes.some((w) => w.table === "messages") && writes.some((w) => w.table === "wishlists"));

  console.log(`blockedFan.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
