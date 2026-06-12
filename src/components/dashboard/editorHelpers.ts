import { type Prize, type Rarity, RARITY_ORDER } from "@/lib/games/wheel/types";

// Pure (no React) helpers for the wheel editor. Kept framework-agnostic and
// deterministic so they can be unit-tested in isolation.

/**
 * Default "raffle tickets" (weights) per rarity. Picking a rarity auto-fills
 * these so the creator doesn't have to think in raw numbers. They're relative:
 * the real % is each prize's tickets ÷ all tickets, so this scales to any number
 * of prizes while keeping rarer tiers rarer. Editable per prize after.
 */
export const RARITY_DEFAULT_WEIGHT: Record<Rarity, number> = {
  common: 50,
  uncommon: 25,
  rare: 15,
  epic: 7,
  legendary: 3,
};

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

/**
 * A fresh prize. Defaults to UNCOMMON (a neutral middle tier) rather than
 * climbing the rarity ladder, so adding several prizes doesn't silently make
 * each one rarer. The weight matches the rarity's default tickets.
 */
export function newPrize(): Prize {
  return {
    id: "p" + Math.random().toString(36).slice(2, 8),
    label: "New prize",
    rarity: "uncommon",
    weight: RARITY_DEFAULT_WEIGHT.uncommon,
    emoji: "🎁",
  };
}

/** Deep-copy a prize with a fresh id. The label is kept as-is — the new row
 * appears right under the original, so a "copy" suffix is just noise to clean
 * up; duplicating is almost always the first step of editing the label anyway. */
export function duplicatePrize(p: Prize): Prize {
  const clone = structuredClone(p);
  clone.id = "p" + Math.random().toString(36).slice(2, 8);
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
