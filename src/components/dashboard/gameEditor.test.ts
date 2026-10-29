import assert from "node:assert/strict";
import { gameSaveFeatureAllowed, canCreateGame, creatorGameSettings, editableGamePayload, gameDraftError, gameRefusalMessage, readGameFeatures, type CreatorGameWheel } from "./gameEditor";
import { FEATURES, defaultFeatures } from "@/lib/features";

for (const raw of [null, undefined, [], {}, { features: null }, { features: [] }]) assert.equal(readGameFeatures(raw), null);
assert.deepEqual(readGameFeatures({ features: { scratch: "true", bingo: 1, wheel: false } }), { wheel: true, scratch: false, bingo: false }, "truthy or client-like values never unlock extra types");
const enabled = readGameFeatures({ features: { scratch: true, bingo: true } });
assert.equal(canCreateGame("wheel", null), true);
assert.equal(canCreateGame("scratch", null), false);
assert.equal(canCreateGame("bingo", null), false);
assert.equal(canCreateGame("scratch", enabled), true);
assert.equal(canCreateGame("bingo", readGameFeatures({ features: { scratch: true, bingo: false } })), false);
assert.deepEqual(defaultFeatures(), { wheel: true, scratch: false, bingo: false }, "release does not auto-grant features to accounts");
assert.equal(FEATURES.find(feature => feature.key === "scratch")?.comingSoon, undefined, "0060 releases scratch");
assert.equal(FEATURES.find(feature => feature.key === "bingo")?.comingSoon, true, "0060 keeps bingo unavailable until its separate ledger release");

const wheel: CreatorGameWheel = { id: "game", title: "Bingo", gameKind: "bingo", gameConfig: { size: 3, linePrizeId: "p0" }, gameKindLocked: false, gameReady: true, prizes: Array.from({ length: 9 }, (_, index) => ({ id: `p${index}`, label: `Prize ${index}`, rarity: index === 0 ? "rare" : "common", weight: 1, stock: null })) };
assert.equal(gameDraftError(wheel), null);
assert.equal(gameDraftError({ ...wheel, gameReady: false, gameConfig: { size: 3, linePrizeId: null } }), "Choose valid game settings before saving.", "inactive draft null target never passes ready settings");
assert.equal(creatorGameSettings({ ...wheel, gameConfig: { size: 3, linePrizeId: null } }), null);
assert.match(gameDraftError({ ...wheel, prizes: wheel.prizes.slice(0, 8) })!, /9 distinct unlimited/);
assert.match(gameDraftError({ ...wheel, prizes: [...wheel.prizes.slice(0, 8), wheel.prizes[0]] })!, /9 distinct unlimited/, "duplicate IDs cannot masquerade as nine squares");
for (const patch of [{ delivery: "codes" as const }, { stock: 0 }, { stock: 1 }, { weight: 0 }, { weight: -1 }]) {
  assert.match(gameDraftError({ ...wheel, prizes: wheel.prizes.map((prize, index) => index === 8 ? { ...prize, ...patch } : prize) })!, /9 distinct unlimited/);
}
assert.match(gameDraftError({ ...wheel, prizes: wheel.prizes.map((prize) => ({ ...prize, rarity: "common" })) })!, /fallback/);
assert.match(gameDraftError({ ...wheel, gameConfig: { size: 3, linePrizeId: "someone-else" } })!, /Choose a saved line prize/);
const zeroTarget = { id: "target", label: "Explicit line reward", rarity: "legendary" as const, weight: 0, stock: 1 };
assert.equal(gameDraftError({ ...wheel, prizes: [...wheel.prizes, zeroTarget], gameConfig: { size: 3, linePrizeId: zeroTarget.id } }), null, "chosen line prize may have zero natural tickets and limited stock");
assert.equal(gameDraftError({ ...wheel, prizes: [...wheel.prizes, { ...zeroTarget, stock: 0 }], gameConfig: { size: 3, linePrizeId: zeroTarget.id } }), null, "sold-out chosen line target can use the mandatory fallback");
assert.equal(gameDraftError({ ...wheel, gameKind: "scratch", gameConfig: { style: "classic" } }), null);
assert.equal(gameDraftError({ id: "old", title: "Historical wheel", prizes: [] }), null, "historical missing game fields retain wheel settings; base prize validation remains separate");
const payload = editableGamePayload(wheel);
assert.ok(!Object.hasOwn(payload, "gameKindLocked") && !Object.hasOwn(payload, "gameReady"), "read-only server metadata never enters the save intent");
assert.equal(payload.gameKind, "bingo");
assert.deepEqual(payload.gameConfig, wheel.gameConfig);
assert.equal(wheel.gameKindLocked, false, "save projection does not mutate the live draft");
assert.equal(wheel.gameReady, true);
assert.match(gameRefusalMessage("bingo_active_card")!, /paid progress remains markable/);
assert.equal(gameRefusalMessage("toString"), null);
assert.equal(gameRefusalMessage({ error: "feature_disabled" }), null);
console.log("gameEditor.test: feature denial, strict ready settings, bingo eligibility, protected save metadata and refusal checks passed");

const scratch = { ...wheel, gameKind: "scratch" as const, gameConfig: { style: "classic" as const } };
const denied = readGameFeatures({ features: { scratch: false, bingo: false } });
assert.equal(gameSaveFeatureAllowed(scratch, JSON.stringify(scratch), denied), true, "feature loss keeps existing same-kind edits usable");
assert.equal(gameSaveFeatureAllowed(scratch, JSON.stringify({ ...scratch, gameKind: "wheel", gameConfig: {} }), denied), false, "conversion cannot borrow a lost feature");
assert.equal(gameSaveFeatureAllowed(scratch, JSON.stringify({ ...scratch, id: "different-game" }), denied), false, "another game's saved metadata cannot grandfather this conversion");
assert.equal(gameSaveFeatureAllowed(scratch, "{bad", denied), false, "unknown saved metadata stays closed");
