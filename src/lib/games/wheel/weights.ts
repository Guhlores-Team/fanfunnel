// Prize weights are stored in int4 columns (prizes / prize_templates.weight).
// These helpers keep a positive weight positive when it becomes an integer: a
// 0-weight prize can never be won, so silently storing 0 loses the prize.

const PG_INT4_MAX = 2147483647;

/** Fixed total that Balance odds spreads across a wheel's prizes. */
export const BALANCED_WEIGHT_TOTAL = 1000;

/** The integer a weight column stores: rounded, at least 1 when positive,
 *  0 for zero/negative/non-finite, capped at int4 max. */
export function storedWeight(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.min(PG_INT4_MAX, Math.max(1, Math.round(w)));
}

/**
 * Turn fractional weights into integers summing to `total`, keeping the ratios
 * within rounding (largest remainder) and every entry ≥ 1. An all-zero input
 * splits evenly. Assumes `total` ≥ the number of weights.
 */
export function toIntegerWeights(raw: number[], total = BALANCED_WEIGHT_TOTAL): number[] {
  const n = raw.length;
  if (n === 0) return [];
  const clean = raw.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((s, w) => s + w, 0);
  const exact = clean.map((w) => (sum > 0 ? (w / sum) * total : total / n));

  const out = exact.map(Math.floor);
  let left = total - out.reduce((s, w) => s + w, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[byRemainder[k].i]++;

  // Lift any 0 to 1, taking the ticket from the current largest weight.
  for (let i = 0; i < n; i++) {
    if (out[i] >= 1) continue;
    let max = 0;
    for (let j = 1; j < n; j++) if (out[j] > out[max]) max = j;
    if (out[max] <= 1) break;
    out[max]--;
    out[i] = 1;
  }
  return out;
}
