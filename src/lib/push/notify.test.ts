import assert from "node:assert";
import { mock } from "node:test";
import type { NotificationSources } from "@/lib/data/notificationFeed";

// notifyCreator (web push sender), both paths.
//
// Supabase path: the service client is an in-memory fake of the three tables
// it touches (push_subscriptions, push_log, redemptions), the feed sources come
// from a stubbed loadNotificationSources, and `web-push` is replaced by a
// recorder. Checks: one send per ACTIVE device; paused devices skipped; generic
// vs detailed per device; prefs off → nothing; the same event → sent once; a
// thread is throttled; 410 → device deleted; failures counted; success clears
// them; every write is scoped to the creator; keys unset → nothing, no throw;
// the engagement gate: no push about a blocked fan or one who paused a link
// (the low-stock item still goes), and an unknown fan fails closed.
//
// Demo path: the real mock store + the simulated push service (outbox).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEYS = { VAPID_PUBLIC_KEY: "B" + "a".repeat(86), VAPID_PRIVATE_KEY: "c".repeat(43), VAPID_SUBJECT: "mailto:ops@example.test" };
const setKeys = (on: boolean) => {
  for (const [k, v] of Object.entries(KEYS)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
};

// ---- fake service client ---------------------------------------------------------
type Row = Record<string, unknown>;
const fanRow = (id: string, user: string, blocked = false, breakUntil: string | null = null) => ({
  id, creator_id: user, blocked_at: blocked ? new Date().toISOString() : null, break_until: breakUntil,
});
const tables: Record<string, Row[]> = {
  push_subscriptions: [],
  push_log: [],
  redemptions: [],
  fans: ["f1", "f2", "f3", "f4"].map((f) => fanRow(f, CREATOR)),
  fan_passes: ["f1", "f2", "f3", "f4"].map((f) => ({ fan_id: f, creator_id: CREATOR, self_excluded_at: null })),
};
const writes: { table: string; op: string; filters: [string, string, unknown][] }[] = [];

function query(table: string) {
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | null = null;
  const filters: [string, string, unknown][] = [];
  let limit = Infinity;
  let columns: string[] | null = null;
  const project = (r: Row) => columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r;
  const match = (r: Row) =>
    filters.every(([c, o, v]) =>
      o === "eq" ? r[c] === v : o === "lt" ? (r[c] as number) < (v as number) : o === "gte" ? String(r[c]) >= String(v) : true
    );
  const run = () => {
    const rows = tables[table];
    if (op !== "select") writes.push({ table, op, filters: [...filters] });
    if (op === "insert") {
      const row = { sent_at: new Date().toISOString(), ...payload } as Row;
      if (table === "push_log" && rows.some((r) => r.user_id === row.user_id && r.item_id === row.item_id)) {
        return { data: null, error: { message: "duplicate key", code: "23505" } };
      }
      rows.push(row);
      return { data: [row], error: null };
    }
    const hit = rows.filter(match);
    if (op === "update") hit.forEach((r) => Object.assign(r, payload));
    if (op === "delete") tables[table] = rows.filter((r) => !hit.includes(r));
    return { data: hit.slice(0, limit).map(project), error: null };
  };
  const b: Record<string, unknown> = {
    select: (cols = "*") => ((columns = cols === "*" ? null : cols.split(",").map((c) => c.trim())), b),
    insert: (p: Row) => ((op = "insert"), (payload = p), b),
    update: (p: Row) => ((op = "update"), (payload = p), b),
    delete: () => ((op = "delete"), b),
    eq: (c: string, v: unknown) => (filters.push([c, "eq", v]), b),
    lt: (c: string, v: unknown) => (filters.push([c, "lt", v]), b),
    gte: (c: string, v: unknown) => (filters.push([c, "gte", v]), b),
    limit: (n: number) => ((limit = n), b),
    maybeSingle: async () => {
      const r = run();
      return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
    },
    then: (resolve: (v: unknown) => void) => resolve(run()),
  };
  return b;
}

let configured = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => {
      throw new Error("notify must not use a session client");
    },
    createServiceClient: () => ({ from: (t: string) => query(t) }),
  },
});

let sources: NotificationSources = { pendingWins: [], unreadMessages: [], lowStock: [], outOfSpins: [] };
let prefs = { newSpin: true, lowBalance: true, messages: true };
const loadedFor: string[] = [];
mock.module("@/lib/data/notifications", {
  namedExports: {
    loadNotificationSources: async (_sb: unknown, uid: string) => {
      loadedFor.push(uid);
      return { sources: structuredClone(sources), seenAt: null, prefs };
    },
  },
});

const sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string }; topic?: string; timeout?: number }[] = [];
const gone = new Set<string>();
const broken = new Set<string>();
mock.module("web-push", {
  defaultExport: {
    sendNotification: async (sub: { endpoint: string }, body: string, opts: { topic?: string; timeout?: number }) => {
      if (gone.has(sub.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (broken.has(sub.endpoint)) throw Object.assign(new Error("boom"), { statusCode: 500 });
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body), topic: opts.topic, timeout: opts.timeout });
      return { statusCode: 201, body: "", headers: {} };
    },
  },
});

const ep = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;
const device = (id: string, user: string, showDetails: boolean, failures = 0) => ({
  id,
  user_id: user,
  endpoint: ep(id),
  p256dh: "BKey",
  auth: "auth",
  show_details: showDetails,
  failures,
  last_success_at: null,
});
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

async function main() {
  const { notifyCreator } = await import("./notify");
  const reset = () => {
    sent.length = 0;
    writes.length = 0;
    loadedFor.length = 0;
  };

  // --- keys unset: push is OFF, nothing read or sent, no throw ------------------
  setKeys(false);
  tables.push_subscriptions = [device("d1", CREATOR, false)];
  const off = await notifyCreator(CREATOR, { type: "message", fanId: "f1" });
  check("keys unset → nothing sent", off.sent === 0 && sent.length === 0 && loadedFor.length === 0);
  setKeys(true);

  // --- no devices → stop before loading the feed --------------------------------
  tables.push_subscriptions = [device("x1", OTHER, true)];
  reset();
  const none = await notifyCreator(CREATOR, { type: "message", fanId: "f1" });
  check("no devices for this creator → nothing sent, feed not even loaded", none.sent === 0 && loadedFor.length === 0);

  // --- a win: one send per ACTIVE device, generic unless the device opted in -------
  tables.push_subscriptions = [
    device("d1", CREATOR, false),
    device("d2", CREATOR, true),
    device("d3", CREATOR, true, 5), // paused after 5 failures
    device("x1", OTHER, true), // another creator's device
  ];
  tables.redemptions = [{ id: "r1", spin_id: "s1", creator_id: CREATOR }];
  sources = {
    pendingWins: [{ id: "r1", fanName: "Nova", prizeLabel: "VIP Month", emoji: "👑", at: iso(0) }],
    unreadMessages: [],
    lowStock: [{ prizeId: "p1", label: "VIP Month", emoji: "👑", stock: 3, wheelId: "w1", wheelTitle: "Main", at: iso(0) }],
    outOfSpins: [],
  };
  reset();
  const win = await notifyCreator(CREATOR, { type: "spin", spinId: "s1", fanId: "f1", prizeId: "p1", stockAfter: 4 });
  check("feed loaded for the creator only", loadedFor.join() === CREATOR);
  check("one send per active device (2), paused and other creator's skipped", sent.length === 2 && win.sent === 2);
  check("never sent to another creator's device", !sent.some((s) => s.endpoint === ep("x1")));
  const generic = sent.find((s) => s.endpoint === ep("d1"))!;
  const detailed = sent.find((s) => s.endpoint === ep("d2"))!;
  check("generic device: no fan or prize name", generic.payload.title === "New activity on FanFunnel" && !/Nova|VIP/.test(JSON.stringify(generic.payload)));
  check("detailed device: the bell's text", detailed.payload.title === "Nova won 👑 VIP Month" && detailed.payload.body === "Waiting for you to fulfil it.");
  check("opens Fulfilment", detailed.payload.url === "/dashboard?section=prizes");
  check("stock 4 did not cross the line → no low-stock push", !sent.some((s) => s.payload.tag.startsWith("stock:")));
  check("Topic header set and URL-safe", !!detailed.topic && /^[A-Za-z0-9_-]{1,32}$/.test(detailed.topic));
  check("5s timeout per delivery", detailed.timeout === 5000);
  check("push_log claimed once for this win", tables.push_log.filter((r) => String(r.item_id).startsWith("win:r1@")).length === 1);
  check("success bookkeeping cleared failures on d1/d2", tables.push_subscriptions.filter((d) => ["d1", "d2"].includes(d.id as string)).every((d) => d.failures === 0 && d.last_success_at));
  for (const w of writes.filter((x) => x.table === "push_subscriptions")) {
    check(`device write ${w.op} is scoped to the creator`, w.filters.some(([c, o, v]) => c === "user_id" && o === "eq" && v === CREATOR));
  }

  // --- the same event again → sent once (push_log) ---------------------------------
  reset();
  const again = await notifyCreator(CREATOR, { type: "spin", spinId: "s1", fanId: "f1", prizeId: "p1", stockAfter: 4 });
  check("same win again → nothing sent", again.sent === 0 && sent.length === 0);

  // --- crossing the low-stock line pushes the stock item ------------------------------
  tables.push_log = [];
  reset();
  sources.pendingWins = [];
  const cross = await notifyCreator(CREATOR, { type: "spin", spinId: "s9", fanId: "f1", prizeId: "p1", stockAfter: 3 });
  check("stock decremented to the threshold → stock push to each device", cross.sent === 2 && sent.every((s) => s.payload.tag === "stock:p1"));

  // --- prefs off → no send (the item isn't in the feed) ----------------------------
  tables.push_log = [];
  sources = { pendingWins: [{ id: "r2", fanName: "Bo", prizeLabel: "Call", at: iso(0) }], unreadMessages: [], lowStock: [], outOfSpins: [] };
  tables.redemptions.push({ id: "r2", spin_id: "s2", creator_id: CREATOR });
  prefs = { newSpin: false, lowBalance: true, messages: true };
  reset();
  const prefsOff = await notifyCreator(CREATOR, { type: "spin", spinId: "s2", fanId: "f2", prizeId: "p9", stockAfter: null });
  check("'New spins & wins' off → no push", prefsOff.sent === 0 && sent.length === 0);
  prefs = { newSpin: true, lowBalance: true, messages: true };

  // --- messages: a new message pushes; another within 2 minutes is throttled ---------
  tables.push_log = [];
  sources = { pendingWins: [], unreadMessages: [{ fanId: "f3", fanName: "Cy", body: "hi", at: iso(0) }], lowStock: [], outOfSpins: [] };
  reset();
  const m1 = await notifyCreator(CREATOR, { type: "message", fanId: "f3" });
  check("a fan message pushes to each device", m1.sent === 2 && sent.every((s) => s.payload.tag === "msg:f3"));
  sources.unreadMessages.push({ fanId: "f3", fanName: "Cy", body: "hello??", at: new Date(Date.now() + 1000).toISOString() });
  reset();
  const m2 = await notifyCreator(CREATOR, { type: "message", fanId: "f3" });
  check("a second message in the same thread within 2 min → throttled", m2.sent === 0 && m2.skipped.some((s) => s.reason === "throttled"));

  // --- 410 deletes the device; other failures are counted ----------------------------
  tables.push_log = [];
  gone.add(ep("d1"));
  broken.add(ep("d2"));
  sources = { pendingWins: [], unreadMessages: [], lowStock: [], outOfSpins: [{ fanId: "f4", fanName: "Dee", at: iso(0) }] };
  reset();
  const fail = await notifyCreator(CREATOR, { type: "spin", spinId: "s4", fanId: "f4", prizeId: "p9", stockAfter: null });
  check("410 → reported removed", fail.removed === 1 && fail.sent === 0);
  check("410 → that device row is deleted", !tables.push_subscriptions.some((d) => d.id === "d1"));
  check("500 → failure counted, device kept", tables.push_subscriptions.find((d) => d.id === "d2")?.failures === 1);
  check("the other creator's device is untouched", tables.push_subscriptions.some((d) => d.id === "x1"));
  gone.clear();
  broken.clear();

  // --- engagement gate (F6): no push ABOUT a blocked / paused fan -------------------
  tables.push_log = [];
  tables.fans.push(fanRow("f5", CREATOR, true)); // blocked
  tables.fan_passes.push({ fan_id: "f5", creator_id: CREATOR, self_excluded_at: null });
  tables.fans.push(fanRow("f6", CREATOR)); // paused one of two links
  tables.fan_passes.push({ fan_id: "f6", creator_id: CREATOR, self_excluded_at: null });
  tables.fan_passes.push({ fan_id: "f6", creator_id: CREATOR, self_excluded_at: iso(1) });
  tables.fans.push(fanRow("f7", OTHER)); // another creator's fan id
  tables.redemptions.push({ id: "r5", spin_id: "s5", creator_id: CREATOR });
  sources = {
    pendingWins: [{ id: "r5", fanName: "Eve", prizeLabel: "Call", at: iso(0) }],
    unreadMessages: [
      { fanId: "f5", fanName: "Eve", body: "hey", at: iso(0) },
      { fanId: "f6", fanName: "Fay", body: "hey", at: iso(0) },
      { fanId: "f7", fanName: "Gus", body: "hey", at: iso(0) },
    ],
    lowStock: [{ prizeId: "p5", label: "Call", emoji: "📞", stock: 0, wheelId: "w1", wheelTitle: "Main", at: iso(0) }],
    outOfSpins: [{ fanId: "f5", fanName: "Eve", at: iso(0) }],
  };
  reset();
  const blocked = await notifyCreator(CREATOR, { type: "spin", spinId: "s5", fanId: "f5", prizeId: "p5", stockAfter: 0 });
  check("blocked fan: no win or out-of-spins push", !sent.some((s) => /^(win|spins):/.test(s.payload.tag)));
  check("blocked fan: skipped as not engageable", blocked.skipped.filter((s) => s.reason === "fan_not_engageable").length === 2);
  check("blocked fan: the low-stock item (about a prize) still pushes", sent.length > 0 && sent.every((s) => s.payload.tag === "stock:p5"));
  check("blocked fan: nothing claimed in push_log for fan items", !tables.push_log.some((r) => /^(win|spins):/.test(String(r.item_id))));
  reset();
  const blockedMsg = await notifyCreator(CREATOR, { type: "message", fanId: "f5" });
  check("blocked fan: a message does not push", blockedMsg.sent === 0 && sent.length === 0);
  reset();
  const pausedMsg = await notifyCreator(CREATOR, { type: "message", fanId: "f6" });
  check("fan who paused a link: a message does not push", pausedMsg.sent === 0 && sent.length === 0);
  reset();
  const otherFan = await notifyCreator(CREATOR, { type: "message", fanId: "f7" });
  check("a fan not of this creator (unknown) fails closed", otherFan.sent === 0 && sent.length === 0);

  // RM-6: read the actual break column before pushing any fan item. The fake
  // projects selected columns, so forgetting break_until cannot pass this test.
  tables.push_log = [];
  tables.fans.push(fanRow("f8", CREATOR, false, new Date(Date.now() + 86_400_000).toISOString()));
  tables.fan_passes.push({ fan_id: "f8", creator_id: CREATOR, self_excluded_at: null });
  tables.redemptions.push({ id: "r8", spin_id: "s8", creator_id: CREATOR });
  sources = {
    pendingWins: [{ id: "r8", fanName: "Hal", prizeLabel: "Call", at: iso(0) }],
    unreadMessages: [{ fanId: "f8", fanName: "Hal", body: "hello", at: iso(0) }],
    lowStock: [{ prizeId: "p8", label: "Call", stock: 0, wheelId: "w1", wheelTitle: "Main", at: iso(0) }],
    outOfSpins: [{ fanId: "f8", fanName: "Hal", at: iso(0) }],
  };
  reset();
  const onBreak = await notifyCreator(CREATOR, { type: "spin", spinId: "s8", fanId: "f8", prizeId: "p8", stockAfter: 0 });
  check("on-break fan: no win or out-of-spins push", !sent.some((s) => /^(win|spins):/.test(s.payload.tag)));
  check("on-break fan: both fan items refused by the engagement gate", onBreak.skipped.filter((s) => s.reason === "fan_not_engageable").length === 2);
  check("on-break fan: prize-stock alert still delivered", sent.length > 0 && sent.every((s) => s.payload.tag === "stock:p8"));
  check("on-break fan: no fan item claimed", !tables.push_log.some((r) => /^(win|spins|msg):/.test(String(r.item_id))));
  reset();
  const breakMsg = await notifyCreator(CREATOR, { type: "message", fanId: "f8" });
  check("on-break fan: message refused without delivery or claim", breakMsg.sent === 0 && sent.length === 0 && breakMsg.skipped.some((s) => s.reason === "fan_not_engageable") && !tables.push_log.some((r) => String(r.item_id).startsWith("msg:f8")));

  for (const [id, until, allowed] of [["invalid-break", "unreadable", false], ["expired-break", iso(1), true]] as const) {
    tables.fans.push(fanRow(id, CREATOR, false, until));
    tables.fan_passes.push({ fan_id: id, creator_id: CREATOR, self_excluded_at: null });
    sources.unreadMessages = [{ fanId: id, fanName: "Fan", body: "hello", at: iso(0) }];
    reset();
    const report = await notifyCreator(CREATOR, { type: "message", fanId: id });
    check(`${id}: ${allowed ? "expired break permits delivery" : "unreadable date fails closed"}`, allowed ? report.sent > 0 && sent.length > 0 : report.sent === 0 && sent.length === 0 && report.skipped.some((s) => s.reason === "fan_not_engageable"));
  }

  // --- a failing backend never throws -----------------------------------------------
  const prev = tables.push_subscriptions;
  (tables as Record<string, unknown>).push_subscriptions = undefined;
  const broke = await notifyCreator(CREATOR, { type: "message", fanId: "f3" }).catch(() => null);
  check("notify never throws (returns an empty report)", !!broke && broke.sent === 0);
  tables.push_subscriptions = prev;

  // --- Demo path: real mock store + simulated push service --------------------------
  configured = false;
  const demo = await import("@/lib/data/mock");
  const store = await import("@/lib/data/mockPush");
  sent.length = 0;
  const a = store.mockAddPushDevice({ endpoint: ep("demo-a"), p256dh: "BKey", auth: "auth" }, "Mac · Chrome");
  const b = store.mockAddPushDevice({ endpoint: ep("demo-b"), p256dh: "BKey", auth: "auth" }, "iPhone · Safari");
  check("demo devices registered", "ok" in a && "ok" in b);
  if ("ok" in b) store.mockSetPushDeviceDetails(b.device.id, true);
  const link = demo.mockCreatePass("Push Fan", 2);
  demo.mockAckFan(link.token);
  const spun = await demo.mockSpin(link.token);
  check("demo spin ok", !("error" in spun));
  const ev = demo.mockSpinPushEvent(link.token);
  check("demo spin event has the redemption", !!ev?.redemptionId);
  const r = await notifyCreator("demo", { type: "spin", ...ev! });
  const out = store.mockPushOutbox();
  const winOut = out.filter((o) => o.payload.tag === `win:${ev!.redemptionId}`);
  check("demo: one simulated delivery per device", r.sent >= 2 && winOut.length === 2);
  check("demo: web-push itself never called", sent.length === 0);
  const bellWin = (await import("@/lib/data/notificationFeed"))
    .buildNotificationItems(demo.mockGetNotificationSources(), demo.mockGetMyAccount().notifications)
    .find((i) => i.id === `win:${ev!.redemptionId}`)!;
  check("demo: the detailed device got the bell's title", winOut.some((o) => o.payload.title === bellWin.title));
  check("demo: the generic device got no fan name", winOut.some((o) => o.payload.title === "New activity on FanFunnel" && !o.payload.body.includes("Push Fan")));
  const goneDev = store.mockAddPushDevice({ endpoint: ep("e2e-gone-1"), p256dh: "BKey", auth: "auth" }, "Linux · Chrome");
  demo.mockSendFanMessage(link.token, "hello from the demo");
  const rm = await notifyCreator("demo", { type: "message", fanId: ev!.fanId });
  check("demo: a 410 from the simulated service removes the device", rm.removed === 1 && !store.mockListPushDevices().some((d) => "ok" in goneDev && d.id === goneDev.device.id));

  // Demo engagement gate: once the creator blocks the fan, their messages no longer push.
  const before = store.mockPushOutbox().length;
  demo.mockSetFanBlocked(ev!.fanId, true);
  demo.mockSendFanMessage(link.token, "still there?");
  const blockedDemo = await notifyCreator("demo", { type: "message", fanId: ev!.fanId });
  check("demo: no push about a blocked fan", blockedDemo.sent === 0 && store.mockPushOutbox().length === before && blockedDemo.skipped.some((s) => s.reason === "fan_not_engageable"));
  demo.mockSetFanBlocked(ev!.fanId, false);

  // Demo parity: a newly recorded win/message must stay quiet once the fan
  // chooses a break, even if the creator has notifications enabled.
  const breakLink = demo.mockCreatePass("Break push fan", 2);
  demo.mockAckFan(breakLink.token);
  const breakSpin = await demo.mockSpin(breakLink.token);
  check("demo break fixture has a real win", !("error" in breakSpin));
  const breakEvent = demo.mockSpinPushEvent(breakLink.token);
  check("demo break fixture has a push event", !!breakEvent?.redemptionId);
  demo.mockSendFanMessage(breakLink.token, "before my break");
  const tookBreak = demo.mockTakeBreak(breakLink.token, 86_400_000);
  check("demo fan takes a break", "ok" in tookBreak);
  const beforeBreak = store.mockPushOutbox().length;
  const breakWin = await notifyCreator("demo", { type: "spin", ...breakEvent! });
  check("demo: on-break win refused without a delivery", breakWin.sent === 0 && store.mockPushOutbox().length === beforeBreak && breakWin.skipped.some((s) => s.reason === "fan_not_engageable"));
  const breakMessage = await notifyCreator("demo", { type: "message", fanId: breakEvent!.fanId });
  check("demo: on-break message refused without a delivery", breakMessage.sent === 0 && store.mockPushOutbox().length === beforeBreak && breakMessage.skipped.some((s) => s.reason === "fan_not_engageable"));

  console.log(`push notify: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
