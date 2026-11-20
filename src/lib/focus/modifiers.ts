import { availablePrizes, isAvailable, pickPrizeWithPity, PITY_THRESHOLD } from "@/lib/games/wheel/engine";
import { RARITY_ORDER, type Prize, type WheelConfig } from "@/lib/games/wheel/types";
import { FOCUS_PAUSE_WITHOUT_ODDS_INCREASE, isFocusLength, isFocusMultiplier, MAX_COMBINED_BOOST } from "./config";

export interface FocusInput {
  prizeId: string;
  multiplier: number;
  spinsLeft: number;
  totalSpins: number;
}

export interface ChaseInput {
  prizeId: string;
  counter: number;
  within: number;
  /** A real held stock/code unit, validated by the commit transaction. */
  reserved: boolean;
}

export type FocusPauseReason = "sold_out" | "other_wheel" | "no_increase" | "pity";
export interface FocusProof extends FocusInput {
  /** Actual total multiplier from the base tickets, including happy hour. */
  effectiveMultiplier: number;
  applied: boolean;
  pauseReason: FocusPauseReason | null;
}

export interface ChaseProof extends ChaseInput {
  eligible: boolean;
  pauseReason: "sold_out" | "other_wheel" | null;
}

export interface ModifierOptions {
  happyHourMultiplier: number | null;
  pityCounter: number;
  pityThreshold?: number;
  focus?: FocusInput | null;
  chase?: ChaseInput | null;
}

export interface EffectiveDrawOptions {
  pityCounter: number;
  pityThreshold?: number;
  focus: FocusProof | null;
  chase: ChaseProof | null;
}

export interface ModifierDraw {
  prize: Prize;
  index: number;
  pityAwarded: boolean;
  nextPityCounter: number;
  /** True only when the due guarantee forced the target. */
  chaseAwarded: boolean;
  /** True on either an early natural win or the due guaranteed win. */
  chaseCompleted: boolean;
  focusConsumed: boolean;
  chaseConsumed: boolean;
  nextFocusSpinsLeft: number | null;
  nextChaseCounter: number | null;
}

export const isRarePrize = (prize: Pick<Prize, "rarity">) =>
  RARITY_ORDER.indexOf(prize.rarity) >= RARITY_ORDER.indexOf("rare");

const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function cappedHappyHour(multiplier: number | null): number | null {
  if (multiplier === null) return null;
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new RangeError("Invalid happy-hour multiplier");
  return Math.min(multiplier, MAX_COMBINED_BOOST);
}

/** Compose from the original tickets ONCE; zero tickets never become positive. */
export function boostedWeight(base: number, multiplier: number): number {
  if (!count(base) || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > MAX_COMBINED_BOOST) {
    throw new RangeError("Invalid base tickets or multiplier");
  }
  const weight = base === 0 ? 0 : Math.max(1, Math.round(base * multiplier));
  if (!Number.isSafeInteger(weight)) throw new RangeError("Effective tickets exceed the safe integer range");
  return weight;
}

function validateOptions(options: ModifierOptions) {
  if (!count(options.pityCounter) || !Number.isSafeInteger(options.pityThreshold ?? PITY_THRESHOLD) || (options.pityThreshold ?? PITY_THRESHOLD) < 1) {
    throw new RangeError("Invalid pity state");
  }
  if (options.focus && options.chase) throw new RangeError("Only one focus or chase may be active");
  const f = options.focus;
  if (f && (!f.prizeId || !isFocusMultiplier(f.multiplier) || !isFocusLength(f.totalSpins) || !count(f.spinsLeft) || f.spinsLeft < 1 || f.spinsLeft > f.totalSpins)) {
    throw new RangeError("Invalid focus state");
  }
  const c = options.chase;
  if (c && (!c.prizeId || !isFocusLength(c.within) || !count(c.counter) || c.counter >= c.within || typeof c.reserved !== "boolean")) {
    throw new RangeError("Invalid chase state");
  }
}

/** Actual first-draw probabilities, including both guarantees and zero-ticket fallback. */
export function effectiveOdds(config: WheelConfig, options: EffectiveDrawOptions): {
  pityForced: boolean;
  chaseForced: boolean;
  rows: { prize: Prize; chance: number }[];
} {
  const available = availablePrizes(config);
  const chase = options.chase;
  const target = chase?.eligible ? available.find((p) => p.id === chase.prizeId) : null;
  if (chase?.eligible && !target) throw new Error("An eligible chase cannot exclude its target");
  const chaseForced = !!chase?.eligible && chase.counter + 1 >= chase.within;
  const rare = available.filter(isRarePrize);
  const pityForced = !chaseForced && options.pityCounter + 1 >= (options.pityThreshold ?? PITY_THRESHOLD) && rare.length > 0;
  const pool = chaseForced ? [target!] : pityForced ? rare : available;
  const total = pool.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  const ids = new Set(pool.map((p) => p.id));
  return {
    pityForced,
    chaseForced,
    rows: config.prizes.map((prize) => ({
      prize,
      chance: !ids.has(prize.id) ? 0 : total > 0 ? Math.max(0, prize.weight) / total : 1 / pool.length,
    })),
  };
}

export function composeModifiers(config: WheelConfig, options: ModifierOptions): {
  config: WheelConfig;
  happyHour: { multiplier: number } | null;
  focus: FocusProof | null;
  chase: ChaseProof | null;
} {
  validateOptions(options);
  const hh = cappedHappyHour(options.happyHourMultiplier);
  const factor = (prize: Prize) => isRarePrize(prize) ? hh ?? 1 : 1;
  const baseline: WheelConfig = {
    ...config,
    prizes: config.prizes.map((p) => ({ ...p, weight: boostedWeight(p.weight, factor(p)) })),
  };
  let effective = baseline;
  let focus: FocusProof | null = null;
  let chase: ChaseProof | null = null;
  if (options.focus) {
    const input = options.focus;
    const target = config.prizes.find((p) => p.id === input.prizeId);
    let reason: FocusPauseReason | null = !target ? "other_wheel" : !isAvailable(target) ? "sold_out" : null;
    const multiplier = target ? factor(target) : 1;
    const combined = Math.min(multiplier * input.multiplier, MAX_COMBINED_BOOST);
    const candidate: WheelConfig = {
      ...baseline,
      prizes: baseline.prizes.map((p) => p.id === input.prizeId ? { ...p, weight: boostedWeight(target!.weight, combined) } : p),
    };
    if (!reason && FOCUS_PAUSE_WITHOUT_ODDS_INCREASE) {
      const state = { pityCounter: options.pityCounter, pityThreshold: options.pityThreshold, focus: null, chase: null };
      const before = effectiveOdds(baseline, state);
      const after = effectiveOdds(candidate, state);
      if (!(after.rows.find((r) => r.prize.id === input.prizeId)!.chance > before.rows.find((r) => r.prize.id === input.prizeId)!.chance)) {
        reason = before.pityForced && !isRarePrize(target!) ? "pity" : "no_increase";
      }
    }
    if (!reason) effective = candidate;
    focus = {
      prizeId: input.prizeId, multiplier: input.multiplier, spinsLeft: input.spinsLeft, totalSpins: input.totalSpins,
      effectiveMultiplier: reason ? multiplier : combined, applied: reason === null, pauseReason: reason,
    };
  }
  if (options.chase) {
    const input = options.chase;
    const target = config.prizes.find((p) => p.id === input.prizeId);
    if (target && target.stock != null && !input.reserved) throw new Error("A finite chase requires a reserved unit");
    const reason = !target ? "other_wheel" : !isAvailable(target) && !input.reserved ? "sold_out" : null;
    if (target && input.reserved) {
      effective = { ...effective, prizes: effective.prizes.map((p) => p.id === target.id ? { ...p, stock: null } : p) };
    }
    chase = { prizeId: input.prizeId, counter: input.counter, within: input.within, reserved: input.reserved, eligible: reason === null, pauseReason: reason };
  }
  return { config: effective, happyHour: hh === null ? null : { multiplier: hh }, focus, chase };
}

/** Draw already-effective tickets; shared by the server and public replay. */
export function pickEffectivePrize(config: WheelConfig, options: EffectiveDrawOptions, rng: () => number): ModifierDraw {
  const odds = effectiveOdds(config, options);
  const chase = options.chase;
  const forced = odds.chaseForced ? config.prizes.find((p) => p.id === chase!.prizeId)! : null;
  const pick = forced
    ? { prize: forced, index: config.prizes.indexOf(forced), pityAwarded: false, nextPityCounter: isRarePrize(forced) ? 0 : options.pityCounter + 1 }
    : pickPrizeWithPity(config, { pityCounter: options.pityCounter, pityThreshold: options.pityThreshold }, rng);
  const focusedChance = options.focus ? odds.rows.find((row) => row.prize.id === options.focus!.prizeId)?.chance ?? 0 : 0;
  // A stock re-draw may remove the target or leave it as the only possible
  // prize. In either case this spin no longer gains anything from its focus.
  const focusConsumed = options.focus?.applied === true && focusedChance > 0 && focusedChance < 1;
  const chaseConsumed = chase?.eligible === true;
  return {
    ...pick,
    chaseAwarded: odds.chaseForced,
    chaseCompleted: chaseConsumed && pick.prize.id === chase!.prizeId,
    focusConsumed,
    chaseConsumed,
    nextFocusSpinsLeft: options.focus ? options.focus.spinsLeft - (focusConsumed ? 1 : 0) : null,
    nextChaseCounter: chase ? chase.counter + (chaseConsumed ? 1 : 0) : null,
  };
}

export function pickWithModifiers(config: WheelConfig, options: ModifierOptions, rng: () => number): ModifierDraw {
  const effective = composeModifiers(config, options);
  return pickEffectivePrize(effective.config, {
    pityCounter: options.pityCounter, pityThreshold: options.pityThreshold,
    focus: effective.focus, chase: effective.chase,
  }, rng);
}
