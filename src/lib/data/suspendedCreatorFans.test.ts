import assert from "node:assert";
import { mock } from "node:test";
import { LEGAL } from "@/lib/legal";

// A suspended creator is read-only, and so is everything a fan's link can do
// TO them. With a valid link token these fan routes answer the same "link not
// active" (404 not_found) the fan page gives, store nothing and send no push:
//   chat send, the auto intro and outro, wishlist add and remove, the board
//   opt-in, the visit check-in and the age-gate acknowledgement.
// What is the fan's own stays open: a break, pausing the link, a report, the
// data download and deletion, reopening a reward, leaving the board.
//   - demo path through the real route handlers;
//   - Supabase path: the data layer reads the creator's standing with the link
//     (creatorCanHostPlay, the fan page's own test) and never writes.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- a scripted service client for the Supabase path --------------------------
type Write = { table: string; op: string; payload: unknown };
const writes: Write[] = [];
const rpcs: string[] = [];
let PASS: Record<string, unknown> | null = null;
function fakeService() {
  return {
    from(table: string) {
      let op = "select";
      let payload: unknown = null;
      const result = (single = false) => {
        if (op !== "select") {
          writes.push({ table, op, payload });
          return { data: op === "upsert" ? [{ day: "2026-11-10" }] : null, error: null, count: 0 };
        }
        if (table === "fan_passes") return { data: PASS, error: null };
        if (table === "prizes") return { data: { id: "p1", rarity: "common" }, error: null };
        if (table === "profiles") return { data: { chat_intro: "hello", chat_outro: "bye" }, error: null };
        if (table === "wheels") return { data: single ? { id: "w1", archived_at: null, game_kind: "wheel", game_ready: true } : [], error: null };
        return { data: single ? null : [], error: null, count: 0 };
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
    rpc: async (name: string) => { rpcs.push(name); return { data: { status: "ok" }, error: null }; },
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function main() {
  // Every web push to the creator goes through notifyCreator: count the calls.
  const realPush = await import("@/lib/push/notify");
  const pushes: unknown[] = [];
  mock.module("@/lib/push/notify", {
    namedExports: { ...realPush, notifyCreator: async (...args: unknown[]) => { pushes.push(args); return { sent: 0 }; } },
  });

  const data = await import("./index");
  const m = await import("./mock");
  const { POST: fanMessage } = await import("@/app/api/messages/fan/route");
  const { POST: autoIntro } = await import("@/app/api/messages/auto-intro/route");
  const { POST: autoOutro } = await import("@/app/api/messages/auto-outro/route");
  const { POST: wishAdd, DELETE: wishRemove } = await import("@/app/api/wishlists/route");
  const { POST: optIn } = await import("@/app/api/leaderboard/opt-in/route");
  const { POST: checkin } = await import("@/app/api/fan/checkin/route");
  const { POST: ack } = await import("@/app/api/fans/ack/route");
  const { POST: takeBreak } = await import("@/app/api/fan/break/route");
  const { POST: selfExclude } = await import("@/app/api/self-exclude/route");
  const { POST: report } = await import("@/app/api/report/route");
  const { POST: exportData } = await import("@/app/api/fan-data/export/route");
  const { POST: deleteData } = await import("@/app/api/fan-data/delete/route");
  const { POST: reward } = await import("@/app/api/fan/reward/route");
  const { REPORT_REASONS } = await import("@/lib/reports/config");

  let caller = 0;
  const call = async (handler: (r: Request) => Promise<Response>, body: unknown, method = "POST") => {
    // Its own address per call: the refusals are 404s, which the per-address
    // miss budget counts.
    const res = await handler(new Request("http://localhost/api/x", {
      method,
      headers: { "Content-Type": "application/json", "x-real-ip": `192.0.2.${1 + (caller++ % 250)}` },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const gone = (r: { status: number; body: Record<string, unknown> | null }) => r.status === 404 && r.body?.error === "not_found";

  // --- demo path, through the routes ---------------------------------------------
  const fan = m.mockCreatePass("Suspended creator fan", 3);
  const fresh = m.mockCreatePass("Suspended creator fan, never confirmed", 1);
  const leaving = m.mockCreatePass("Suspended creator fan, pausing", 1);
  const erasing = m.mockCreatePass("Suspended creator fan, deleting", 1);
  m.mockAckFan(fan.token);
  const prize = m.mockGetWheel().prizes[0].label;
  const kept = m.mockGetWheel().prizes[1].label;
  const today = new Date().toISOString().slice(0, 10);
  check("demo: before the suspension, chat works", (await call(fanMessage, { token: fan.token, body: "hi" })).status === 200);
  await settle();
  check("demo: …and the creator is told", pushes.length === 1);
  check("demo: before the suspension, the wishlist works", (await call(wishAdd, { token: fan.token, prizeLabel: kept })).status === 200);
  const won = await m.mockSpin(fan.token, "seed");
  const shareId = "shareId" in won ? won.shareId : "";
  const rewardBefore = await call(reward, { token: fan.token, shareId });

  m.mockSetDemoCreatorActive(false);
  try {
    check("demo: a suspended creator's fan cannot send a message", gone(await call(fanMessage, { token: fan.token, body: "anyone there" })));
    check("demo: …the auto intro is refused", gone(await call(autoIntro, { token: fan.token })));
    check("demo: …the auto outro is refused", gone(await call(autoOutro, { token: fan.token })));
    check("demo: …a wishlist add is refused", gone(await call(wishAdd, { token: fan.token, prizeLabel: prize })));
    check("demo: …a wishlist remove is refused", gone(await call(wishRemove, { token: fan.token, prizeLabel: kept }, "DELETE")));
    check("demo: …the board opt-in is refused", gone(await call(optIn, { token: fan.token, optIn: true, handle: "suspended_fan" })));
    check("demo: …the visit check-in is refused", gone(await call(checkin, { token: fan.token, localDate: today })));
    check("demo: …the age gate cannot be confirmed", gone(await call(ack, { token: fresh.token })));
    await settle();
    check("demo: no push reached the suspended creator's devices", pushes.length === 1);

    // The fan's own actions stay open.
    check("demo: leaving the board still works", (await call(optIn, { token: fan.token, optIn: false })).status === 200);
    check("demo: a report is still taken", (await call(report, { token: fan.token, reason: REPORT_REASONS[0] })).status === 200);
    check("demo: the data download still works", (await call(exportData, { token: fan.token })).status === 200);
    const rewardNow = await call(reward, { token: fan.token, shareId });
    check("demo: reopening a reward answers as it did before", rewardNow.status === rewardBefore.status && rewardNow.body?.error === rewardBefore.body?.error);
    check("demo: a break can still be taken", (await call(takeBreak, { token: fan.token, duration: "24h" })).status === 200);
    check("demo: the link can still be paused by the fan", (await call(selfExclude, { token: leaving.token })).status === 200);
    check("demo: the data can still be deleted", (await call(deleteData, { token: erasing.token, confirm: "DELETE" })).status === 200);
  } finally {
    m.mockSetDemoCreatorActive(true);
  }
  const thread = await data.getThread(fan.fanId);
  check("demo: nothing was stored in the thread", Array.isArray(thread) && thread.length === 1 && thread[0].body === "hi");
  const stored = m.mockExportFanData(fan.token)!;
  check("demo: the fan is not on the board and has no board name", stored.consents.leaderboardOptIn === false && stored.profile.handle === null);
  check("demo: the wishlist is as it was", JSON.stringify(stored.wishlist.map((w) => w.prize)) === JSON.stringify([kept]));
  check("demo: no visit was recorded", stored.checkIns.length === 0);
  check("demo: the never-confirmed fan is still unconfirmed", (await call(fanMessage, { token: fresh.token, body: "hi" })).body?.error === "needs_ack");
  check("demo: a reactivated creator's fan confirms the gate again", (await call(ack, { token: fresh.token })).status === 200);

  // The demo gate answers like record_fan_ack (0073): only a live link is
  // acknowledged, and a link that is not live answers like a paused one.
  const offFan = m.mockCreatePass("Gate parity: link switched off", 1);
  m.mockUpdateFanLink(offFan.fanId, offFan.token, { active: false });
  check("demo: a switched-off link cannot confirm the gate", gone(await call(ack, { token: offFan.token })));
  const blockedFan = m.mockCreatePass("Gate parity: blocked", 1);
  m.mockSetFanBlocked(blockedFan.fanId, true);
  check("demo: a blocked fan cannot confirm the gate", gone(await call(ack, { token: blockedFan.token })));
  m.mockSetFanBlocked(blockedFan.fanId, false);
  check("demo: …and can once unblocked", (await call(ack, { token: blockedFan.token })).status === 200);
  const pausedFan = m.mockCreatePass("Gate parity: paused by the fan", 1);
  m.mockSelfExclude(pausedFan.token);
  check("demo: a link its fan paused cannot confirm the gate", gone(await call(ack, { token: pausedFan.token })));

  // --- Supabase path ----------------------------------------------------------------
  useSupabase = true;
  const live = {
    creator_id: "c1", campaign_id: null, wheel_id: "w1", fan_id: "f1", is_active: true, expires_at: null,
    creator: { is_active: true, approval_status: "approved", role: "creator" } as Record<string, unknown> | null,
    fan: { id: "f1", spins_remaining: 2, spins_granted_total: 3, blocked_at: null, break_until: null,
      acked_at: "2026-10-29T00:00:00Z", acked_terms_version: LEGAL.version },
  };
  const refusedAll = async (label: string) => {
    writes.length = 0;
    rpcs.length = 0;
    const before = pushes.length;
    const answers = [
      await data.sendFanMessage("tok", "hi"),
      await data.ensureChatIntro("tok"),
      await data.sendChatOutro("tok"),
      await data.addWishlist("tok", "Prize"),
      await data.removeWishlist("tok", "Prize"),
      await data.setFanLeaderboardOptIn("tok", true, "name"),
      await data.recordCheckin("tok", today),
      await data.ackFan("tok"),
    ];
    await settle();
    check(`supabase (${label}): chat, intro, outro, wishlist, opt-in, check-in and the gate answer not_found`, answers.every((a) => JSON.stringify(a) === '{"error":"not_found"}'));
    check(`supabase (${label}): nothing is written, no function is called, no push is sent`, writes.length === 0 && rpcs.length === 0 && pushes.length === before);
  };
  PASS = { ...live, creator: { ...live.creator, is_active: false } };
  await refusedAll("suspended");
  PASS = { ...live, creator: { is_active: true, approval_status: "pending", role: "creator" } };
  await refusedAll("not approved");
  PASS = { ...live, creator: null };
  await refusedAll("no profile");

  PASS = live;
  writes.length = 0;
  const before = pushes.length;
  check("supabase: a creator in good standing gets the message", "ok" in (await data.sendFanMessage("tok", "hi")));
  check("supabase: …the wishlist add", "ok" in (await data.addWishlist("tok", "Prize")));
  check("supabase: …the visit", "ok" in (await data.recordCheckin("tok", today)));
  check("supabase: …and the acknowledgement, through record_fan_ack", "ok" in (await data.ackFan("tok")) && rpcs.includes("record_fan_ack"));
  await settle();
  check("supabase: the writes happened and the creator is told", writes.some((w) => w.table === "messages") && writes.some((w) => w.table === "wishlists")
    && writes.some((w) => w.table === "fan_checkins") && pushes.length === before + 1);
  PASS = { ...live, creator: { is_active: true, approval_status: "pending", role: "admin" } };
  check("supabase: an admin's own links count as in good standing, as on the fan page", "ok" in (await data.sendFanMessage("tok", "hi")));

  console.log(`suspendedCreatorFans.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
