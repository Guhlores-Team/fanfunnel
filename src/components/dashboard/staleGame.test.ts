import assert from "node:assert";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { STALE_GAME_MESSAGE, gameFingerprint, staleGameCheck } from "./staleGame";

const game: WheelConfig = {
  id: "g1", title: "Spin", brandColor: "#ec4899", gameKind: "wheel", gameConfig: {}, isActive: true,
  prizes: [
    { id: "a", label: "Hug", rarity: "common", weight: 50, stock: null },
    { id: "b", label: "Call", rarity: "rare", weight: 5, stock: 3 },
  ],
};
const loaded = JSON.stringify(game);

assert.equal(staleGameCheck(loaded, structuredClone(game)), "same");
assert.equal(staleGameCheck(loaded, { ...game, prizes: game.prizes.map((p) => (p.id === "b" ? { ...p, stock: 1 } : p)) }), "same", "fans playing (stock going down) is not a conflict");
assert.equal(staleGameCheck(loaded, { ...game, isActive: false, activeFrom: "2026-01-01T00:00:00Z" }), "same", "activation and schedule are other controls");
assert.equal(staleGameCheck(loaded, { ...game, prizes: [game.prizes[0]] }), "changed", "a prize removed in another tab");
assert.equal(staleGameCheck(loaded, { ...game, prizes: [...game.prizes, { id: "c", label: "New", rarity: "epic", weight: 1 }] }), "changed", "a prize added elsewhere");
assert.equal(staleGameCheck(loaded, { ...game, title: "Renamed" }), "changed", "a renamed game");
assert.equal(staleGameCheck(loaded, { ...game, prizes: game.prizes.map((p) => (p.id === "a" ? { ...p, weight: 10 } : p)) }), "changed", "changed odds");
assert.equal(staleGameCheck(loaded, { ...game, prizes: game.prizes.map((p) => (p.id === "a" ? { ...p, delivery: "link" as const } : p)) }), "changed", "changed delivery");
assert.equal(staleGameCheck(loaded, { ...game, prizes: game.prizes.map((p) => (p.id === "a" ? { ...p, stock: 5 } : p)) }), "changed", "unlimited made limited elsewhere");
assert.equal(staleGameCheck("not json", game), "new");
assert.equal(staleGameCheck(JSON.stringify({ ...game, id: "other" }), game), "new", "a different game has nothing to compare");
assert.equal(gameFingerprint({ ...game, subtitle: undefined }), gameFingerprint({ ...game, subtitle: null as unknown as undefined }), "absent and null read the same");
assert.equal(STALE_GAME_MESSAGE, "This game was changed in another tab or by a team member. Reload to see the latest.");
console.log("staleGame: all checks passed");
