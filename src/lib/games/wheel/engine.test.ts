// Lightweight test runner (no test framework needed). Run with:
//   npx tsx src/lib/games/wheel/engine.test.ts
import { pickPrize, prizeOdds, availablePrizes } from "./engine";
import type { WheelConfig } from "./types";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ " + msg);
  }
}

const config: WheelConfig = {
  id: "test",
  title: "Test Wheel",
  prizes: [
    { id: "a", label: "Common", rarity: "common", weight: 90 },
    { id: "b", label: "Rare", rarity: "rare", weight: 9 },
    { id: "c", label: "Legendary", rarity: "legendary", weight: 1, stock: 1 },
  ],
};

// 1. Weighted distribution is roughly correct over many spins.
{
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  // Use a config with unlimited legendary stock to measure raw weights.
  const unlimited: WheelConfig = {
    ...config,
    prizes: config.prizes.map((p) => ({ ...p, stock: null })),
  };
  const N = 100_000;
  for (let i = 0; i < N; i++) {
    counts[pickPrize(unlimited).prize.id]++;
  }
  assert(Math.abs(counts.a / N - 0.9) < 0.02, `common ~90% (got ${(counts.a / N * 100).toFixed(1)}%)`);
  assert(Math.abs(counts.b / N - 0.09) < 0.02, `rare ~9% (got ${(counts.b / N * 100).toFixed(1)}%)`);
}

// 2. Sold-out prizes are excluded.
{
  const soldOut: WheelConfig = {
    ...config,
    prizes: config.prizes.map((p) => (p.id === "c" ? { ...p, stock: 0 } : p)),
  };
  assert(availablePrizes(soldOut).length === 2, "sold-out prize excluded from pool");
  for (let i = 0; i < 1000; i++) {
    assert(pickPrize(soldOut).prize.id !== "c", "never picks a sold-out prize");
  }
}

// 3. A deterministic rng lands predictably.
{
  // rng=0 -> first prize; rng just below 1 -> last available prize.
  assert(pickPrize(config, () => 0).prize.id === "a", "rng=0 picks first prize");
  assert(pickPrize(config, () => 0.999999).prize.id === "c", "rng~1 picks last prize");
}

// 4. Odds sum to ~1 across available prizes.
{
  const odds = prizeOdds(config);
  const sum = [...odds.values()].reduce((s, v) => s + v, 0);
  assert(Math.abs(sum - 1) < 1e-9, "odds sum to 1");
}

// 5. Empty wheel throws (every spin must win).
{
  let threw = false;
  try {
    pickPrize({ id: "x", title: "x", prizes: [] });
  } catch {
    threw = true;
  }
  assert(threw, "empty wheel throws");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
