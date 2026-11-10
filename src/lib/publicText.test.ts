import assert from "node:assert/strict";
import { PUBLIC_TEXT_CODES, flagText, isPublicTextCode, publicTextCheck, publicTextErrorMessage } from "./publicText";

// TS-04: creator public text (tagline, prize names and descriptions, note,
// display name) and board names may not carry links, e-mail addresses, phone
// numbers, other-app handles or slurs. Chat is flagged, never blocked. Both
// directions are pinned so the rule neither misses the obvious nor refuses
// ordinary prize copy.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const refused: [string, string][] = [
  // links
  ["https://example.com/vip", "link"], ["http://example.com", "link"], ["www.example.com", "link"],
  ["DM me on telegram t.me/xxx", "link"], ["Pay $20 at cash.app/xyz for VIP", "link"], ["jane.onlyfans.com", "link"],
  ["my real page is example dot com", "link"], ["example [dot] com", "link"], ["example(dot)com", "link"],
  ["find me on sub-domain.example.co", "link"], ["EXAMPLE.COM", "link"], ["linktr.ee/jane", "link"],
  // e-mail
  ["write to jane@example.com", "email"], ["jane.doe+vip@mail.example.org", "email"],
  // phone numbers
  ["call +1 555 123 4567", "phone"], ["call me 555-123-4567", "phone"], ["(555) 123-4567", "phone"], ["555.123.4567", "phone"],
  ["0044 20 7946 0958", "phone"], ["+447911123456", "phone"],
  // handles
  ["follow @janedoe", "handle"], ["@jane.doe on the other app", "handle"], ["ig: janedoe", "handle"], ["Snap - no, snap: janedoe", "handle"],
  ["telegram=janedoe", "handle"], ["cash app: $janedoe", "handle"], ["Discord: jane#1234", "handle"],
  // slurs, including the obvious evasions
  ["you n*gger", "slur"], ["f@gg0t", "slur"], ["F.A.G", "slur"], ["such a tranny", "slur"], ["retards", "slur"], ["k1ke", "slur"],
];
for (const [text, problem] of refused) {
  const flags = flagText(text);
  check(`flagged (${problem}): "${text}" → ${flags.join(",") || "nothing"}`, flags.includes(problem as never));
  const r = publicTextCheck(text, { field: "prizeLabel" });
  check(`refused: "${text}"`, !r.ok && r.problem === problem);
}

const allowed = [
  "Selfie", "A signed photo", "VIP call (10 min)", "Mystery box", "1,000,000 tickets", "Dinner for 2 at 7pm",
  "Breakfast at Tiffany's", "Vol. 2 poster", "Dr Love's kiss", "e.g. a hoodie", "Open 24/7", "Order #1234567",
  "20% off", "$50 gift card", "Tip jar bonus", "Chat with me", "Win a trip (details via chat)", "No. 1 fan award",
  "St. Louis meetup", "Assassin's Creed key", "Raccoon plush", "Coupon code SPRING", "The @ symbol alone: @",
  "Email me? No - ask in chat", "Happy hour 5-7", "2024 calendar", "Room 101", "Pay what you want", "Snap a selfie with me",
  "", "   ",
];
for (const text of allowed) {
  check(`allowed: "${text}" (${flagText(text).join(",") || "clean"})`, publicTextCheck(text, { field: "prizeLabel" }).ok);
}
check("non-string values pass (presence is the caller's rule)", publicTextCheck(undefined, { field: "tagline" }).ok && flagText(42).length === 0);

// Messages name the field and the problem in plain words; routes get a stable code.
const tag = publicTextCheck("see www.example.com", { field: "tagline" });
check("tagline message", !tag.ok && tag.message === "Your tagline can't include links or web addresses." && tag.code === "contains_link");
const note = publicTextCheck("call 555 123 4567", { field: "creatorNote" });
check("note message", !note.ok && note.message === "Your note to fans can't include phone numbers." && note.code === "contains_phone");
const board = publicTextCheck("ig:jane", { field: "boardName" });
check("board message", !board.ok && board.message === "Board names can't include @handles or usernames for other apps." && board.code === "contains_handle");
const mail = publicTextCheck("jane@example.com", { field: "displayName" });
check("display name e-mail message", !mail.ok && mail.message === "Your display name can't include e-mail addresses." && mail.code === "contains_email");
check("the first problem wins, in order", publicTextCheck("f@gg0t https://x.com", { field: "pageText" }).ok === false && (publicTextCheck("f@gg0t https://x.com", { field: "pageText" }) as { problem: string }).problem === "link");

// Chat: every problem is reported, none blocks.
check("flagText lists every problem", flagText("hello https://example.com 555-123-4567 @jane").join(",") === "link,phone,handle");
check("flagText on clean chat is empty", flagText("see you at 7, bring snacks").length === 0);

// Code mapping for the UI.
for (const code of Object.values(PUBLIC_TEXT_CODES)) {
  check(`${code} is a public-text code with a message`, isPublicTextCode(code) && typeof publicTextErrorMessage(code) === "string");
}
check("unknown codes are not public-text codes", !isPublicTextCode("db_error") && publicTextErrorMessage("db_error") === null);

console.log(`public text: ${passed} checks passed`);
