// Core types for the Spin-the-Wheel game.
// These are intentionally framework-agnostic so the same engine powers
// the hosted dashboard, the fan-facing page, and any future export.

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

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
}
