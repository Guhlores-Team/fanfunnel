// The fan-safe projection of a wheel. Every fan- or public-facing payload (the
// fan page, the spin response, the public wheel API) goes through these, on
// both the mock and the Supabase data paths, so creator-private fields such as
// a prize's fulfilment cost can't reach a fan's browser.
//
// RM-2 adds stock: a limited prize carries its exact count only when the wheel
// shows stock to fans. With the switch off no count is sent at all (it is
// stripped here, not hidden in the UI); only `soldOut` remains, because a
// sold-out prize has 0% odds and the fan page must not tease it.
import type {
  Prize,
  PublicPrize,
  PublicStock,
  PublicWheelConfig,
  WheelConfig,
} from "./types";

/** RM-2 owner decision D2: a wheel shows its stock counts to fans unless the creator turns it off. */
export const SHOW_STOCK_DEFAULT = true;

/** Whether this wheel sends stock counts to fans (anything but a boolean = the default). */
export function showsStock(w: Pick<WheelConfig, "showStock">): boolean {
  return typeof w.showStock === "boolean" ? w.showStock : SHOW_STOCK_DEFAULT;
}

export interface FanProjectionOpts {
  /** Send the exact count of each limited prize (the wheel's "Show stock to fans"). */
  showStock: boolean;
}

/**
 * The stock a fan may see for one prize. Unlimited → `{}`. Limited → the exact
 * count (never below 0) when shown, plus `soldOut: true` once it is gone.
 */
export function toPublicStock(stock: number | null | undefined, showStock: boolean): PublicStock {
  if (typeof stock !== "number" || !Number.isFinite(stock)) return {};
  const out: PublicStock = {};
  if (showStock) out.stock = Math.max(0, Math.trunc(stock));
  if (stock <= 0) out.soldOut = true;
  return out;
}

export function toPublicPrize(p: Prize, opts: FanProjectionOpts): PublicPrize {
  const out: PublicPrize = { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight };
  if (p.description !== undefined) out.description = p.description;
  if (p.color !== undefined) out.color = p.color;
  if (p.emoji !== undefined) out.emoji = p.emoji;
  if (p.imageUrl !== undefined) out.imageUrl = p.imageUrl;
  return Object.assign(out, toPublicStock(p.stock, opts.showStock));
}

export function toPublicWheel(w: WheelConfig): PublicWheelConfig {
  const opts: FanProjectionOpts = { showStock: showsStock(w) };
  const out: PublicWheelConfig = {
    id: w.id,
    title: w.title,
    prizes: w.prizes.map((p) => toPublicPrize(p, opts)),
  };
  // Exact display allowlist; never spread arbitrary creator game settings.
  if (w.gameKind === "scratch") { out.gameKind = "scratch"; out.gameConfig = { style: "classic" }; }
  else if (w.gameKind === "bingo" && w.gameConfig && "linePrizeId" in w.gameConfig && typeof w.gameConfig.linePrizeId === "string") {
    out.gameKind = "bingo"; out.gameConfig = { size: 3, linePrizeId: w.gameConfig.linePrizeId };
  }
  if (w.subtitle !== undefined) out.subtitle = w.subtitle;
  if (w.brandColor !== undefined) out.brandColor = w.brandColor;
  if (w.labelColor !== undefined) out.labelColor = w.labelColor;
  if (w.labelSize !== undefined) out.labelSize = w.labelSize;
  return out;
}

/**
 * The live stock map a spin response carries (SpinResult.stock): one entry per
 * prize with something to show, so a hidden, in-stock prize is not listed.
 */
export function toPublicStockMap(
  prizes: Pick<Prize, "id" | "stock">[],
  showStock: boolean,
): Record<string, PublicStock> {
  const out: Record<string, PublicStock> = {};
  for (const p of prizes) {
    const s = toPublicStock(p.stock, showStock);
    if (s.stock !== undefined || s.soldOut) out[p.id] = s;
  }
  return out;
}

/** True when the wheel has a limited prize, i.e. a spin can change what fans see. */
export function hasLimitedPrize(prizes: Pick<Prize, "stock">[]): boolean {
  return prizes.some((p) => typeof p.stock === "number");
}

// --- Fan-side reads (pure, safe in the browser) ------------------------------

/**
 * Can the fan still win this prize? Mirrors the engine's `isAvailable` (the
 * draw and `prizeOdds`) on the projected prize, whether or not counts are shown.
 */
export function isPublicPrizeAvailable(p: PublicStock): boolean {
  if (p.soldOut === true) return false;
  return !(typeof p.stock === "number" && p.stock <= 0);
}

/**
 * Apply a spin response's stock map to the prizes the fan page shows. The map
 * is the whole truth after the spin: a prize missing from it shows no stock.
 */
export function applyStockMap(
  prizes: PublicPrize[],
  map: Record<string, PublicStock>,
): PublicPrize[] {
  return prizes.map((p) => {
    const rest: PublicPrize = { ...p };
    delete rest.stock;
    delete rest.soldOut;
    const next = map[p.id];
    return next ? { ...rest, ...next } : rest;
  });
}
