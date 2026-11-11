import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildNotificationFeed,
  buildNotificationItems,
  toNotificationItem,
  type NotificationSources,
} from "@/lib/data/notificationFeed";
import {
  DEFAULT_SHOW_DETAILS,
  GENERIC_BODY,
  GENERIC_TITLE,
  deviceLabel,
  isAllowedPushEndpoint,
  isPushKey,
  needsHomeScreenInstall,
} from "./config";
import { testPushPayload, toPushPayload } from "./payload";

// Web push, the pure parts: F8 parity (push text IS the bell's), the D9
// discreet default, what a payload may carry, the SSRF allowlist for
// subscription endpoints, the iPhone rule, and the service worker's handlers.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ROOT = join(import.meta.dirname, "../../..");
const t = (min: number) => new Date(Date.UTC(2026, 9, 27, 12, min)).toISOString();
const ALL_ON = { newSpin: true, lowBalance: true, messages: true };

const NAMES = ["Nova", "Bo", "Cy", "Dee"];
const PRIZES = ["VIP Month", "Custom video", "Signed photo"];
const src: NotificationSources = {
  pendingWins: [{ id: "r1", fanName: "Nova", prizeLabel: "VIP Month", emoji: "👑", at: t(1) }],
  unreadMessages: [
    { fanId: "f-bo", fanName: "Bo", body: "hey there", at: t(2) },
    { fanId: "f-bo", fanName: "Bo", body: "you around? " + "x".repeat(300), at: t(3) },
  ],
  lowStock: [
    { prizeId: "p1", label: "Custom video", emoji: "💋", stock: 3, wheelId: "w1", wheelTitle: "Main", at: t(4) },
    { prizeId: "p2", label: "Signed photo", stock: 0, wheelId: "w1", wheelTitle: "Main", at: t(5) },
  ],
  outOfSpins: [{ fanId: "f-dee", fanName: "Dee", at: t(6) }],
};

// --- F8: the bell and push derive from the same builder ------------------------
{
  const feed = buildNotificationFeed(src, null, ALL_ON);
  const items = buildNotificationItems(src, ALL_ON);
  check("every kind is covered", new Set(items.map((i) => i.kind)).size === 4);
  for (const bell of feed.items) {
    const item = items.find((i) => i.id === bell.id)!;
    const push = toPushPayload(item, true);
    check(`${bell.id}: detailed push title === bell title`, push.title === bell.title);
    check(`${bell.id}: detailed push body === bell body`, push.body === bell.body);
    check(`${bell.id}: tag is the bell item id (one notification per thread)`, push.tag === bell.id);
    check(`${bell.id}: opens the item's dashboard section`, push.url === `/dashboard?section=${bell.target.section}`);
  }
  const single = toNotificationItem("win", src.pendingWins[0]);
  check("toNotificationItem(win) is the feed's item", JSON.stringify(single) === JSON.stringify(items.find((i) => i.id === "win:r1")));
  const thread = items.find((i) => i.id === "msg:f-bo")!;
  check("a thread's push body is the bell's 120-char preview, not the full message", thread.body.length <= 121 && toPushPayload(thread, true).body === thread.body);
  check("message thread title counts the unread messages", thread.title === "Bo: 2 new messages");
}

// --- D9: discreet by default ----------------------------------------------------
{
  check("the lock-screen default is generic (D9)", DEFAULT_SHOW_DETAILS === false);
  const migration = readFileSync(join(ROOT, "supabase/migrations/0056_push_subscriptions.sql"), "utf8");
  check("the DB default matches (show_details default false)", /show_details boolean not null default false/.test(migration));
  for (const item of buildNotificationItems(src, ALL_ON)) {
    const p = toPushPayload(item, DEFAULT_SHOW_DETAILS);
    const text = JSON.stringify(p);
    check(`${item.id}: generic title/body`, p.title === GENERIC_TITLE && p.body === GENERIC_BODY);
    check(`${item.id}: generic payload has no fan name`, !NAMES.some((n) => text.includes(n)));
    check(`${item.id}: generic payload has no prize name`, !PRIZES.some((n) => text.includes(n)));
  }
}

// --- What a payload may carry ---------------------------------------------------
{
  const all = [...buildNotificationItems(src, ALL_ON).flatMap((i) => [toPushPayload(i, true), toPushPayload(i, false)]), testPushPayload()];
  for (const p of all) {
    check(`payload keys are exactly title/body/url/tag (${p.tag})`, Object.keys(p).sort().join() === "body,tag,title,url");
    check(`url is a same-origin dashboard section, no token (${p.tag})`, /^\/dashboard\?section=[a-z]+$/.test(p.url));
    check(`no fan link or token in the payload (${p.tag})`, !/\/spin\/|token|https?:/i.test(JSON.stringify(p)));
  }
}

// --- Prefs gate kinds; stock has no toggle ----------------------------------------
{
  const off = buildNotificationItems(src, { newSpin: false, lowBalance: false, messages: false });
  check("prefs off → only prize-stock items remain", off.length === 2 && off.every((i) => i.kind === "low_stock"));
}

// --- SSRF: the server only POSTs to real browser push services ---------------------
{
  const ok = [
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QFz",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ];
  for (const e of ok) check(`allowed: ${e}`, isAllowedPushEndpoint(e));
  const bad = [
    "http://fcm.googleapis.com/fcm/send/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://notfcm.googleapis.co/x",
    "javascript:alert(1)",
    "https://fcm.googleapis.com/" + "x".repeat(1100),
    42,
    null,
  ];
  for (const e of bad) check(`refused: ${String(e).slice(0, 60)}`, !isAllowedPushEndpoint(e));
  check("p256dh/auth must be base64url", isPushKey("BNc-_x==", 256) && !isPushKey("a b", 256) && !isPushKey("", 64) && !isPushKey("x".repeat(65), 64));
}

// --- Device labels and the iPhone rule ----------------------------------------------
{
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  check("iPhone · Safari", deviceLabel(IPHONE) === "iPhone · Safari");
  check("Android · Chrome", deviceLabel(ANDROID) === "Android · Chrome");
  check("unknown UA → generic label", deviceLabel(null) === "Device · Browser");
  check("label is short (fits the 80-char column)", deviceLabel(IPHONE.repeat(5)).length <= 80);
  check("iPhone in a Safari tab → add to Home Screen first", needsHomeScreenInstall(IPHONE, false));
  check("iPhone installed app → can subscribe", !needsHomeScreenInstall(IPHONE, true));
  check("iPad (desktop UA + touch) in Safari → add to Home Screen first", needsHomeScreenInstall(MAC, false, 5));
  check("a real Mac → can subscribe", !needsHomeScreenInstall(MAC, false, 0));
  check("Android → can subscribe in the browser", !needsHomeScreenInstall(ANDROID, false));
}

// --- The service worker shows pushes and opens only dashboard paths -----------------------
{
  const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
  check("sw.js handles push", /addEventListener\("push"/.test(sw));
  check("sw.js handles notificationclick", /addEventListener\("notificationclick"/.test(sw));
  check("every push shows a notification (userVisibleOnly)", /event\.waitUntil\(self\.registration\.showNotification\(/.test(sw));
  check("taps only open same-origin /dashboard paths", /u\.origin === self\.location\.origin/.test(sw) && /return HOME;/.test(sw));
  check("an open dashboard switches section in place", /postMessage\(\{ type: "ff:navigate"/.test(sw));
}

console.log(`web push: ${passed} checks passed`);
