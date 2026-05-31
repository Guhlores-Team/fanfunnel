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

export type RedemptionStatus = "pending" | "fulfilled" | "cancelled";

/** A won prize in the creator's fulfilment queue. */
export interface RedemptionItem {
  id: string;
  fanName: string;
  prizeLabel: string;
  rarity: Rarity;
  emoji?: string;
  status: RedemptionStatus;
  at: string; // ISO timestamp
}

/** A persistent fan account with its links — for the creator's Fans tab. */
export interface FanAccountSummary {
  fanId: string;
  name: string;
  spinsRemaining: number;
  grantedTotal: number;
  links: { token: string }[];
  lastWin: { label: string; rarity: Rarity; at: string } | null;
}

export interface CreatorMetrics {
  fans: number;
  spinsPlayed: number;
  pending: number;
  fulfilled: number;
}

/** Everything the creator dashboard's metrics + inbox need. */
export interface CreatorOverview {
  metrics: CreatorMetrics;
  redemptions: RedemptionItem[];
}

export interface DailyCount { date: string; spins: number } // YYYY-MM-DD (UTC)
export interface ConversionFunnel { links: number; spun: number; fulfilled: number }
export interface CreatorMetricsExtra { trend: DailyCount[]; funnel: ConversionFunnel }

// --- Admin (cross-account) --------------------------------------------------

export type AppRole = "admin" | "creator";

export interface AdminAccount {
  id: string;
  email: string;
  displayName: string;
  role: AppRole;
  isActive: boolean;
  features: Record<string, boolean>;
  wheels: number;
  fans: number;
  spins: number;
  pending: number;
}

export interface AdminOverview {
  metrics: {
    creators: number;
    fans: number;
    spins: number;
    pending: number;
  };
  accounts: AdminAccount[];
}
