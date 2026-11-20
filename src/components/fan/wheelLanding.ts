/**
 * RF-01: the wheel lands on a prize, not on a raw index. A creator can reorder,
 * add or remove prizes while a fan's page is open; the server answers with the
 * index in the list it drew from, so the page must draw that list (or at least
 * find the prize by id in the list it is showing).
 */
import type { PublicPrize, SpinResult } from "@/lib/games/wheel/types";

export interface Landing { index: number; prizeId?: string | null }

/** The slice to stop on in `prizes`: by prize id first, then by index, else -1. */
export function landingIndex(prizes: readonly { id: string }[], landing: Landing | null | undefined): number {
  if (!landing) return -1;
  if (landing.prizeId) {
    const byId = prizes.findIndex(p => p.id === landing.prizeId);
    if (byId >= 0) return byId;
  }
  return Number.isInteger(landing.index) && landing.index >= 0 && landing.index < prizes.length ? landing.index : -1;
}

/** The response carries the list it drew from only when it is usable for drawing. */
export function responsePrizes(data: Pick<SpinResult, "prizes" | "prizeIndex" | "prize">): PublicPrize[] | null {
  const list = data.prizes;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.some(p => !p || typeof p !== "object" || typeof p.id !== "string" || typeof p.label !== "string")) return null;
  return list[data.prizeIndex]?.id === data.prize.id ? list : null;
}

/**
 * The list the wheel must draw for this result: the page's own list when the
 * won prize still sits at the returned index, otherwise the list the server
 * drew from (null when the response does not carry one: the wheel then finds
 * the prize by id in the page's list).
 */
export function poolForResult(current: readonly PublicPrize[], data: Pick<SpinResult, "prizes" | "prizeIndex" | "prize">): PublicPrize[] | null {
  if (current[data.prizeIndex]?.id === data.prize.id) return null;
  return responsePrizes(data);
}

/** WF-12: "an Uncommon prize", "a Rare prize", "an Epic prize". */
export function withArticle(word: string): string {
  const article = /^[aeiou]/i.test(word.trim()) ? "an" : "a";
  return `${article} ${word}`;
}
