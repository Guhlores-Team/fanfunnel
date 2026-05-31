// Lightweight test runner (no test framework needed). Run with:
//   npx tsx src/lib/games/wheel/engine.test.ts
import { pickPrize, prizeOdds, availablePrizes, pickPrizeWithPity, PITY_THRESHOLD, applyRareBoost } from "./engine";
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

// ---------------------------------------------------------------------------
// Pity system
// ---------------------------------------------------------------------------

// 6. Pity fires at threshold: returns rare-or-better and resets counter to 0.
{
  // pityCounter+1 === PITY_THRESHOLD triggers the forced pick. With unlimited
  // rare-or-better stock, the only candidates are 'b' (rare) and 'c' (legendary).
  const unlimited: WheelConfig = {
    ...config,
    prizes: config.prizes.map((p) => ({ ...p, stock: null })),
  };
  const res = pickPrizeWithPity(unlimited, { pityCounter: PITY_THRESHOLD - 1 }, () => 0);
  assert(res.pityAwarded === true, "pity fires at threshold (pityAwarded)");
  assert(["rare", "epic", "legendary"].includes(res.prize.rarity), "pity awards rare-or-better");
  assert(res.nextPityCounter === 0, "pity resets nextPityCounter to 0");
  assert(unlimited.prizes[res.index].id === res.prize.id, "pity index matches prize");
}

// 7. Below threshold: normal pick, and a non-rare result increments the counter.
{
  // rng=0 lands on the first prize 'a' (common) — not rare, so counter climbs.
  const res = pickPrizeWithPity(config, { pityCounter: 3 }, () => 0);
  assert(res.pityAwarded === false, "below threshold is not a pity award");
  assert(res.prize.id === "a", "below threshold uses normal weighted pick");
  assert(res.nextPityCounter === 4, "non-rare below threshold increments counter");
}

// 8. Hitting a rare normally (below threshold) resets the counter.
{
  // A two-prize wheel where rng=0 lands on the rare prize.
  const rareFirst: WheelConfig = {
    id: "rare-first",
    title: "Rare First",
    prizes: [
      { id: "r", label: "Rare", rarity: "rare", weight: 50 },
      { id: "c", label: "Common", rarity: "common", weight: 50 },
    ],
  };
  const res = pickPrizeWithPity(rareFirst, { pityCounter: 5 }, () => 0);
  assert(res.pityAwarded === false, "natural rare is not a pity award");
  assert(res.prize.rarity === "rare", "natural rare hit below threshold");
  assert(res.nextPityCounter === 0, "natural rare resets counter");
}

// 9. Pity with NO rare-or-better in stock falls back without throwing.
{
  // Both rare ('b') and legendary ('c') are sold out → only common remains.
  const noRare: WheelConfig = {
    ...config,
    prizes: config.prizes.map((p) =>
      p.rarity === "common" ? { ...p, stock: null } : { ...p, stock: 0 }
    ),
  };
  let threw = false;
  let res;
  try {
    res = pickPrizeWithPity(noRare, { pityCounter: PITY_THRESHOLD - 1 }, () => 0);
  } catch {
    threw = true;
  }
  assert(!threw, "pity with no rare in stock does not throw");
  assert(res !== undefined && res.pityAwarded === false, "no-rare pity is not awarded");
  assert(res !== undefined && res.prize.rarity === "common", "no-rare pity falls back to common");
  assert(res !== undefined && res.nextPityCounter === PITY_THRESHOLD, "no-rare pity keeps climbing");
}

// 10. Determinism: a seeded rng yields identical results across runs.
{
  // Simple LCG seeded rng so the sequence is reproducible.
  function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const runA: string[] = [];
  const runB: string[] = [];
  const rngA = seeded(42);
  const rngB = seeded(42);
  let counterA = 0;
  let counterB = 0;
  for (let i = 0; i < 50; i++) {
    const a = pickPrizeWithPity(config, { pityCounter: counterA }, rngA);
    const b = pickPrizeWithPity(config, { pityCounter: counterB }, rngB);
    runA.push(`${a.prize.id}:${a.nextPityCounter}:${a.pityAwarded}`);
    runB.push(`${b.prize.id}:${b.nextPityCounter}:${b.pityAwarded}`);
    counterA = a.nextPityCounter;
    counterB = b.nextPityCounter;
  }
  assert(JSON.stringify(runA) === JSON.stringify(runB), "seeded rng is deterministic");
}

// ---------------------------------------------------------------------------
// applyRareBoost — happy-hour rare boost
// ---------------------------------------------------------------------------
{
  const boostCfg: WheelConfig = {
    id: "boost",
    title: "Boost Wheel",
    prizes: [
      { id: "p1", label: "Common", rarity: "common", weight: 90 },
      { id: "p2", label: "Uncommon", rarity: "uncommon", weight: 40 },
      { id: "p3", label: "Rare", rarity: "rare", weight: 9, stock: 5 },
      { id: "p4", label: "Epic", rarity: "epic", weight: 3, stock: 2 },
      { id: "p5", label: "Legendary", rarity: "legendary", weight: 1, stock: 1 },
    ],
  };

  // 11. rare/epic/legendary weights scale by the multiplier and round.
  {
    const boosted = applyRareBoost(boostCfg, 2.5);
    const by = (id: string) => boosted.prizes.find((p) => p.id === id)!;
    assert(by("p3").weight === Math.round(9 * 2.5), `rare weight scales (got ${by("p3").weight})`);
    assert(by("p4").weight === Math.round(3 * 2.5), `epic weight scales (got ${by("p4").weight})`);
    assert(by("p5").weight === Math.max(1, Math.round(1 * 2.5)), `legendary weight scales (got ${by("p5").weight})`);
  }

  // 12. common/uncommon weights untouched.
  {
    const boosted = applyRareBoost(boostCfg, 3);
    const by = (id: string) => boosted.prizes.find((p) => p.id === id)!;
    assert(by("p1").weight === 90, "common weight untouched");
    assert(by("p2").weight === 40, "uncommon weight untouched");
  }

  // 13. prize ids/stock preserved.
  {
    const boosted = applyRareBoost(boostCfg, 4);
    const by = (id: string) => boosted.prizes.find((p) => p.id === id)!;
    assert(boosted.prizes.map((p) => p.id).join(",") === "p1,p2,p3,p4,p5", "prize ids preserved + ordered");
    assert(by("p3").stock === 5, "rare stock preserved");
    assert(by("p4").stock === 2, "epic stock preserved");
    assert(by("p5").stock === 1, "legendary stock preserved");
  }

  // 14. multiplier <= 1 (and non-finite) is a no-op.
  {
    for (const m of [1, 0.5, 0, -2, NaN, Infinity]) {
      const out = applyRareBoost(boostCfg, m);
      const same = out.prizes.every((p, i) => p.weight === boostCfg.prizes[i].weight);
      assert(same, `multiplier ${m} is a no-op`);
    }
  }

  // 15. input config is not mutated.
  {
    const before = JSON.stringify(boostCfg);
    const out = applyRareBoost(boostCfg, 5);
    assert(JSON.stringify(boostCfg) === before, "input config not mutated");
    assert(out !== boostCfg, "returns a new config object");
    assert(out.prizes !== boostCfg.prizes, "returns a new prizes array");
    assert(out.prizes[2] !== boostCfg.prizes[2], "boosted prize is a clone");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
