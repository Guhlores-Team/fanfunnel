import assert from "node:assert";
import { mock } from "node:test";
import { LEGAL } from "@/lib/legal";

// T2: the age and terms gate covers more than the spin. Until the fan behind a
// link confirms it, chat (send, read, auto intro/outro), wishlist edits and a
// leaderboard opt-in are refused with 403 `needs_ack`, and nothing is written
// or marked read. Withdrawing from the leaderboard and the Safety & privacy
// tools (export, self-exclude) stay reachable without it.
//   - demo path through the real route handlers;
//   - Supabase path: the data layer reads acked_at/acked_terms_version behind
//     the token with the spin's own check (fanNeedsAck).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Write = { table: string; op: string };
const writes: Write[] = [];
let PASS: Record<string, unknown> | null = null;
function fakeService() {
  return {
    from(table: string) {
      let op = "select";
      const result = (single = false) => {
        if (op !== "select") {
          writes.push({ table, op });
          return { data: null, error: null, count: 0 };
        }
        if (table === "fan_passes") return { data: PASS, error: null };
        if (table === "prizes") return { data: { id: "p1", rarity: "common" }, error: null };
        if (table === "profiles") return { data: { chat_intro: "hello", chat_outro: "bye" }, error: null };
        if (table === "messages") return { data: [{ id: "m1", sender: "creator", body: "unread", created_at: "2026-10-29T00:00:00Z", read_at: null }], error: null, count: 0 };
        if (table === "wheels") return { data: single ? { id: "w1", archived_at: null, game_kind: "wheel", game_ready: true } : [], error: null };
        return { data: null, error: null, count: 0 };
      };
      const proxy: unknown = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
          if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result(true));
          if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
            return () => { op = prop; return proxy; };
          }
          return () => proxy;
        },
      });
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
  const { POST: fanThread } = await import("@/app/api/messages/fan/thread/route");
  const { POST: wishAdd, DELETE: wishRemove } = await import("@/app/api/wishlists/route");
  const { POST: optIn } = await import("@/app/api/leaderboard/opt-in/route");
  const { POST: autoIntro } = await import("@/app/api/messages/auto-intro/route");
  const { POST: exportData } = await import("@/app/api/fan-data/export/route");

  const call = async (handler: (r: Request) => Promise<Response>, body: unknown, method = "POST") => {
    const res = await handler(new Request("http://localhost/api/x", {
      method,
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.21" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const refused = (r: { status: number; body: Record<string, unknown> | null }) => r.status === 403 && r.body?.error === "needs_ack";

  // --- demo path ---------------------------------------------------------------
  m.mockSetLeaderboardEnabled(true);
  const fan = m.mockCreatePass("Ungated Una", 3);
  const prize = m.mockGetWheel().prizes[0].label;
  check("demo: a new fan still needs the gate", (await m.mockGetFanPass(fan.token))?.needsAck === true);
  await data.sendCreatorMessage(fan.fanId, "a reply behind the gate");

  check("demo: chat send → 403 needs_ack", refused(await call(fanMessage, { token: fan.token, body: "hi" })));
  const read = await call(fanThread, { token: fan.token });
  check("demo: thread read → 403 needs_ack", refused(read));
  check("demo: …with no messages in the answer", !("messages" in (read.body ?? {})));
  const thread = await data.getThread(fan.fanId);
  check("demo: nothing was stored and the creator's reply stays unread",
    Array.isArray(thread) && !thread.some((x) => x.body === "hi") && thread.some((x) => x.body === "a reply behind the gate" && x.readAt === null));
  check("demo: auto intro → 403 needs_ack", refused(await call(autoIntro, { token: fan.token })));
  check("demo: auto outro refused", "error" in (await data.sendChatOutro(fan.token)));
  check("demo: wishlist add → 403 needs_ack", refused(await call(wishAdd, { token: fan.token, prizeLabel: prize })));
  check("demo: wishlist remove → 403 needs_ack", refused(await call(wishRemove, { token: fan.token, prizeLabel: prize }, "DELETE")));
  check("demo: the wishlist stayed empty", ((await m.mockGetFanPass(fan.token))?.wishlist ?? []).length === 0);
  check("demo: leaderboard opt-in → 403 needs_ack", refused(await call(optIn, { token: fan.token, optIn: true, handle: "una_g" })));
  check("demo: …and the fan is not on the board", !m.mockGetLeaderboard().entries.some((e) => e.handle === "una_g"));

  // Safety & privacy stays reachable behind the gate.
  check("demo: leaderboard opt-OUT works without the gate", (await call(optIn, { token: fan.token, optIn: false })).status === 200);
  check("demo: data export works without the gate", (await call(exportData, { token: fan.token })).status === 200);

  m.mockAckFan(fan.token);
  check("demo: after the gate, chat works", (await call(fanMessage, { token: fan.token, body: "hi" })).status === 200);
  check("demo: after the gate, the thread reads", (await call(fanThread, { token: fan.token })).status === 200);
  check("demo: after the gate, wishlist works", (await call(wishAdd, { token: fan.token, prizeLabel: prize })).status === 200);
  check("demo: after the gate, opt-in works", (await call(optIn, { token: fan.token, optIn: true, handle: "una_g" })).status === 200);

  // --- Supabase path -------------------------------------------------------------
  useSupabase = true;
  const base = {
    creator_id: "c1", campaign_id: null, wheel_id: "w1", fan_id: "f1", is_active: true, expires_at: null,
    creator: { is_active: true, approval_status: "approved", role: "creator" },
    fan: { id: "f1", spins_remaining: 2, spins_granted_total: 3, blocked_at: null, acked_at: null as string | null, acked_terms_version: null as string | null },
  };
  for (const [label, fanRow] of [
    ["never confirmed", { ...base.fan }],
    ["confirmed an old Terms version", { ...base.fan, acked_at: "2026-01-01T00:00:00Z", acked_terms_version: "2000-01-01" }],
  ] as const) {
    PASS = { ...base, fan: fanRow };
    writes.length = 0;
    const needsAck = '{"error":"needs_ack"}';
    check(`supabase (${label}): chat send`, JSON.stringify(await data.sendFanMessage("tok", "hi")) === needsAck);
    check(`supabase (${label}): thread read`, JSON.stringify(await data.getFanMessages("tok")) === needsAck);
    check(`supabase (${label}): wishlist add`, JSON.stringify(await data.addWishlist("tok", "Prize")) === needsAck);
    check(`supabase (${label}): wishlist remove`, JSON.stringify(await data.removeWishlist("tok", "Prize")) === needsAck);
    check(`supabase (${label}): opt-in`, JSON.stringify(await data.setFanLeaderboardOptIn("tok", true, "name")) === needsAck);
    check(`supabase (${label}): auto intro`, JSON.stringify(await data.ensureChatIntro("tok")) === needsAck);
    check(`supabase (${label}): auto outro`, JSON.stringify(await data.sendChatOutro("tok")) === needsAck);
    check(`supabase (${label}): nothing written or marked read`, writes.length === 0);
  }

  PASS = { ...base, fan: { ...base.fan, acked_at: "2026-10-29T00:00:00Z", acked_terms_version: LEGAL.version } };
  writes.length = 0;
  check("supabase: a confirmed fan reads the thread", Array.isArray(await data.getFanMessages("tok")));
  check("supabase: a confirmed fan's message is stored", "ok" in (await data.sendFanMessage("tok", "hi")));
  check("supabase: a confirmed fan's wishlist add is stored", "ok" in (await data.addWishlist("tok", "Prize")));
  check("supabase: the writes happened", writes.some((w) => w.table === "messages" && w.op === "insert") && writes.some((w) => w.table === "wishlists"));

  console.log(`fanAckGate.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
