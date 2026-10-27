// The fan-safe projection of a wheel. Every fan- or public-facing payload (the
// fan page, the spin response, the public wheel API) goes through these, on
// both the mock and the Supabase data paths, so creator-private fields such as
// a prize's fulfilment cost can't reach a fan's browser.
import type { Prize, PublicPrize, PublicWheelConfig, WheelConfig } from "./types";

export function toPublicPrize(p: Prize): PublicPrize {
  const out: PublicPrize = { id: p.id, label: p.label, rarity: p.rarity, weight: p.weight };
  if (p.description !== undefined) out.description = p.description;
  if (p.color !== undefined) out.color = p.color;
  if (p.emoji !== undefined) out.emoji = p.emoji;
  if (p.imageUrl !== undefined) out.imageUrl = p.imageUrl;
  if (p.stock !== undefined) out.stock = p.stock;
  return out;
}

export function toPublicWheel(w: WheelConfig): PublicWheelConfig {
  const out: PublicWheelConfig = { id: w.id, title: w.title, prizes: w.prizes.map(toPublicPrize) };
  if (w.subtitle !== undefined) out.subtitle = w.subtitle;
  if (w.brandColor !== undefined) out.brandColor = w.brandColor;
  if (w.labelColor !== undefined) out.labelColor = w.labelColor;
  if (w.labelSize !== undefined) out.labelSize = w.labelSize;
  return out;
}
