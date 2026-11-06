// A52 (demo path): the demo's link-in-bio page and share card follow the live
// game's kind exactly like the Supabase path.
import assert from "node:assert/strict";
import { mockAckFan, mockCreatePass, mockCreateWheel, mockGetAdminOverview, mockSaveWheel, mockSetActiveWheel, mockSpin, mockUpdateAccount } from "./mock";
import { resetMockPublicProfile } from "./mockPublicProfile";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

async function main() {
  const { getPublicProfileBySlug, getShareCard, setMyPublicProfile } = await import("./index");
  resetMockPublicProfile();
  const before = await getPublicProfileBySlug("demo-creator");
  check("the demo starts on its wheel", before?.profile.gameKind === "wheel");
  check("an unset demo tagline stays unset so the page uses the game's line", before?.profile.tagline === null);

  const account = mockGetAdminOverview().accounts.find((a) => a.id === "acc-you")!;
  mockUpdateAccount(account.id, { features: { ...account.features, scratch: true } });
  const game = mockCreateWheel({ gameKind: "scratch", name: "Demo scratch" }).wheel;
  mockSaveWheel({ ...game, prizes: [{ id: "s1", label: "Sticker", emoji: "🌟", rarity: "common", weight: 1 }] });
  mockSetActiveWheel(game.id);
  check("a live scratch game shows on the demo public page", (await getPublicProfileBySlug("demo-creator"))?.profile.gameKind === "scratch");

  const fan = mockCreatePass("Share fan", 2, undefined, undefined, undefined, undefined, undefined, undefined, game.id);
  mockAckFan(fan.token);
  const win = await mockSpin(fan.token, "share-seed");
  assert.ok(!("error" in win));
  const card = await getShareCard(win.shareId);
  check("a demo scratch win's share card carries scratch", card?.gameKind === "scratch" && card.prizeLabel === "Sticker");

  await setMyPublicProfile({ tagline: "Come play" });
  check("a saved tagline is still shown as written", (await getPublicProfileBySlug("demo-creator"))?.profile.tagline === "Come play");
  resetMockPublicProfile();
  console.log(`publicGameKindDemo.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
