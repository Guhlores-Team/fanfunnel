import type { Prize, Rarity } from "@/lib/games/wheel/types";

/**
 * The high-rarity prize a fan *just* missed, plus which side of the landed
 * slice it sat on (purely cosmetic — drives the slide-in direction).
 *
 * This module is intentionally motion-free so the spin page can compute a
 * near-miss without statically pulling in the (heavy) motion library — the
 * visual NearMissBeat that renders it is dynamically imported.
 */
export interface NearMiss {
  prize: Prize;
  side: "left" | "right";
}

/**
 * Detect a near-miss from the wheel config + the slice the wheel landed on.
 *
 * A near-miss = the landed prize is NOT legendary, but an *adjacent* slice
 * (index ± 1, wrapping) is `legendary` (preferred) or `epic`. We prefer the
 * higher-rarity / closer neighbour so "So close!" always points at the best
 * thing the fan brushed past.
 */
export function detectNearMiss(
  prizes: Prize[],
  landedIndex: number
): NearMiss | null {
  const n = prizes.length;
  if (n < 2) return null;
  const landed = prizes[landedIndex];
  if (!landed || landed.rarity === "legendary") return null;

  const left = prizes[(landedIndex - 1 + n) % n];
  const right = prizes[(landedIndex + 1) % n];

  // Avoid pointing at the landed slice itself when n === 2 (both neighbours
  // resolve to the same other slice — that's still a legit single neighbour).
  const candidates: NearMiss[] = [];
  if (left && left.id !== landed.id) {
    candidates.push({ prize: left, side: "left" });
  }
  if (right && right.id !== landed.id && right.id !== left?.id) {
    candidates.push({ prize: right, side: "right" });
  }

  const rank = (r: Rarity) => (r === "legendary" ? 2 : r === "epic" ? 1 : 0);
  const best = candidates
    .filter((c) => rank(c.prize.rarity) > 0)
    .sort((a, b) => rank(b.prize.rarity) - rank(a.prize.rarity))[0];

  return best ?? null;
}
