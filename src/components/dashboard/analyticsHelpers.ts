import { RARITY_ORDER, type Rarity } from "@/lib/games/wheel/types";
import type { EngagementHeatmap, RedemptionItem } from "@/lib/data/types";

export interface TopPrize {
  label: string;
  count: number;
  emoji?: string;
  rarity: Rarity;
}
export interface RarityCount {
  rarity: Rarity;
  count: number;
}

/**
 * "What's landing" + "Rarity mix": the six most-won prizes (by label) and the
 * per-rarity win counts in rarity order, zero buckets dropped.
 */
export function summarizeWins(reds: Pick<RedemptionItem, "prizeLabel" | "emoji" | "rarity">[]): {
  topPrizes: TopPrize[];
  rarityMix: RarityCount[];
} {
  const prizeMap = new Map<string, TopPrize>();
  const rarity = new Map<Rarity, number>();
  for (const r of reds) {
    const cur = prizeMap.get(r.prizeLabel);
    if (cur) cur.count += 1;
    else prizeMap.set(r.prizeLabel, { label: r.prizeLabel, count: 1, emoji: r.emoji, rarity: r.rarity });
    rarity.set(r.rarity, (rarity.get(r.rarity) ?? 0) + 1);
  }
  return {
    topPrizes: [...prizeMap.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    rarityMix: RARITY_ORDER.map((r) => ({ rarity: r, count: rarity.get(r) ?? 0 })).filter((x) => x.count > 0),
  };
}

/** Heatmap cells keyed by weekday*24+hour for a stable O(1) lookup. */
export function heatmapIndex(heatmap: EngagementHeatmap | null): Map<number, number> {
  const byKey = new Map<number, number>();
  for (const c of heatmap?.cells ?? []) byKey.set(c.weekday * 24 + c.hour, c.count);
  return byKey;
}

/**
 * Fill strength (0..100, as a color-mix %) for a heatmap cell. Empty cells get
 * 0 so they render as the recessed well; any spin gets at least 15% so a single
 * spin is still visible next to the busiest hour.
 */
export function heatmapStrength(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.round(15 + Math.min(1, count / max) * 85);
}

/** A prize's total cost as a whole-percent share of revenue, or "—" with no revenue. */
export function shareOfRevenue(totalCostCents: number, revenueCents: number | null | undefined): string {
  if (!revenueCents || revenueCents <= 0) return "—";
  return `${Math.round((totalCostCents / revenueCents) * 100)}%`;
}
