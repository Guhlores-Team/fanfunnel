import { type Prize, RARITY_ORDER } from "@/lib/games/wheel/types";

// Pure (no React) helpers for the wheel editor. Kept framework-agnostic and
// deterministic so they can be unit-tested in isolation.

/** Curated emoji palette offered as quick-pick suggestions in the editor. */
export const EMOJI_SUGGESTIONS: string[] = [
  // Originals
  "🎁",
  "🤳",
  "🎙️",
  "📣",
  "🎬",
  "📞",
  "📸",
  "👑",
  "💋",
  "💎",
  "🔥",
  "⭐",
  // Faces / people
  "😍",
  "😘",
  "🥰",
  "😈",
  // Hearts
  "💖",
  "💕",
  "❤️‍🔥",
  // Money
  "💰",
  "💵",
  "🤑",
  // Media
  "🎥",
  "📺",
  "🎧",
  // Gifts / treats
  "🍫",
  "🌹",
  "🎀",
  "🥂",
  // Sparkle / fun
  "🎉",
  "✨",
  "🌟",
  "💫",
];

/**
 * Immutable array move. Returns a new array with the item at `from` relocated
 * to `to`. Indices are clamped into range; the input is never mutated.
 */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  if (next.length === 0) return next;
  const clamp = (n: number) => Math.max(0, Math.min(next.length - 1, n));
  const f = clamp(from);
  const t = clamp(to);
  const [moved] = next.splice(f, 1);
  next.splice(t, 0, moved);
  return next;
}

/** A fresh blank prize with a short random id. */
export function newPrize(): Prize {
  return {
    id: "p" + Math.random().toString(36).slice(2, 8),
    label: "New prize",
    rarity: "common",
    weight: 10,
    emoji: "🎁",
  };
}

/** Deep-copy a prize, giving it a fresh id and a " copy" label suffix. */
export function duplicatePrize(p: Prize): Prize {
  const clone = structuredClone(p);
  clone.id = "p" + Math.random().toString(36).slice(2, 8);
  clone.label = p.label + " copy";
  return clone;
}

/**
 * Redistribute weights so each RARITY TIER's total weight follows a descending
 * curve by rarity index (common highest → legendary lowest), while preserving
 * each prize's relative share WITHIN its tier.
 *
 * Rule (deterministic):
 *  - Each tier index i in RARITY_ORDER (0 = common .. 4 = legendary) is assigned
 *    a target total of `RARITY_ORDER.length - i` (so common=5, uncommon=4, ...,
 *    legendary=1). Only tiers that actually contain prizes participate.
 *  - Within a tier, the target total is split proportionally to each prize's
 *    existing weight. If every prize in a tier has weight 0 (no signal), the
 *    total is split evenly so we never produce all-zero weights.
 *  - Length and order are preserved; each returned prize keeps all other fields.
 */
export function balanceOdds(prizes: Prize[]): Prize[] {
  // Group prize indices by rarity tier.
  const byTier = new Map<string, number[]>();
  for (let i = 0; i < prizes.length; i++) {
    const r = prizes[i].rarity;
    const arr = byTier.get(r);
    if (arr) arr.push(i);
    else byTier.set(r, [i]);
  }

  const weights = prizes.map((p) => p.weight);

  for (let tierIdx = 0; tierIdx < RARITY_ORDER.length; tierIdx++) {
    const rarity = RARITY_ORDER[tierIdx];
    const idxs = byTier.get(rarity);
    if (!idxs || idxs.length === 0) continue;

    const tierTotal = RARITY_ORDER.length - tierIdx; // common highest .. legendary lowest
    const existingSum = idxs.reduce((s, i) => s + Math.max(0, prizes[i].weight), 0);

    for (const i of idxs) {
      const share =
        existingSum > 0
          ? (Math.max(0, prizes[i].weight) / existingSum) * tierTotal
          : tierTotal / idxs.length; // even split when no signal — never all-zero
      weights[i] = share;
    }
  }

  return prizes.map((p, i) => ({ ...p, weight: weights[i] }));
}
