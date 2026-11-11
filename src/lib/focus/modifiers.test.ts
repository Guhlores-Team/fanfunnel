import assert from "node:assert/strict";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { applyRareBoost, pickPrizeWithPity } from "@/lib/games/wheel/engine";
import { buildFocusPoolSnapshot, drawFromSnapshot, snapshotOdds } from "@/lib/games/wheel/fairnessV3";
import { composeModifiers, effectiveOdds, pickWithModifiers } from "./modifiers";
import { estimatePackValue } from "./ev";
import { MAX_COMBINED_BOOST } from "./config";

let passed = 0;
const check = (label: string, value: boolean) => { assert.ok(value, label); passed++; };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-10;
const throws = (label: string, run: () => unknown) => { assert.throws(run, label); passed++; };
const wheel: WheelConfig = {
  id: "w", title: "W",
  prizes: [
    { id: "target", label: "Target", rarity: "common", weight: 10, stock: null, cost: 1000 },
    { id: "other", label: "Other", rarity: "common", weight: 88, stock: null, cost: 100 },
    { id: "rare", label: "Rare", rarity: "rare", weight: 2, stock: null, cost: 500 },
  ],
};
const focus = { prizeId: "target", multiplier: 3, spinsLeft: 7, totalSpins: 10 };
const neutral = { happyHourMultiplier: null, pityCounter: 0 };
const original = JSON.stringify(wheel);
const focused = composeModifiers(wheel, { ...neutral, focus });
check("the target alone gets focused tickets", focused.config.prizes.map((p) => p.weight).join() === "30,88,2");
check("input stays unchanged", JSON.stringify(wheel) === original);
check("focus proof is applied with its actual multiplier", focused.focus?.applied === true && focused.focus.effectiveMultiplier === 3);
const consumed = pickWithModifiers(wheel, { ...neutral, focus }, () => 0.5);
check("one eligible spin consumes one focus", consumed.focusConsumed && consumed.nextFocusSpinsLeft === 6);
check("a natural target win does not end a soft focus early", pickWithModifiers(wheel, { ...neutral, focus }, () => 0).nextFocusSpinsLeft === 6);
check("last focused spin reaches zero", pickWithModifiers(wheel, { ...neutral, focus: { ...focus, spinsLeft: 1 } }, () => 0).nextFocusSpinsLeft === 0);

const rareTarget: WheelConfig = { ...wheel, prizes: wheel.prizes.map((p) => p.id === "target" ? { ...p, rarity: "rare", weight: 1 } : p) };
const capped = composeModifiers(rareTarget, { happyHourMultiplier: 3, pityCounter: 0, focus: { ...focus, multiplier: 3 } });
check("combined target multiplier caps at five", capped.focus?.effectiveMultiplier === MAX_COMBINED_BOOST && capped.config.prizes[0].weight === 5);
check("new happy-hour multiplier globally caps at five", composeModifiers(rareTarget, { happyHourMultiplier: 10, pityCounter: 0 }).happyHour?.multiplier === 5);
const rounding = composeModifiers(rareTarget, { happyHourMultiplier: 1.5, pityCounter: 0, focus: { ...focus, multiplier: 1.5 } });
check("composition rounds once from base tickets", rounding.config.prizes[0].weight === 2);
check("rounding that gives no benefit preserves the paid focus", rounding.focus?.pauseReason === "no_increase" && !rounding.focus.applied);
const maxed = pickWithModifiers(rareTarget, { happyHourMultiplier: 5, pityCounter: 0, focus }, () => 0);
check("already capped target does not consume focus", !maxed.focusConsumed && maxed.nextFocusSpinsLeft === 7);
const zero: WheelConfig = { ...wheel, prizes: wheel.prizes.map((p) => p.id === "target" ? { ...p, weight: 0 } : p) };
check("zero tickets stay zero under a boost", composeModifiers(zero, { ...neutral, focus }).config.prizes[0].weight === 0);
check("zero-ticket focus is kept", !pickWithModifiers(zero, { ...neutral, focus }, () => 0).focusConsumed);
const allZero: WheelConfig = { ...wheel, prizes: wheel.prizes.map((p) => ({ ...p, weight: 0 })) };
const zeroPool = composeModifiers(allZero, { happyHourMultiplier: 3, pityCounter: 0, focus });
check("zero-ticket fallback remains uniform without invented tickets", effectiveOdds(zeroPool.config, { pityCounter: 0, focus: zeroPool.focus, chase: null }).rows.every((row) => close(row.chance, 1 / 3)));
check("uniform zero-ticket pool does not consume a no-effect focus", !pickWithModifiers(allZero, { happyHourMultiplier: 3, pityCounter: 0, focus }, () => 0).focusConsumed);

const pity = pickWithModifiers(wheel, { happyHourMultiplier: null, pityCounter: 9, focus }, () => 0);
check("global pity still forces a rare", pity.prize.id === "rare" && pity.pityAwarded && pity.nextPityCounter === 0);
check("pity-excluded common focus pauses without consumption", !pity.focusConsumed && pity.nextFocusSpinsLeft === 7);
check("the pause reason is explicit", composeModifiers(wheel, { happyHourMultiplier: null, pityCounter: 9, focus }).focus?.pauseReason === "pity");
const soldOut: WheelConfig = { ...wheel, prizes: wheel.prizes.map((p) => p.id === "target" ? { ...p, stock: 0 } : p) };
check("sold-out focus pauses", composeModifiers(soldOut, { ...neutral, focus }).focus?.pauseReason === "sold_out");
check("another wheel does not consume focus", !pickWithModifiers(wheel, { ...neutral, focus: { ...focus, prizeId: "elsewhere" } }, () => 0).focusConsumed);
const single: WheelConfig = { ...wheel, prizes: [wheel.prizes[0]] };
check("already-certain target preserves focus", !pickWithModifiers(single, { ...neutral, focus }, () => 0).focusConsumed);

const chase = { prizeId: "target", counter: 4, within: 5, reserved: true };
const chasePool = buildFocusPoolSnapshot(soldOut, { happyHourMultiplier: null, pityCounter: 9, chase });
check("personal reserved unit remains in the snapshot at free stock zero", chasePool.prizes.some((p) => p.id === "target"));
check("another fan cannot see that reserved unit in their own pool", !buildFocusPoolSnapshot(soldOut, neutral).prizes.some((p) => p.id === "target"));
const guaranteed = drawFromSnapshot(chasePool, new Set(), () => 0.999);
check("chase takes precedence over global pity", guaranteed.prize.id === "target" && guaranteed.chaseAwarded === true && guaranteed.pityAwarded === false);
check("common forced target advances global pity", guaranteed.nextPityCounter === 10);
check("guaranteed target consumes exactly one chase step", guaranteed.chaseConsumed === true && guaranteed.chaseCompleted === true && guaranteed.nextChaseCounter === 5);
check("forced target odds are exactly one", snapshotOdds(chasePool).rows.find((r) => r.prize.id === "target")?.chance === 1 && !snapshotOdds(chasePool).pityForced);
throws("a reserved target cannot be discarded as a stock exclusion", () => drawFromSnapshot(chasePool, new Set(["target"]), () => 0.5));
throws("finite chase without a unit fails closed", () => composeModifiers(soldOut, { ...neutral, chase: { ...chase, reserved: false } }));
const early = pickWithModifiers(wheel, { ...neutral, chase: { ...chase, counter: 0, reserved: false } }, () => 0);
check("early natural target completes chase without claiming forced odds", early.chaseCompleted && !early.chaseAwarded && early.nextChaseCounter === 1);
const rareChase = pickWithModifiers(rareTarget, { ...neutral, chase: { ...chase, reserved: false } }, () => 0);
check("rare forced chase resets pity", rareChase.chaseAwarded && rareChase.nextPityCounter === 0);
const pausedChase = pickWithModifiers(wheel, { ...neutral, chase: { ...chase, prizeId: "elsewhere" } }, () => 0);
check("another wheel does not advance chase", !pausedChase.chaseConsumed && pausedChase.nextChaseCounter === 4);

const focusPool = buildFocusPoolSnapshot(wheel, { ...neutral, focus });
const targetGone = drawFromSnapshot(focusPool, new Set(["target"]), () => 0);
check("target lost during a stock re-draw keeps the focus spin", !targetGone.focusConsumed && targetGone.nextFocusSpinsLeft === 7);
const onlyTarget = drawFromSnapshot(focusPool, new Set(["other", "rare"]), () => 0);
check("a stock re-draw that makes the target certain keeps the focus", !onlyTarget.focusConsumed && onlyTarget.nextFocusSpinsLeft === 7);
for (const counter of [0, 5, 9, 15]) {
  const old = pickPrizeWithPity(applyRareBoost(wheel, 2), { pityCounter: counter }, () => 0.4);
  const next = pickWithModifiers(wheel, { happyHourMultiplier: 2, pityCounter: counter }, () => 0.4);
  check("neutral modifiers retain the ordinary/pity draw", old.prize.id === next.prize.id && old.pityAwarded === next.pityAwarded && old.nextPityCounter === next.nextPityCounter);
}
throws("focus and chase cannot stack", () => composeModifiers(wheel, { ...neutral, focus, chase }));
throws("over-cap multiplier refused", () => composeModifiers(wheel, { ...neutral, focus: { ...focus, multiplier: 6 } }));
throws("finished focus cannot be consumed again", () => composeModifiers(wheel, { ...neutral, focus: { ...focus, spinsLeft: 0 } }));
throws("expired chase counter refused", () => composeModifiers(wheel, { ...neutral, chase: { ...chase, counter: 5 } }));
throws("non-finite tickets fail closed", () => composeModifiers({ ...wheel, prizes: [{ ...wheel.prizes[0], weight: NaN }] }, neutral));

// EV includes all prizes and the pity state; extra target payout is a separate
// figure, and a missing cost cannot silently be counted as zero.
const ev = estimatePackValue(wheel, { kind: "focus", prizeId: "target", multiplier: 3, spins: 5, priceCents: 100 });
check("preview uses the actual starting odds", close(ev.baseChance, 0.1) && close(ev.boostedChance, 0.25));
check("preview counts extra target wins", ev.expectedAdditionalTargetWins > 0 && ev.expectedTargetWins > 1);
check("total prize cost includes other prizes", ev.expectedTotalCostCents! > ev.expectedTargetWins * 1000);
check("below-cost pack warned", ev.priceBelowExpectedCost === true);
const unknown = estimatePackValue({ ...wheel, prizes: wheel.prizes.map((p) => ({ ...p, cost: undefined })) }, { kind: "focus", prizeId: "target", spins: 5, priceCents: 500 });
check("unknown costs are not a false zero estimate", unknown.expectedTotalCostCents === null && unknown.priceBelowExpectedCost === null && unknown.unknownCostPrizes === 3);
const partlyKnown = estimatePackValue({ ...wheel, prizes: wheel.prizes.map((p) => p.id === "target" ? p : { ...p, cost: undefined }) }, { kind: "focus", prizeId: "target", spins: 5, priceCents: 1 });
check("a known lower bound can warn even when other costs are missing", partlyKnown.expectedTotalCostCents === null && partlyKnown.priceBelowExpectedCost === true && partlyKnown.expectedKnownCostCents > 1);
const free = estimatePackValue({ ...wheel, prizes: wheel.prizes.map((p) => ({ ...p, cost: 0 })) }, { kind: "focus", prizeId: "target", spins: 5, priceCents: 0 });
check("explicit zero costs are distinct from unknown costs", free.expectedTotalCostCents === 0 && free.unknownCostPrizes === 0 && free.priceBelowExpectedCost === false);
const chaseEv = estimatePackValue(wheel, { kind: "chase", prizeId: "target", spins: 5, within: 5, priceCents: 500 });
check("chase preview includes its guaranteed target unit", chaseEv.expectedTargetWins >= 1 && chaseEv.guaranteedTargetCostCents === 1000 && chaseEv.priceBelowExpectedCost === true);
const pityEv = estimatePackValue(wheel, { kind: "focus", prizeId: "target", spins: 1, pityCounter: 9 });
check("pity-aware first common focus chance is zero", pityEv.baseChance === 0 && pityEv.boostedChance === 0 && pityEv.expectedTotalCostCents === 500);
check("sold-out preview cannot promise a pack", !estimatePackValue(soldOut, { kind: "chase", prizeId: "target", spins: 5 }).available);
check("estimated probabilities normalize", close(effectiveOdds(focused.config, { pityCounter: 0, focus: focused.focus, chase: null }).rows.reduce((sum, r) => sum + r.chance, 0), 1));

console.log(`focus modifiers/EV: ${passed} checks passed`);
