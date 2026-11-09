import type { Rarity } from "@/lib/games/wheel/types";
import type { DeliveredReward } from "@/lib/rewards/config";
import type { WinDelivery } from "./delivery";

// T3: the read-only "Your wins" view of a paused link. Isomorphic (no server
// imports), so the client view can name these shapes without reaching the
// data layer; src/lib/data/pausedLink.ts builds them on the server.

export interface PausedWin {
  label: string;
  rarity: Rarity;
  at: string;
  shareId: string | null;
  delivery?: WinDelivery;
  /** The already-revealed instant reward, or null when there is none to show. */
  reward: DeliveredReward | null;
  /** The win delivered an instant reward the fan can no longer view here. */
  rewardHidden: boolean;
}

export interface PausedFanWins {
  creatorTitle: string;
  pausedAt: string;
  /** Whether the fan is still on the public board, so they can leave it here. */
  leaderboardOptIn: boolean;
  wins: PausedWin[];
}

