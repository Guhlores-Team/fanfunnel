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

/** A creator's named grouping of links, for cross-promotion comparison. */
export interface Campaign { id: string; name: string; isActive: boolean; createdAt: string }

/** A single granted purchase (new fan or top-up), tagged to a campaign. */
export interface Grant {
  id: string;
  spins: number;
  amountCents: number;
  campaignId: string | null;
  campaignName: string | null;
  at: string; // ISO timestamp
}

export interface CampaignStats {
  campaign: Campaign;
  spinsBought: number; // sum grant spins tagged to this campaign
  spinsPlayed: number; // spins attributed to this campaign (spins.campaign_id)
  uniqueFans: number; // distinct fans with a grant in this campaign
  fulfilled: number;
  revenue: number; // cents
  arpu: number; // cents = uniqueFans ? round(revenue/uniqueFans) : 0
  topPrize: { label: string; rarity: Rarity; count: number } | null;
}

/** A fan's per-campaign rollup, for the fan drill-in. */
export interface FanCampaignBreakdown {
  campaignId: string;
  name: string;
  spinsBought: number;
  spinsPlayed: number;
  spentCents: number;
  prizes: { label: string; rarity: Rarity; count: number }[];
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
  grantedTotal: number; // lifetime granted
  primaryToken: string | null;
  totalSpent: number; // cents
  campaignNames: string[]; // campaigns this fan has grants in
  links: { token: string }[];
  lastWin: { label: string; rarity: Rarity; at: string } | null;
}

export interface FanDetail {
  fanId: string; name: string;
  spinsRemaining: number; grantedTotal: number; totalSpins: number;
  totalSpent: number; // cents
  lastActive: string | null;
  winsByRarity: { rarity: Rarity; count: number }[];
  pendingPrizes: { label: string; rarity: Rarity; emoji?: string; at: string }[];
  links: { token: string; createdAt: string }[];
  grants: Grant[]; // newest first
  byCampaign: FanCampaignBreakdown[];
}

export interface CreatorMetrics {
  fans: number;
  spinsPlayed: number;
  pending: number;
  fulfilled: number;
  revenue: number; // cents
}

/** Everything the creator dashboard's metrics + inbox need. */
export interface CreatorOverview {
  metrics: CreatorMetrics;
  redemptions: RedemptionItem[];
}

export interface DailyCount { date: string; spins: number } // YYYY-MM-DD (UTC)
export interface RevenueDaily { date: string; cents: number } // YYYY-MM-DD (UTC)
export interface ConversionFunnel { links: number; spun: number; fulfilled: number }
export interface CreatorMetricsExtra { trend: DailyCount[]; funnel: ConversionFunnel; revenueTrend: RevenueDaily[] }

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
