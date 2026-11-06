import type { Prize, WheelConfig } from "@/lib/games/wheel/types";
import { isAvailable, PITY_THRESHOLD } from "@/lib/games/wheel/engine";
import { composeModifiers, effectiveOdds, isRarePrize, type ModifierOptions } from "./modifiers";
import { DEFAULT_FOCUS_MULTIPLIER, MAX_FOCUS_SPINS, MIN_FOCUS_SPINS } from "./config";

export interface PackValueOptions {
  kind: "focus" | "chase";
  prizeId: string;
  multiplier?: number;
  /** Number of next spins to estimate, including ordinary spins after a chase. */
  spins: number;
  within?: number;
  happyHourMultiplier?: number | null;
  pityCounter?: number;
  priceCents?: number;
}

export interface PackValueEstimate {
  available: boolean;
  spins: number;
  baseChance: number;
  boostedChance: number;
  expectedTargetWins: number;
  expectedAdditionalTargetWins: number;
  /** Total prizes, not merely the extra target payout. Null if a possible cost is unknown. */
  expectedTotalCostCents: number | null;
  expectedAdditionalCostCents: number | null;
  expectedKnownCostCents: number;
  guaranteedTargetCostCents: number | null;
  priceBelowExpectedCost: boolean | null;
  unknownCostPrizes: number;
  /** Current pool estimate: other fans and later edits can change stock/settings. */
  assumesUnchangedPool: true;
}

type State = { probability: number; pity: number; left: number; counter: number; done: boolean };
type Projection = { targetWins: number; knownCost: number; unknown: Set<string>; firstChance: number };

const knownCost = (prize: Prize) => typeof prize.cost === "number" && Number.isSafeInteger(prize.cost) && prize.cost >= 0 ? prize.cost : null;

/**
 * Exact pity-state expectation for this fixed pool; no sampling or Math.random.
 * Finite inventory is not depleted in this benchmark. The caller must present
 * it as an estimate assuming the current pool, not a promised future payout.
 */
function project(config: WheelConfig, options: PackValueOptions, modified: boolean): Projection {
  const threshold = PITY_THRESHOLD;
  let states: State[] = [{ probability: 1, pity: options.pityCounter ?? 0, left: options.spins, counter: 0, done: false }];
  const out: Projection = { targetWins: 0, knownCost: 0, unknown: new Set(), firstChance: 0 };
  const target = config.prizes.find((p) => p.id === options.prizeId)!;
  for (let step = 0; step < options.spins; step++) {
    const next = new Map<string, State>();
    for (const state of states) {
      const modifier: ModifierOptions = {
        happyHourMultiplier: options.happyHourMultiplier ?? null,
        pityCounter: state.pity,
        focus: modified && options.kind === "focus" && state.left > 0
          ? { prizeId: options.prizeId, multiplier: options.multiplier ?? DEFAULT_FOCUS_MULTIPLIER, spinsLeft: state.left, totalSpins: Math.max(MIN_FOCUS_SPINS, options.spins) }
          : null,
        chase: modified && options.kind === "chase" && !state.done
          ? { prizeId: options.prizeId, counter: state.counter, within: options.within ?? Math.max(MIN_FOCUS_SPINS, options.spins), reserved: target.stock != null }
          : null,
      };
      const composed = composeModifiers(config, modifier);
      const odds = effectiveOdds(composed.config, { pityCounter: state.pity, focus: composed.focus, chase: composed.chase });
      for (const row of odds.rows) {
        if (row.chance <= 0) continue;
        const probability = state.probability * row.chance;
        if (row.prize.id === options.prizeId) {
          out.targetWins += probability;
          if (step === 0) out.firstChance += probability;
        }
        const cost = knownCost(row.prize);
        if (cost === null) out.unknown.add(row.prize.id);
        else out.knownCost += probability * cost;
        const pity = isRarePrize(row.prize) ? 0 : Math.min(threshold, state.pity + 1);
        const chaseConsumed = composed.chase?.eligible === true;
        const done = state.done || (chaseConsumed && row.prize.id === options.prizeId);
        const counter = done ? state.counter : state.counter + (chaseConsumed ? 1 : 0);
        const left = state.left - (composed.focus?.applied ? 1 : 0);
        const key = `${pity}:${left}:${counter}:${Number(done)}`;
        const old = next.get(key);
        if (old) old.probability += probability;
        else next.set(key, { probability, pity, left, counter, done });
      }
    }
    states = [...next.values()];
  }
  return out;
}

/** Creator-only estimate. Cost and price never belong in a public spin proof. */
export function estimatePackValue(config: WheelConfig, options: PackValueOptions): PackValueEstimate {
  if (!Number.isInteger(options.spins) || options.spins < 1 || options.spins > MAX_FOCUS_SPINS) throw new RangeError("Preview spins must be between 1 and 50");
  if (options.priceCents !== undefined && (!Number.isSafeInteger(options.priceCents) || options.priceCents < 0)) throw new RangeError("Invalid pack price");
  const target = config.prizes.find((p) => p.id === options.prizeId);
  const available = !!target && isAvailable(target);
  if (!available) {
    return {
      available: false, spins: options.spins, baseChance: 0, boostedChance: 0, expectedTargetWins: 0, expectedAdditionalTargetWins: 0,
      expectedTotalCostCents: null, expectedAdditionalCostCents: null, expectedKnownCostCents: 0, guaranteedTargetCostCents: null,
      priceBelowExpectedCost: null, unknownCostPrizes: 0, assumesUnchangedPool: true,
    };
  }
  const baseline = project(config, options, false);
  const boosted = project(config, options, true);
  const total = boosted.unknown.size ? null : boosted.knownCost;
  const guaranteed = options.kind === "chase" ? knownCost(target!) : null;
  const lowerBound = Math.max(boosted.knownCost, guaranteed ?? 0);
  return {
    available, spins: options.spins,
    baseChance: baseline.firstChance, boostedChance: boosted.firstChance,
    expectedTargetWins: boosted.targetWins,
    expectedAdditionalTargetWins: boosted.targetWins - baseline.targetWins,
    expectedTotalCostCents: total,
    expectedAdditionalCostCents: total !== null && !baseline.unknown.size ? total - baseline.knownCost : null,
    expectedKnownCostCents: boosted.knownCost,
    guaranteedTargetCostCents: guaranteed,
    priceBelowExpectedCost: options.priceCents === undefined ? null : options.priceCents < lowerBound ? true : total === null ? null : options.priceCents < total,
    unknownCostPrizes: new Set([...baseline.unknown, ...boosted.unknown]).size,
    assumesUnchangedPool: true,
  };
}
