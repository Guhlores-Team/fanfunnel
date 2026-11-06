import type { WheelConfig } from "../core/types";
import { buildFocusPoolSnapshot, snapshotOdds } from "../wheel/fairnessV3";
import { isRarePrize } from "@/lib/focus/modifiers";
import { BINGO_FULL_MASK, bingoEligible, completedLines, type BingoState } from "./engine";
import { buildBingoPoolSnapshot } from "../core/gameProof";

export interface BingoValueOptions {
  linePrizeId: string;
  plays: number;
  pityCounter?: number;
  happyHourMultiplier?: number | null;
  before?: BingoState | null;
  priceCents?: number;
}
export interface BingoValueEstimate {
  available: boolean;
  plays: number;
  expectedLines: number;
  expectedPrimaryCostCents: number | null;
  expectedBonusCostCents: number | null;
  expectedTotalCostCents: number | null;
  expectedKnownCostCents: number;
  unknownCostPrizes: number;
  priceBelowExpectedCost: boolean | null;
  assumesUnchangedPool: true;
  representativeCard: boolean;
}
const bits = (mask: number) => mask.toString(2).replaceAll("0", "").length;
const knownCost = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Fixed-current-pool finite-state expectation, including all primary payouts
 * and each newly completed line. Unknown costs remain unknown. Without an
 * existing card, sorted first-nine is an explicitly representative card, not
 * an average over every possible randomly generated card. Resets reuse this
 * representative layout. Stock depletion and future edits are not forecast.
 */
export function estimateBingoValue(config: WheelConfig, options: BingoValueOptions): BingoValueEstimate {
  const empty: BingoValueEstimate = {
    available: false, plays: options.plays, expectedLines: 0, expectedPrimaryCostCents: null,
    expectedBonusCostCents: null, expectedTotalCostCents: null, expectedKnownCostCents: 0,
    unknownCostPrizes: 0, priceBelowExpectedCost: null, assumesUnchangedPool: true,
    representativeCard: !options.before,
  };
  if (!Number.isSafeInteger(options.plays) || options.plays < 1 || options.plays > 50 ||
      !Number.isSafeInteger(options.pityCounter ?? 0) || (options.pityCounter ?? 0) < 0 ||
      (options.priceCents !== undefined && !knownCost(options.priceCents))) return empty;
  let snapshot;
  try {
    snapshot = buildBingoPoolSnapshot(config, { pityCounter: options.pityCounter ?? 0, happyHourMultiplier: options.happyHourMultiplier ?? null },
      { size: 3, linePrizeId: options.linePrizeId }, options.before ?? null);
  } catch { return empty; }
  if (snapshot.game !== "bingo") return empty;
  const costs = new Map(config.prizes.map((p) => [p.id, p.cost]));
  const bonusPool = snapshot.bingo.bonus;
  const bonusRows = bonusPool.selected ? [{ prize: bonusPool.selected, chance: 1 }] : (() => {
    const total = bonusPool.fallback.reduce((sum, p) => sum + p.w, 0);
    return bonusPool.fallback.map((prize) => ({ prize, chance: prize.w / total }));
  })();
  const unknown = new Set<string>();
  let bonusKnown = 0;
  let bonusUnknown = false;
  for (const row of bonusRows) {
    const cost = costs.get(row.prize.id);
    if (knownCost(cost)) bonusKnown += cost * row.chance;
    else bonusUnknown = true;
  }
  const canonicalCard = snapshot.bingo.catalog.slice(0, 9);
  const before = options.before;
  // A full visible card is replaced only by this next paid transition.
  const firstCells = before && before.markedMask !== BINGO_FULL_MASK ? before.cells : canonicalCard;
  const firstMask = before && before.markedMask !== BINGO_FULL_MASK ? before.markedMask : 0;
  // key = representativeLayout:mask:pity. Two layouts suffice until first reset.
  let states = new Map([[`0:${firstMask}:${Math.min(options.pityCounter ?? 0, 9)}`, 1]]);
  const oddsCache = new Map<number, ReturnType<typeof snapshotOdds>["rows"]>();
  let primaryKnown = 0;
  let primaryUnknown = false;
  let expectedLines = 0;
  for (let step = 0; step < options.plays; step++) {
    const next = new Map<string, number>();
    for (const [key, probability] of states) {
      const [layout, previousMask, pity] = key.split(":").map(Number);
      const reset = previousMask === BINGO_FULL_MASK;
      const nextLayout = reset ? 1 : layout;
      const currentMask = reset ? 0 : previousMask;
      const card = nextLayout === 0 ? firstCells : canonicalCard;
      let odds = oddsCache.get(pity);
      if (!odds) {
        odds = snapshotOdds(buildFocusPoolSnapshot(config, { pityCounter: pity, happyHourMultiplier: options.happyHourMultiplier ?? null })).rows;
        oddsCache.set(pity, odds);
      }
      for (const { prize, chance } of odds) {
        if (chance === 0) continue;
        const mass = probability * chance;
        const cost = costs.get(prize.id);
        if (knownCost(cost)) primaryKnown += mass * cost;
        else { primaryUnknown = true; unknown.add(prize.id); }
        const index = card.findIndex((cell) => cell.id === prize.id);
        const mask = currentMask | (index < 0 ? 0 : 1 << index);
        const lines = bits(completedLines(mask) & ~completedLines(currentMask));
        expectedLines += mass * lines;
        if (lines && bonusUnknown) {
          for (const row of bonusRows) if (!knownCost(costs.get(row.prize.id))) unknown.add(row.prize.id);
        }
        const nextPity = isRarePrize(prize) ? 0 : Math.min(pity + 1, 9);
        const nextKey = `${nextLayout}:${mask}:${nextPity}`;
        next.set(nextKey, (next.get(nextKey) ?? 0) + mass);
      }
    }
    states = next;
  }
  const bonusTotalKnown = expectedLines * bonusKnown;
  const primaryCost = primaryUnknown ? null : primaryKnown;
  const bonusCost = expectedLines > 0 && bonusUnknown ? null : bonusTotalKnown;
  const total = primaryCost !== null && bonusCost !== null ? primaryCost + bonusCost : null;
  const lowerBound = primaryKnown + bonusTotalKnown;
  return {
    available: config.prizes.filter(bingoEligible).length >= 9, plays: options.plays, expectedLines,
    expectedPrimaryCostCents: primaryCost, expectedBonusCostCents: bonusCost, expectedTotalCostCents: total,
    expectedKnownCostCents: lowerBound, unknownCostPrizes: unknown.size,
    priceBelowExpectedCost: options.priceCents === undefined ? null : options.priceCents < lowerBound ? true : total === null ? null : options.priceCents < total,
    assumesUnchangedPool: true, representativeCard: !before || before.markedMask === BINGO_FULL_MASK || options.plays > 1,
  };
}
