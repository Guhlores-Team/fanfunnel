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
  prizes: Prize[];
  /** Phase 2: scheduling + lifecycle. All optional so existing callers are untouched. */
  isActive?: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
  archivedAt?: string | null;
}

/** Result of a single server-authoritative spin. */
export interface SpinResult {
  prize: Prize;
  /** Index of the winning prize within config.prizes (for client animation). */
  prizeIndex: number;
  spinsRemaining: number;
  /** Phase 2: true when this spin's outcome was forced by the pity system. */
  pityAwarded?: boolean;
  /** Phase 3: opaque id for a shareable card generated from this win. */
  shareId?: string;
  /** Commit-reveal: sha256 of the NEXT spin's pre-committed server seed. */
  nextSpinHash?: string;
}
