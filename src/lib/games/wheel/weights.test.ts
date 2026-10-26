import assert from "node:assert";
import { storedWeight, toIntegerWeights, BALANCED_WEIGHT_TOTAL } from "./weights";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- storedWeight: what an int4 weight column receives ---------------------
{
  check("0.5 rounds up to 1, never 0", storedWeight(0.5) === 1);
  check("tiny positive floors at 1", storedWeight(0.0001) === 1);
  check("2.4 rounds to 2", storedWeight(2.4) === 2);
  check("2.5 rounds to 3", storedWeight(2.5) === 3);
  check("integers unchanged", storedWeight(50) === 50);
  check("0 stays 0", storedWeight(0) === 0);
  check("negative → 0", storedWeight(-3) === 0);
  check("NaN → 0", storedWeight(NaN) === 0);
  check("Infinity → 0", storedWeight(Infinity) === 0);
  check("huge clamps to int4 max", storedWeight(1e12) === 2147483647);
}

// --- toIntegerWeights: largest-remainder to a fixed total ------------------
{
  const raw = [3.75, 1.25, 3, 1];
  const out = toIntegerWeights(raw);
  check("same length", out.length === raw.length);
  check("all integers", out.every(Number.isInteger));
  check("every positive input ≥ 1", out.every((w) => w >= 1));
  check("sums to the fixed total", out.reduce((s, w) => s + w, 0) === BALANCED_WEIGHT_TOTAL);
  const rawSum = raw.reduce((s, w) => s + w, 0);
  check(
    "each share within one ticket of exact",
    out.every((w, i) => Math.abs(w - (raw[i] / rawSum) * BALANCED_WEIGHT_TOTAL) < 1),
  );

  const halves = toIntegerWeights([5, 0.5, 0.5]);
  check("0.5 shares stay positive and equal", halves[1] >= 1 && halves[1] === halves[2]);

  const skewed = toIntegerWeights([1000, 0.001]);
  check("near-zero share is bumped to 1", skewed[1] === 1);
  check("bump keeps the fixed total", skewed[0] + skewed[1] === BALANCED_WEIGHT_TOTAL);

  const zeros = toIntegerWeights([0, 0]);
  check("all-zero input → even split, all ≥ 1", zeros.every((w) => w >= 1) && zeros[0] === zeros[1]);

  const many = toIntegerWeights(Array.from({ length: 50 }, (_, i) => (i === 0 ? 1e6 : 1)));
  check("50 prizes: all ≥ 1", many.every((w) => w >= 1));
  check("50 prizes: fixed total", many.reduce((s, w) => s + w, 0) === BALANCED_WEIGHT_TOTAL);

  const input = [1.5, 2.5];
  toIntegerWeights(input);
  check("input not mutated", input[0] === 1.5 && input[1] === 2.5);
}

console.log(`weights: ${passed} checks passed`);
