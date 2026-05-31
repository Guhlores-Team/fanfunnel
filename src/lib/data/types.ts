import type { Prize, Rarity, WheelConfig } from "@/lib/games/wheel/types";

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
export interface Campaign {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  // Phase 2: a campaign may pin a default wheel. Optional so existing
  // construction sites in data/index.ts + data/mock.ts (owned by a later task)
  // compile until they're updated to populate it.
  pinnedWheelId?: string | null;
}

/** A single granted purchase (new fan or top-up), tagged to a campaign. */
export interface Grant {
  id: string;
  spins: number;
  amountCents: number;
  campaignId: string | null;
  campaignName: string | null;
  at: string; // ISO timestamp
  bonusSpins?: number;
}

/** A compact view of a creator's wheel for list/management screens. */
export interface WheelSummary {
  id: string;
  title: string;
  subtitle: string | null;
  brandColor: string;
  isActive: boolean;
  archivedAt: string | null;
  activeFrom: string | null;
  activeUntil: string | null;
  prizeCount: number;
  updatedAt: string;
}

/** A purchasable spin pack, optionally scoped to a campaign. */
export interface CampaignPack {
  id: string;
  campaignId: string | null;
  label: string;
  spins: number;
  amountCents: number;
  bonusSpins: number;
  sortOrder: number;
  createdAt: string;
}

/** A reusable prize the creator can drop into any wheel. */
export interface PrizeTemplate {
  id: string;
  label: string;
  description?: string;
  rarity: Rarity;
  weight: number;
  color?: string;
  emoji?: string;
  createdAt: string;
}

/** A reusable wheel preset (title + branding + prize set, no ids). */
export interface WheelTemplate {
  id: string;
  name: string;
  title: string;
  subtitle?: string;
  brandColor: string;
  prizes: Omit<Prize, "id">[];
  createdAt: string;
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
  tags: string[]; // creator-applied labels (VIP, whale, …)
  links: { token: string }[];
  lastWin: { label: string; rarity: Rarity; at: string } | null;
}

export interface FanDetail {
  fanId: string; name: string;
  notes: string | null; // free-form creator notes about the fan
  tags: string[]; // creator-applied labels (VIP, whale, …)
  spinsRemaining: number; grantedTotal: number; totalSpins: number;
  totalSpent: number; // cents
  lastActive: string | null;
  winsByRarity: { rarity: Rarity; count: number }[];
  pendingPrizes: { label: string; rarity: Rarity; emoji?: string; at: string }[];
  links: { token: string; createdAt: string }[];
  grants: Grant[]; // newest first
  byCampaign: FanCampaignBreakdown[];
}

/** A creator's saved DM template, with {link} as a placeholder for a fan URL. */
export interface DmTemplate { id: string; title: string; body: string; createdAt: string }

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
