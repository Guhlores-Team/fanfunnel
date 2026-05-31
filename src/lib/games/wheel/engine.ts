import type { Prize, WheelConfig } from "./types";
import { RARITY_ORDER } from "./types";

// ---------------------------------------------------------------------------
// Pure, deterministic-testable engine. NO React, NO database, NO randomness
// baked in at the edges so it can be unit-tested and reused everywhere.
//
// SECURITY: prize selection must always happen on the SERVER. The fan's
// browser only animates the wheel to the index the server returned. Never
// trust a client-reported outcome.
// ---------------------------------------------------------------------------

/** A prize is spinnable if it isn't sold out. */
export function isAvailable(prize: Prize): boolean {
  return prize.stock === null || prize.stock === undefined || prize.stock > 0;
}

export function availablePrizes(config: WheelConfig): Prize[] {
  return config.prizes.filter(isAvailable);
}

/**
 * Pick a weighted-random prize from the in-stock prizes.
 *
 * @param rng - returns a float in [0, 1). Defaults to Math.random.
 *              Injectable so tests (and seeded replays) are deterministic.
 * @returns the chosen prize and its index within `config.prizes`.
 * @throws if there are no available prizes (a wheel must always be able to pay
 *         out — that "every spin wins" guarantee is what keeps this out of
 *         gambling-law territory).
 */
export function pickPrize(
  config: WheelConfig,
  rng: () => number = Math.random
): { prize: Prize; index: number } {
  const pool = availablePrizes(config);
  if (pool.length === 0) {
    throw new Error(
      `Wheel "${config.id}" has no available prizes — every spin must win something.`
    );
  }

  const totalWeight = pool.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  if (totalWeight <= 0) {
    // Defensive fallback: if all weights are zero, treat as uniform.
    const idx = Math.floor(rng() * pool.length);
    const prize = pool[Math.min(idx, pool.length - 1)];
    return { prize, index: config.prizes.indexOf(prize) };
  }

  let roll = rng() * totalWeight;
  for (const prize of pool) {
    roll -= Math.max(0, prize.weight);
    if (roll < 0) {
      return { prize, index: config.prizes.indexOf(prize) };
    }
  }

  // Floating-point safety net: return the last available prize.
  const last = pool[pool.length - 1];
  return { prize: last, index: config.prizes.indexOf(last) };
}

// ---------------------------------------------------------------------------
// Pity system — guarantees a "rare or better" payout when a fan has gone too
// long without one. The counter is tracked per-fan on the server; this engine
// only computes the outcome and the next counter value.
// ---------------------------------------------------------------------------

/** Spins-without-a-rare after which the next spin is forced rare-or-better. */
export const PITY_THRESHOLD = 10;

/** A prize is "rare or better" if its rarity is rare/epic/legendary. */
function isRareOrBetter(prize: Prize): boolean {
  return RARITY_ORDER.indexOf(prize.rarity) >= RARITY_ORDER.indexOf("rare");
}

/**
 * Weighted-pick across an arbitrary in-stock pool, mirroring `pickPrize`'s
 * selection logic but over a caller-supplied subset. Returns the prize and its
 * index within `config.prizes`. Caller guarantees `pool.length > 0`.
 */
function weightedPickFromPool(
  config: WheelConfig,
  pool: Prize[],
  rng: () => number
): { prize: Prize; index: number } {
  const totalWeight = pool.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
  if (totalWeight <= 0) {
    const idx = Math.floor(rng() * pool.length);
    const prize = pool[Math.min(idx, pool.length - 1)];
    return { prize, index: config.prizes.indexOf(prize) };
  }

  let roll = rng() * totalWeight;
  for (const prize of pool) {
    roll -= Math.max(0, prize.weight);
    if (roll < 0) {
      return { prize, index: config.prizes.indexOf(prize) };
    }
  }

  const last = pool[pool.length - 1];
  return { prize: last, index: config.prizes.indexOf(last) };
}

/**
 * Pick a prize, honouring the pity system.
 *
 * When `pityCounter + 1` reaches `pityThreshold` the spin is forced to a
 * weighted in-stock "rare or better" prize (resetting the counter). If no such
 * prize is in stock we fall back to a normal pick — never throwing — and the
 * counter keeps climbing. Otherwise a normal weighted pick happens; landing a
 * rare-or-better resets the counter, anything else increments it.
 *
 * @param rng - float in [0, 1). Injectable for deterministic tests/replays.
 */
export function pickPrizeWithPity(
  config: WheelConfig,
  opts: { pityCounter: number; pityThreshold?: number },
  rng: () => number = Math.random
): { prize: Prize; index: number; pityAwarded: boolean; nextPityCounter: number } {
  const pityThreshold = opts.pityThreshold ?? PITY_THRESHOLD;
  const pityCounter = opts.pityCounter;

  if (pityCounter + 1 >= pityThreshold) {
    const rarePool = availablePrizes(config).filter(isRareOrBetter);
    if (rarePool.length > 0) {
      const { prize, index } = weightedPickFromPool(config, rarePool, rng);
      return { prize, index, pityAwarded: true, nextPityCounter: 0 };
    }
    // No rare-or-better in stock: fall back to a normal pick, keep climbing.
    const fallback = pickPrize(config, rng);
    return {
      prize: fallback.prize,
      index: fallback.index,
      pityAwarded: false,
      nextPityCounter: pityCounter + 1,
    };
  }

  const { prize, index } = pickPrize(config, rng);
  const nextPityCounter = isRareOrBetter(prize) ? 0 : pityCounter + 1;
  return { prize, index, pityAwarded: false, nextPityCounter };
}

/**
 * The real, displayed odds for each prize given current stock. Useful for the
 * creator dashboard ("this prize hits ~3% of the time") and for transparency.
 */
export function prizeOdds(config: WheelConfig): Map<string, number> {
  const pool = availablePrizes(config);
  const total = pool.reduce((s, p) => s + Math.max(0, p.weight), 0);
  const odds = new Map<string, number>();
  for (const p of config.prizes) {
    odds.set(p.id, total > 0 && isAvailable(p) ? Math.max(0, p.weight) / total : 0);
  }
  return odds;
}
