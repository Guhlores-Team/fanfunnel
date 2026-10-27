// RM-2: how stock reads to fans. Every count shown is the real one the server
// sent (publicView.toPublicStock); nothing here invents scarcity, and a wheel
// with "Show stock to fans" off sends no count to format.
import type { PublicPrize, PublicStock } from "@/lib/games/wheel/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";
import { isPublicPrizeAvailable } from "@/lib/games/wheel/publicView";

/** A limited prize with this many or fewer left gets the low-stock emphasis. */
export const LOW_STOCK_EMPHASIS_AT = 3;
/** What a sold-out limited prize reads as (the prize book, the Limited row, the public page). */
export const SOLD_OUT_LABEL = "Claimed ✨";
/** The most chips the Limited row under the wheel shows; the prize book lists the rest. */
export const LIMITED_ROW_MAX = 6;
/** The out-of-spins teaser adds "only N left" when its target has this many or fewer. */
export const TOPUP_SCARCITY_AT = 5;

/** "3 left", or the sold-out wording. Only call with a prize that has a count or is sold out. */
export function stockLabel(p: PublicStock): string {
  if (!isPublicPrizeAvailable(p)) return SOLD_OUT_LABEL;
  return `${p.stock} left`;
}

/** Whether the prize has something stock-related to show the fan. */
export function hasStockToShow(p: PublicStock): boolean {
  return typeof p.stock === "number" || p.soldOut === true;
}

export function isLowStock(p: PublicStock): boolean {
  return typeof p.stock === "number" && p.stock > 0 && p.stock <= LOW_STOCK_EMPHASIS_AT;
}

/**
 * The prizes for the Limited row: only prizes with a count (so nothing when
 * the wheel hides its stock), still-winnable first, rarest first, capped.
 */
export function limitedRowPrizes(prizes: PublicPrize[]): { shown: PublicPrize[]; more: number } {
  const limited = prizes
    .filter((p) => typeof p.stock === "number")
    .sort((a, b) => {
      const av = isPublicPrizeAvailable(a) ? 0 : 1;
      const bv = isPublicPrizeAvailable(b) ? 0 : 1;
      if (av !== bv) return av - bv;
      return RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity);
    });
  return { shown: limited.slice(0, LIMITED_ROW_MAX), more: Math.max(0, limited.length - LIMITED_ROW_MAX) };
}
