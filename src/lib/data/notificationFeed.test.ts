import assert from "node:assert";
import {
  buildNotificationFeed,
  isUnread,
  FEED_LIMIT,
  LOW_STOCK_THRESHOLD,
  type NotificationSources,
} from "./notificationFeed";

// RD-7 / spec #1: the bell's feed is derived from existing tables (pending
// redemptions, unread fan messages, low prize stock, fans who just ran out of
// spins). These checks pin the derivation, the unread rule and the Settings
// toggles, which the Supabase and demo paths both feed through.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ALL_ON = { newSpin: true, lowBalance: true, messages: true };
const t = (min: number) => new Date(Date.UTC(2026, 9, 26, 12, min)).toISOString();

const empty: NotificationSources = {
  pendingWins: [],
  unreadMessages: [],
  lowStock: [],
  outOfSpins: [],
};

function sources(): NotificationSources {
  return {
    pendingWins: [
      { id: "r1", fanName: "Ava", prizeLabel: "Shoutout", emoji: "📣", at: t(1) },
      { id: "r2", fanName: "Bo", prizeLabel: "Selfie", at: t(5) },
    ],
    unreadMessages: [
      { fanId: "f-ava", fanName: "Ava", body: "first", at: t(2) },
      { fanId: "f-ava", fanName: "Ava", body: "second, and the newest from Ava", at: t(6) },
      { fanId: "f-cy", fanName: "Cy", body: "hi", at: t(3) },
    ],
    lowStock: [
      { prizeId: "p1", label: "Signed photo", emoji: "📸", stock: 0, wheelId: "w1", wheelTitle: "Main", at: t(4) },
      { prizeId: "p2", label: "Call", stock: 2, wheelId: "w1", wheelTitle: "Main", at: t(0) },
    ],
    outOfSpins: [{ fanId: "f-bo", fanName: "Bo", at: t(7) }],
  };
}

// --- isUnread ------------------------------------------------------------------
check("never seen → unread", isUnread(t(1), null));
check("after seen → unread", isUnread(t(2), t(1)));
check("at seen → read", !isUnread(t(1), t(1)));
check("before seen → read", !isUnread(t(0), t(1)));
check("garbage timestamp with a seen marker → read (never a phantom badge)", !isUnread("nope", t(1)));

// --- derivation ----------------------------------------------------------------
{
  const feed = buildNotificationFeed(empty, null, ALL_ON);
  check("no sources → no items", feed.items.length === 0);
  check("no sources → unread 0", feed.unread === 0);
  check("seenAt echoed", feed.seenAt === null);
}

{
  const feed = buildNotificationFeed(sources(), null, ALL_ON);
  const kinds = feed.items.map((i) => i.kind);
  // 2 wins + 2 message threads (Ava's two collapse into one) + 2 stock + 1 out of spins.
  check("one item per win / thread / prize / fan", feed.items.length === 7);
  check("messages grouped by fan", kinds.filter((k) => k === "message").length === 2);
  check("newest first", feed.items.every((it, i, a) => i === 0 || a[i - 1].at >= it.at));
  check("never seen → every item unread", feed.unread === 7 && feed.items.every((i) => i.unread));

  const ava = feed.items.find((i) => i.kind === "message" && i.target.fanId === "f-ava")!;
  check("thread item takes the newest message time", ava.at === t(6));
  check("thread item says how many", /2 new messages/.test(ava.title) && /Ava/.test(ava.title));
  check("thread item previews the newest body", ava.body.startsWith("second"));
  check("thread item opens that fan's Inbox thread", ava.target.section === "inbox" && ava.target.fanId === "f-ava");
  const cy = feed.items.find((i) => i.kind === "message" && i.target.fanId === "f-cy")!;
  check("single message reads as 'New message from'", /New message from Cy/.test(cy.title));

  const win = feed.items.find((i) => i.id === "win:r1")!;
  check("win names fan + prize", /Ava/.test(win.title) && /Shoutout/.test(win.title));
  check("win opens Fulfilment", win.target.section === "prizes");

  const out = feed.items.find((i) => i.kind === "low_stock" && i.target.wheelId === "w1" && /out of stock/i.test(i.title));
  check("stock 0 reads as out of stock", !!out && /Signed photo/.test(out.title));
  const low = feed.items.find((i) => i.id === "stock:p2")!;
  check("low stock says how many are left", /2 left/.test(low.title));
  check("stock opens Wheels", low.target.section === "editor");

  const bo = feed.items.find((i) => i.kind === "out_of_spins")!;
  check("out of spins opens Fans filtered to that fan", bo.target.section === "fans" && bo.target.fanName === "Bo");
  check("item ids are unique", new Set(feed.items.map((i) => i.id)).size === feed.items.length);
}

// --- unread count follows the seen marker --------------------------------------
{
  const feed = buildNotificationFeed(sources(), t(4), ALL_ON);
  // Strictly after 12:04 → r2 (5), Ava thread (6), Bo (7).
  check("only items newer than seenAt are unread", feed.unread === 3);
  check("read items stay listed", feed.items.length === 7);
  check("unread flag per item matches", feed.items.filter((i) => i.unread).length === feed.unread);
  check("everything seen → 0", buildNotificationFeed(sources(), t(30), ALL_ON).unread === 0);
}

// --- Settings toggles apply to the in-app feed ---------------------------------
{
  const noWins = buildNotificationFeed(sources(), null, { ...ALL_ON, newSpin: false });
  check("'New spins & wins' off → no win items", !noWins.items.some((i) => i.kind === "win"));
  const noMsgs = buildNotificationFeed(sources(), null, { ...ALL_ON, messages: false });
  check("'New messages' off → no message items", !noMsgs.items.some((i) => i.kind === "message"));
  const noLow = buildNotificationFeed(sources(), null, { ...ALL_ON, lowBalance: false });
  check("'Low fan balance' off → no out-of-spins items", !noLow.items.some((i) => i.kind === "out_of_spins"));
  const allOff = buildNotificationFeed(sources(), null, { newSpin: false, lowBalance: false, messages: false });
  check("prize stock has no toggle: still shown with everything off", allOff.items.length === 2 && allOff.items.every((i) => i.kind === "low_stock"));
  check("unread counts only the shown items", allOff.unread === 2);
}

// --- bounds --------------------------------------------------------------------
{
  const many: NotificationSources = {
    ...empty,
    pendingWins: Array.from({ length: FEED_LIMIT + 15 }, (_, i) => ({
      id: "r" + i,
      fanName: "Fan " + i,
      prizeLabel: "Prize",
      at: new Date(Date.UTC(2026, 9, 26, 0, i)).toISOString(),
    })),
  };
  const feed = buildNotificationFeed(many, null, ALL_ON);
  check("feed is capped", feed.items.length === FEED_LIMIT);
  check("the cap keeps the newest", feed.items[0].id === "win:r" + (FEED_LIMIT + 14));
  check("unread counts what the cap kept", feed.unread === FEED_LIMIT);
}

{
  const long = "x".repeat(500);
  const feed = buildNotificationFeed(
    { ...empty, unreadMessages: [{ fanId: "f", fanName: "F", body: long, at: t(1) }] },
    null,
    ALL_ON
  );
  check("message preview is trimmed", feed.items[0].body.length <= 121);
}

check("threshold is a small positive number", LOW_STOCK_THRESHOLD >= 1 && LOW_STOCK_THRESHOLD <= 5);

console.log(`notificationFeed: ${passed} checks passed`);
