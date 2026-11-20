import type { PublicPrize } from "./types";
import { isPublicPrizeAvailable } from "./publicView";

/** One prize's base chance on a new play, for the public page (T12). */
export interface PublicOddsRow {
  label: string;
  /** 0..1; a sold-out or zero-weight prize is 0. */
  chance: number;
}

/**
 * T12: the base odds of a new play from the fan-safe prize list: each prize's
 * weight over the total weight of prizes still available. Personal boosts
 * (Focus, Chase, the rare-prize guarantee) are not included; the spin page and
 * the verify page show the exact odds a spin used.
 */
export function publicBaseOdds(prizes: Pick<PublicPrize, "label" | "weight" | "stock" | "soldOut">[]): PublicOddsRow[] {
  const weight = (p: (typeof prizes)[number]) =>
    isPublicPrizeAvailable(p) && Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0;
  const total = prizes.reduce((sum, p) => sum + weight(p), 0);
  return prizes
    .map((p) => ({ label: p.label, chance: total > 0 ? weight(p) / total : 0 }))
    .sort((a, b) => b.chance - a.chance);
}

/** "12.5%" with at most three decimals; a real but tiny chance never reads as 0%. */
export function formatChance(chance: number): string {
  if (!(chance > 0)) return "0%";
  const pct = chance * 100;
  if (pct < 0.001) return "<0.001%";
  return `${Number(pct.toFixed(3)).toString()}%`;
}

/**
 * WF-13 / RF-09: the chance as a fan reads it. One decimal at most for
 * everyday odds ("40.4%", "5%"), two significant decimals below 1%, and a
 * floor instead of "0%" for a real but tiny chance. The exact table stays on
 * the verify page.
 */
export function formatFanChance(chance: number): string {
  if (!(chance > 0)) return "0%";
  const pct = chance * 100;
  if (pct < 0.001) return "<0.001%";
  if (pct < 0.1) return `${Number(pct.toPrecision(2))}%`;
  if (pct < 1) return `${Number(pct.toFixed(2))}%`;
  return `${Number(pct.toFixed(1))}%`;
}

