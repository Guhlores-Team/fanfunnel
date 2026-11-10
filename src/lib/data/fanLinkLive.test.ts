import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "@/lib/legal";

// PR-13 (0073): fan_passes.expires_at. An expired link answers exactly like a
// switched-off one on every token-keyed fan route, through one test
// (fanLinkLive / LINK_LIVE; mockLinkLive in the demo):
//   chat send and thread read, the auto intro and outro, wishlist add and
//   remove, the board opt-in, the visit check-in, the age gate, the focus
//   state, a reward and the reward history, a break and the play reminder.
// The spin RPCs apply the same test in SQL and the fan page reads it with
// the pass (spins.ts readFanPassRow, privacy.ts getFanLinkStatus).

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

// --- a scripted service client -------------------------------------------------
type Write = { table: string; op: string };
const writes: Write[] = [];
const rpcs: string[] = [];
const selects: string[] = [];
let PASS: Record<string, unknown> | null = null;
function fakeService() {
  return {
    from(table: string) {
      let op = "select";
      const result = (single = false) => {
        if (op !== "select") {
          writes.push({ table, op });
          return { data: op === "upsert" ? [{ day: "2026-11-10" }] : null, error: null, count: 0 };
        }
        if (table === "fan_passes") return { data: PASS, error: null };
        if (table === "prizes") return { data: { id: "p1", rarity: "common" }, error: null };
        if (table === "profiles") return { data: { chat_intro: "hello", chat_outro: "bye" }, error: null };
        if (table === "wheels") return { data: single ? { id: "w1", archived_at: null, game_kind: "wheel", game_ready: true } : [], error: null };
        return { data: single ? null : [], error: null, count: 0 };
      };
      const proxy: unknown = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
          if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result(true));
          if (prop === "select") return (cols?: string) => { if (op === "select" && table === "fan_passes") selects.push(String(cols)); return proxy; };
          if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") return () => { op = prop; return proxy; };
          return () => proxy;
        },
      });
      return proxy;
    },
    rpc: async (name: string) => { rpcs.push(name); return { data: { status: "ok" }, error: null }; },
  };
}

let useSupabase = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => fakeService(),
    createServiceClient: () => fakeService(),
  },
});

async function main() {
  const { fanLinkLive, LINK_LIVE } = await import("./fanLinkLive");
  const now = Date.parse("2026-11-10T12:00:00Z");
  check("a switched-on link with no expiry is live", fanLinkLive({ is_active: true, expires_at: null }, now) && fanLinkLive({ is_active: true }, now));
  check("a future expiry is live", fanLinkLive({ is_active: true, expires_at: "2026-11-10T12:00:01Z" }, now));
  check("the expiry instant itself has ended (SQL: expires_at > now())", !fanLinkLive({ is_active: true, expires_at: "2026-11-10T12:00:00Z" }, now));
  check("a past expiry has ended", !fanLinkLive({ is_active: true, expires_at: "2026-11-09T00:00:00Z" }, now));
  check("a switched-off link is not live, expiry or not", !fanLinkLive({ is_active: false, expires_at: null }, now) && !fanLinkLive({ is_active: false, expires_at: "2099-01-01T00:00:00Z" }, now));
  check("a row read without is_active, no row and an unreadable date all fail closed", !fanLinkLive({ expires_at: null }, now) && !fanLinkLive(null, now) && !fanLinkLive(undefined, now) && !fanLinkLive({ is_active: true, expires_at: "soon" }, now));
  check("LINK_LIVE names both columns", LINK_LIVE === "is_active, expires_at");

  // --- Supabase path: an expired link answers what a switched-off one answers -----
  const data = await import("./index");
  const live = {
    creator_id: "c1", campaign_id: null, wheel_id: "w1", fan_id: "f1", is_active: true, expires_at: null as string | null, self_excluded_at: null,
    creator: { is_active: true, approval_status: "approved", role: "creator" },
    fan: { id: "f1", spins_remaining: 2, spins_granted_total: 3, blocked_at: null, break_until: null,
      acked_at: "2026-10-29T00:00:00Z", acked_terms_version: LEGAL.version },
  };
  const today = new Date().toISOString().slice(0, 10);
  const answers = async () => {
    writes.length = 0;
    rpcs.length = 0;
    const out = {
      chat: await data.sendFanMessage("tok", "hi"),
      thread: await data.getFanMessages("tok"),
      intro: await data.ensureChatIntro("tok"),
      outro: await data.sendChatOutro("tok"),
      wishAdd: await data.addWishlist("tok", "Prize"),
      wishRemove: await data.removeWishlist("tok", "Prize"),
      board: await data.setFanLeaderboardOptIn("tok", true, "name"),
      checkin: await data.recordCheckin("tok", today),
      gate: await data.ackFan("tok"),
      focus: await data.getFanFocusState("tok"),
      reward: await data.getFanReward("tok", "share1"),
      history: await data.getFanRewardHistory("tok"),
      rest: await data.takeBreak("tok", 86_400_000),
      reminder: await data.setPlayReminder("tok", 5),
    };
    return { json: JSON.stringify(out), wrote: writes.length + rpcs.length };
  };
  selects.length = 0;
  PASS = { ...live, is_active: false };
  const off = await answers();
  PASS = { ...live, expires_at: "2000-01-01T00:00:00Z" };
  const expired = await answers();
  const notFound = '{"error":"not_found"}';
  check("an expired link answers exactly what a switched-off link answers, on every route", expired.json === off.json);
  const parsed = JSON.parse(expired.json) as Record<string, unknown>;
  for (const route of ["chat", "intro", "outro", "wishAdd", "wishRemove", "board", "checkin", "gate", "reward", "history", "rest", "reminder"]) {
    check(`expired: ${route} → not_found`, JSON.stringify(parsed[route]) === notFound);
  }
  check("expired: the thread reads empty", JSON.stringify(parsed.thread) === "[]");
  check("expired: the focus state is refused", JSON.stringify(parsed.focus) === '{"error":"blocked"}');
  check("expired: nothing is written and no function is called", expired.wrote === 0 && off.wrote === 0);
  check("every one of those reads asks for the liveness columns", selects.length >= 14 && selects.every((cols) => cols.includes(LINK_LIVE)));
  PASS = { ...live, expires_at: "not a date" };
  check("an unreadable expiry fails closed (chat, check-in)", JSON.stringify(await data.sendFanMessage("tok", "hi")) === notFound && JSON.stringify(await data.recordCheckin("tok", today)) === notFound);

  PASS = { ...live, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
  writes.length = 0;
  check("a link that expires tomorrow still sends a message", "ok" in (await data.sendFanMessage("tok", "hi")));
  check("…adds to the wishlist", "ok" in (await data.addWishlist("tok", "Prize")));
  check("…records the visit", "ok" in (await data.recordCheckin("tok", today)));
  check("…confirms the gate", "ok" in (await data.ackFan("tok")));
  check("the writes happened", writes.some((w) => w.table === "messages") && writes.some((w) => w.table === "wishlists") && writes.some((w) => w.table === "fan_checkins"));

  // --- demo path: the same routes, the same answers --------------------------------
  useSupabase = false;
  const m = await import("./mock");
  const prize = m.mockGetWheel().prizes[0].label;
  const demoAnswers = async (token: string) => JSON.stringify({
    chat: await data.sendFanMessage(token, "hi"),
    thread: await data.getFanMessages(token),
    intro: await data.ensureChatIntro(token),
    outro: await data.sendChatOutro(token),
    wishAdd: await data.addWishlist(token, prize),
    wishRemove: await data.removeWishlist(token, prize),
    board: await data.setFanLeaderboardOptIn(token, true, "demo_name"),
    checkin: await data.recordCheckin(token, today),
    gate: await data.ackFan(token),
    focus: await data.getFanFocusState(token),
    history: await data.getFanRewardHistory(token),
    rest: await data.takeBreak(token, 86_400_000),
    reminder: await data.setPlayReminder(token, 5),
  });
  const offFan = m.mockCreatePass("Liveness: switched off", 2);
  m.mockAckFan(offFan.token);
  m.mockUpdateFanLink(offFan.fanId, offFan.token, { active: false });
  const expiredFan = m.mockCreatePass("Liveness: expired", 2);
  m.mockAckFan(expiredFan.token);
  m.mockUpdateFanLink(expiredFan.fanId, expiredFan.token, { expiresAt: "2000-01-01T00:00:00Z" });
  const demoOff = await demoAnswers(offFan.token);
  const demoExpired = await demoAnswers(expiredFan.token);
  check("demo: an expired link answers exactly what a switched-off link answers", demoExpired === demoOff);
  const demo = JSON.parse(demoExpired) as Record<string, unknown>;
  for (const route of ["chat", "intro", "outro", "wishAdd", "wishRemove", "board", "checkin", "gate", "focus", "history", "rest", "reminder"]) {
    check(`demo expired: ${route} → not_found`, JSON.stringify(demo[route]) === notFound);
  }
  check("demo expired: the thread reads empty", JSON.stringify(demo.thread) === "[]");
  const kept = m.mockExportFanData(expiredFan.token)!;
  check("demo expired: nothing was stored", kept.messagesYouSent.length === 0 && kept.wishlist.length === 0 && kept.checkIns.length === 0 && kept.consents.leaderboardOptIn === false && kept.play.breakUntil === null);
  check("demo expired: the fan page has no pass", (await m.mockGetFanPass(expiredFan.token)) === null);
  m.mockUpdateFanLink(expiredFan.fanId, expiredFan.token, { expiresAt: null });
  check("demo: made permanent again, the link sends a message", "ok" in (await data.sendFanMessage(expiredFan.token, "back")));

  // --- static: no token-keyed fan read is left without the test ------------------
  const root = join(__dirname, "..", "..", "..");
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  // Reads that are deliberately open to a link in any state, with the reason.
  const OPEN: Record<string, string> = {
    "src/lib/data/fans.ts:reportCreator": "a report is taken from any link the fan still holds",
    "src/lib/data/privacy.ts:resolveAnyToken": "the data download, deletion and consent withdrawal are the fan's rights in every state",
    "src/lib/data/privacy.ts:getFanLinkStatus": "reads expires_at itself (fanLinkExpired) to tell a closed link from an ended one",
    "src/lib/data/pausedLink.ts:getPausedFanWins": "a link its fan paused keeps its read-only list of wins, expiry or not",
  };
  const modules = ["fans.ts", "inbox.ts", "boosts.ts", "checkins.ts", "focus.ts", "rewards.ts", "playGuard.ts", "pausedLink.ts", "privacy.ts"];
  let reads = 0;
  for (const name of modules) {
    const file = `src/lib/data/${name}`;
    const src = read(file);
    for (const m2 of src.matchAll(/\.from\("fan_passes"\)\s*\.select\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\.eq\("token", token\)/g)) {
      const before = src.slice(0, m2.index);
      const fn = [...before.matchAll(/(?:export )?async function (\w+)\(/g)].at(-1)?.[1] ?? "?";
      reads++;
      const open = OPEN[`${file}:${fn}`];
      check(`${file} ${fn}: the token read asks for the liveness columns${open ? " or is open by design" : ""}`, m2[1].includes("${LINK_LIVE}") || (!!open && open.length > 30));
    }
  }
  check("the scan found the token reads", reads >= 9);
  const spins = read("src/lib/data/spins.ts");
  check("the fan page's own read refuses an expired link", /pass && !fanLinkExpired\(pass\.expires_at\) \? pass : null/.test(spins));
  const page = read("src/app/spin/[token]/page.tsx");
  check("the fan page reads the link once, through getFanPass", page.includes("const pass = await getFanPass(token);") && !/linkExpiryRead/.test(page));
  console.log(`fanLinkLive.test: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
