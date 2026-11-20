import assert from "node:assert";
import { heatmapIndex, heatmapStrength, shareOfRevenue, summarizeWins } from "./analyticsHelpers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- summarizeWins -------------------------------------------------------
{
  const empty = summarizeWins([]);
  check("summarizeWins empty → no prizes", empty.topPrizes.length === 0);
  check("summarizeWins empty → no rarity buckets", empty.rarityMix.length === 0);

  const reds = [
    { prizeLabel: "Voice note", rarity: "uncommon" as const, emoji: "💋" },
    { prizeLabel: "Custom video", rarity: "rare" as const, emoji: "🎬" },
    { prizeLabel: "Voice note", rarity: "uncommon" as const, emoji: "💋" },
    { prizeLabel: "Crown", rarity: "legendary" as const },
  ];
  const s = summarizeWins(reds);
  check("summarizeWins sorts by count desc", s.topPrizes[0].label === "Voice note" && s.topPrizes[0].count === 2);
  check("summarizeWins keeps the first emoji", s.topPrizes[0].emoji === "💋");
  check("summarizeWins keeps a missing emoji undefined", s.topPrizes.find((p) => p.label === "Crown")?.emoji === undefined);
  check(
    "summarizeWins rarity mix follows RARITY_ORDER and drops zeros",
    s.rarityMix.map((x) => x.rarity).join(",") === "uncommon,rare,legendary"
  );
  check("summarizeWins rarity counts add up to wins", s.rarityMix.reduce((n, x) => n + x.count, 0) === reds.length);

  const many = Array.from({ length: 9 }, (_, i) => ({ prizeLabel: `P${i}`, rarity: "common" as const }));
  check("summarizeWins caps the top list at 6", summarizeWins(many).topPrizes.length === 6);
}

// --- heatmapIndex / heatmapStrength --------------------------------------
{
  const idx = heatmapIndex({ cells: [{ weekday: 1, hour: 9, count: 4 }, { weekday: 6, hour: 23, count: 1 }], max: 4 });
  check("heatmapIndex keys weekday*24+hour", idx.get(1 * 24 + 9) === 4 && idx.get(6 * 24 + 23) === 1);
  check("heatmapIndex null-safe", heatmapIndex(null).size === 0);

  check("heatmapStrength empty cell is 0", heatmapStrength(0, 10) === 0);
  check("heatmapStrength no data is 0", heatmapStrength(3, 0) === 0);
  check("heatmapStrength busiest hour is 100", heatmapStrength(10, 10) === 100);
  check("heatmapStrength a single spin stays visible", heatmapStrength(1, 1000) >= 15);
}

// --- shareOfRevenue -------------------------------------------------------
{
  check("shareOfRevenue rounds to whole %", shareOfRevenue(1234, 10000) === "12%");
  check("shareOfRevenue no revenue → dash", shareOfRevenue(500, 0) === "—");
  check("shareOfRevenue missing profit → dash", shareOfRevenue(500, null) === "—");
}

console.log(`analyticsHelpers: ${passed} checks passed`);
