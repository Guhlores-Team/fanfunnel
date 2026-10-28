// Demo (mock) path parity for the privacy self-service: a fan token exports
// and deletes only its own fan; deleting keeps the fan's wins in the creator's
// fulfilment queue anonymized ("Fan"), tombstones the links, and leaves a
// PII-free notice in the creator's bell; the seeded demo fan is protected.
import assert from "node:assert/strict";
import {
  mockAckFan,
  mockAddWishlist,
  mockCreatePass,
  mockDeleteFanData,
  mockExportCreatorData,
  mockExportFanData,
  mockGetFanLinkStatus,
  mockGetNotificationSources,
  mockGetOverview,
  mockSendFanMessage,
  mockSpin,
} from "./mock";
import { buildNotificationFeed } from "./notificationFeed";

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

async function main() {
  const a = mockCreatePass("Privacy Alice", 3);
  const b = mockCreatePass("Privacy Bob", 3);
  for (const t of [a.token, b.token]) mockAckFan(t);
  const spun = await mockSpin(a.token);
  check("fan A spun", !("error" in spun));
  await mockSpin(b.token);
  mockSendFanMessage(a.token, "message from alice");
  mockSendFanMessage(b.token, "message from bob");
  check("B wished for a prize", "ok" in mockAddWishlist(b.token, "Signed Polaroid"));

  const exp = mockExportFanData(a.token)!;
  const text = JSON.stringify(exp);
  check("A's export is A", exp.profile.displayName === "Privacy Alice");
  check("A's export has A's spin", exp.spins.length === 1);
  check("A's export has none of B's data", !text.includes("Bob") && !text.includes("message from bob") && !text.includes(b.token));
  check("A's own token is masked", !text.includes(a.token));

  const before = mockGetOverview().metrics.spinsPlayed;
  const del = await mockDeleteFanData(a.token);
  check("delete ok", "ok" in del && del.spinsKept === 1);
  check("A's export is gone", mockExportFanData(a.token) === null);
  check("B is untouched", mockExportFanData(b.token)?.profile.displayName === "Privacy Bob");
  check("B's chat and wishlist are untouched", JSON.stringify(mockExportFanData(b.token)).includes("message from bob") && mockExportFanData(b.token)!.wishlist.length === 1);
  check("the creator's spin count is unchanged (anonymized, not erased)", mockGetOverview().metrics.spinsPlayed === before);
  const red = mockGetOverview().redemptions;
  check("A's prize stays in the queue as 'Fan'", red.some((r) => r.fanName === "Fan") && !red.some((r) => r.fanName === "Privacy Alice"));
  check("the link says it was deleted", (await mockGetFanLinkStatus(a.token)) === "fan_deleted");
  check("a live link has no tombstone", (await mockGetFanLinkStatus(b.token)) === null);
  check("A's chat is gone from the creator export", !JSON.stringify(mockExportCreatorData()).includes("message from alice"));
  check("the creator export never holds a full link token", !JSON.stringify(mockExportCreatorData()).includes(b.token));

  const feed = buildNotificationFeed(mockGetNotificationSources(), null, { newSpin: true, lowBalance: true, messages: true });
  const notice = feed.items.find((i) => i.kind === "fan_deleted");
  check("the creator's bell shows the deletion", !!notice && /1 spin stay/.test(notice.body));
  check("…without the fan's name", !JSON.stringify(notice).includes("Alice"));

  const demo = await mockDeleteFanData("demo");
  check("the seeded demo fan can't be deleted", "error" in demo && demo.error === "not_allowed");
  check("unknown token → not_found", "error" in (await mockDeleteFanData("nope-nope")));

  console.log(`privacy mock parity: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
