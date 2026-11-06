import assert from "node:assert";
import type { WheelConfig } from "@/lib/games/wheel/types";
import type { PrizeDeliveryView } from "@/lib/rewards/config";
import { applyPrizeDelivery } from "./prizeDeliveryState";

const config: WheelConfig = {
  id: "wheel", title: "Unsaved title", subtitle: "Keep this draft",
  prizes: [
    { id: "a", label: "Edited prize", rarity: "rare", weight: 5, stock: 99, cost: 1200 },
    { id: "b", label: "Other", rarity: "common", weight: 40 },
  ],
};
const view: PrizeDeliveryView = {
  prizeId: "a", delivery: "codes", ready: true, value: "PRIVATE REWARD VALUE",
  codesLeft: 3, codesUsed: 1, preview: ["••••ABCD"],
};
const original = structuredClone(config);
const result = applyPrizeDelivery(config, view);
assert.equal(result.prizes[0].delivery, "codes");
assert.equal(result.prizes[0].stock, 3);
assert.equal(result.title, "Unsaved title");
assert.equal(result.subtitle, "Keep this draft");
assert.equal(result.prizes[0].label, "Edited prize");
assert.equal(result.prizes[0].weight, 5);
assert.equal(result.prizes[0].cost, 1200);
assert.equal(result.prizes[1], config.prizes[1]);
assert.deepEqual(config, original, "metadata updates never mutate a captured draft");
assert.equal(JSON.stringify(result).includes("PRIVATE REWARD VALUE"), false, "reward values never enter a wheel payload");
assert.equal(JSON.stringify(result).includes("ABCD"), false, "masked code previews stay outside the wheel payload too");
assert.equal(applyPrizeDelivery(config, { ...view, prizeId: "missing" }), config, "a late response for another wheel cannot change this draft");
const manual = applyPrizeDelivery(result, { ...view, delivery: "manual", codesLeft: 0 });
assert.equal(manual.prizes[0].stock, 3, "switching to manual preserves the server's existing plain stock limit");
assert.equal(manual.prizes[0].delivery, "manual");
console.log("prizeDeliveryState.test: 14 checks passed");
