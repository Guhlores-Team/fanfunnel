// Core types for the Spin-the-Wheel game.
// These are intentionally framework-agnostic so the same engine powers
// the hosted dashboard, the fan-facing page, and any future export.

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

// Max prizes (slices) a single wheel may persist. The render + engine handle any
// count; this is a sanity ceiling so a wheel stays spinnable/readable. CRUCIAL:
// callers must REJECT a payload over this limit, never silently truncate it —
// silent truncation is how prize data gets lost on save (see saveWheel).
export const MAX_WHEEL_PRIZES = 50;

export const RARITY_ORDER: Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
];

// Sensible default colors per rarity so a creator gets a good-looking
// wheel without picking every color by hand.
export const RARITY_COLORS: Record<Rarity, string> = {
  common: "#6b7280", // gray
  uncommon: "#22c55e", // green
  rare: "#3b82f6", // blue
  epic: "#a855f7", // purple
  legendary: "#f59e0b", // gold
};

// Human-readable label per rarity. Lives next to RARITY_COLORS so the wheel,
// dashboard, and fan widgets all share one source of truth instead of each
// re-declaring the same map.
export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

export interface Prize {
  id: string;
  label: string;
  description?: string;
  rarity: Rarity;
  /**
   * Relative probability weight. A prize with weight 50 is 10x more likely
   * than one with weight 5. Weights do NOT need to sum to anything.
   */
  weight: number;
  color?: string;
  emoji?: string;
  /** Optional photo for the prize (e.g. a real item shot). null/undefined = none. */
  imageUrl?: string | null;
  /** Phase 4: the creator's cost to fulfil this prize, in cents. null/undefined = unset. */
  cost?: number | null;
  /**
   * Limited-stock prizes (e.g. a single "legendary" item). When stock hits 0
   * the prize is excluded from future spins. null/undefined = unlimited.
   */
  stock?: number | null;
}

/** Per-wheel prize-label text size; undefined = Auto (smart fit). */
export type WheelLabelSize = "s" | "l" | "xl";

export interface WheelConfig {
  id: string;
  title: string;
  /** Short line shown under the title on the fan page. */
  subtitle?: string;
  brandColor?: string;
  /**
   * Phase 9 (#11): creator-chosen color for the prize labels rendered on the
   * wheel. When unset, Wheel.tsx auto-picks a readable label color per segment.
   */
  labelColor?: string;
  /**
   * Per-wheel prize-label text size. Undefined = Auto (Wheel.tsx fits the font
   * to the slices). Explicit values bias it smaller/larger; an enlarged font is
   * still capped so a single line fits its slice (no overlap).
   */
  labelSize?: WheelLabelSize;
  /**
   * RM-2: show fans how many of each limited prize are left ("3 left").
   * Undefined = the default (on, see SHOW_STOCK_DEFAULT in ./publicView.ts).
   * Off, the fan-safe projection sends no count, only `soldOut`.
   */
  showStock?: boolean;
  prizes: Prize[];
  /** Phase 2: scheduling + lifecycle. All optional so existing callers are untouched. */
  isActive?: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
  archivedAt?: string | null;
}

/**
 * What a fan or the public may see of a prize (fan page, spin response, public
 * wheel API). An allowlist: `cost` is creator-private (Prize ROI) and must never
 * reach a fan, so a field added to Prize stays private until it is listed here
 * and in toPublicPrize (./publicView.ts).
 */
export type PublicPrize = Pick<
  Prize,
  "id" | "label" | "description" | "rarity" | "weight" | "color" | "emoji" | "imageUrl" | "stock"
> & {
  /**
   * RM-2: set (true) only on a limited prize that has run out. It has 0% odds
   * (engine `isAvailable`), so the fan page must not tease it. Sent even when
   * the wheel hides its stock counts, in which case `stock` is absent.
   */
  soldOut?: boolean;
};

/** The stock part of a PublicPrize: `{}` for an unlimited (or hidden, in-stock) prize. */
export type PublicStock = Pick<PublicPrize, "stock" | "soldOut">;

/** The fan-/public-facing wheel: display fields only, no lifecycle or costs. */
export interface PublicWheelConfig
  extends Pick<WheelConfig, "id" | "title" | "subtitle" | "brandColor" | "labelColor" | "labelSize"> {
  prizes: PublicPrize[];
}

/** Result of a single server-authoritative spin. */
export interface SpinResult {
  prize: PublicPrize;
  /** Index of the winning prize within config.prizes (for client animation). */
  prizeIndex: number;
  spinsRemaining: number;
  /** Phase 2: true when this spin's outcome was forced by the pity system. */
  pityAwarded?: boolean;
  /** Phase 3: opaque id for a shareable card generated from this win. */
  shareId?: string;
  /** Commit-reveal: sha256 of the NEXT spin's pre-committed server seed. */
  nextSpinHash?: string;
  /** Fairness v3: set when this spin's odds are inside its commitment. */
  fairVersion?: 3;
  /** Fairness v3: sha256 of the canonical pool snapshot mixed into the RNG. */
  poolHash?: string;
  /**
   * RM-2: the wheel's stock right after this spin, projected like the fan page
   * (`toPublicStockMap`): prize id -> PublicStock, listing only the prizes that
   * have something to show. A prize missing from the map shows no stock.
   * Absent when the wheel has no limited prize or the read failed.
   */
  stock?: Record<string, PublicStock>;
  /** RM-6: the fan's rolling spin counts right after this spin. */
  play?: { today: number; week: number };
  /** RM-6: today's spins have reached the fan's reminder (soft; the page asks before the next spin). */
  reminderDue?: boolean;
}
