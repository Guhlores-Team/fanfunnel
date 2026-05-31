import type { Rarity, WheelConfig } from "@/lib/games/wheel/types";

/** A prize the fan has already won (their personal history). */
export interface WonPrize {
  label: string;
  rarity: Rarity;
  emoji?: string;
  color?: string;
  at: string; // ISO timestamp
}

/**
 * Everything the fan-facing page needs, resolved from a pass token.
 * Fans never authenticate and never have settings — the creator creates this
 * for them and this view is the entirety of what a fan can see.
 */
export interface FanPassView {
  token: string;
  fanName: string | null;
  creatorTitle: string;
  wheel: WheelConfig;
  spinsRemaining: number;
  recentWins: WonPrize[];
}
