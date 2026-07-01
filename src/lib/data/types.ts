import type { Prize, Rarity, WheelConfig } from "@/lib/games/wheel/types";

/** A prize the fan has already won (their personal history). */
export interface WonPrize {
  label: string;
  rarity: Rarity;
  emoji?: string;
  color?: string;
  at: string; // ISO timestamp
  /** Phase 3: opaque id for a shareable card generated from this win. */
  shareId?: string;
  /** Phase 3: optional photo for the prize. null/undefined = none. */
  imageUrl?: string | null;
}

/** Phase 3: a render-ready shareable win card. */
export interface ShareCardData { creatorTitle: string; prizeLabel: string; rarity: Rarity; emoji?: string; color: string; imageUrl?: string | null; at: string }
/** Phase 3: a prize a fan has flagged they want. */
export interface WishlistItem { id: string; prizeLabel: string; rarity: Rarity; at: string }
/** Phase 3: aggregated wishlist demand for a prize, for the creator. */
export interface WishlistDemand { prizeLabel: string; rarity: Rarity; count: number; fanNames: string[] }
/** Phase 3: a single row in a public leaderboard. */
export interface LeaderboardEntry { rank: number; handle: string; spins: number; spentCents: number; rareWins: number }
/** Phase 3: the leaderboard as shown to fans. */
export interface LeaderboardView { enabled: boolean; creatorTitle: string; entries: LeaderboardEntry[] }
/** Phase 3: a scheduled happy-hour rare-boost window. */
export interface HappyHour { id: string; wheelId: string; multiplier: number; startsAt: string; endsAt: string }
/** Phase 3: the current happy-hour status for a wheel. */
export interface HappyHourStatus { active: boolean; multiplier: number; endsAt: string | null }
/** Phase 3: a fan's referral program summary. */
export interface ReferralOverview { code: string; referredCount: number; creditedCount: number; cap: number; bonusPerReferral: number }
export type MessageSender = "fan" | "creator";
/** Phase 3: a single chat message between a fan and a creator. */
export interface ChatMessage { id: string; sender: MessageSender; body: string; at: string; readAt: string | null }
/** Phase 3: a creator's inbox thread with one fan. */
export interface FanThread { fanId: string; fanName: string; lastBody: string; lastAt: string; unread: number }
/** Wave 3: a creator's editable auto intro/outro chat messages. */
export interface ChatSettings { intro: string | null; outro: string | null }

/**
 * Everything the fan-facing page needs, resolved from a pass token.
 * Fans never authenticate and never have settings — the creator creates this
 * for them and this view is the entirety of what a fan can see.
 */
export interface FanPassView {
  token: string;
  fanName: string | null;
  fanHandle?: string | null; // the fan's leaderboard handle (for "You're #X")
  creatorTitle: string;
  wheel: WheelConfig;
  spinsRemaining: number;
  recentWins: WonPrize[];
  /** Phase 3: optional fan-facing extras. All optional so existing callers compile. */
  wishlist?: WishlistItem[];
  happyHour?: HappyHourStatus;
  referral?: { code: string; bonusPerReferral: number };
  chatUnlocked?: boolean;
  /** Phase 5b: true until the fan has acknowledged the age-gate / ToS. */
  needsAck?: boolean;
  /** Phase 7: where the fan goes to tip / buy more spins (creator-set). */
  tipUrl?: string | null;
  /** Phase 7: the creator id, so the fan page can fetch the embedded leaderboard. */
  creatorId?: string;
  /** Phase 7: whether the creator's leaderboard is on (embed it inline if so). */
  leaderboardEnabled?: boolean;
  /** Phase 8C: optional personal note + avatar from the creator (mini-hero). */
  creatorNote?: string | null;
  creatorAvatarUrl?: string | null;
  /** Commit-reveal: sha256 of the pre-committed seed for the fan's NEXT spin. */
  nextSpinHash?: string | null;
}

/** Phase 5b (#23): the data a public verify page needs for one spin. */
export interface SpinVerification {
  prizeLabel: string;
  rarity: Rarity;
  serverSeed: string;
  serverSeedHash: string;
  nonce: number;
  hashOk: boolean;
  at: string;
  /** Commit-reveal: the fan-contributed seed mixed into the RNG ("" pre-0022). */
  clientSeed?: string | null;
}

/** Phase 5b (#24): a creator's outbound webhook registration. */
export interface Webhook {
  id: string;
  url: string;
  event: string;
  createdAt: string;
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
  pending: number; // prizes won in this campaign not yet fulfilled/cancelled
  playThroughPct: number; // spinsPlayed / spinsBought (0..1), 0 if none bought
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

export type RedemptionStatus =
  | "pending"
  | "in_progress"
  | "fulfilled"
  | "cancelled";

/** A won prize in the creator's fulfilment queue. */
export interface RedemptionItem {
  id: string;
  fanName: string;
  prizeLabel: string;
  rarity: Rarity;
  emoji?: string;
  status: RedemptionStatus;
  at: string; // ISO timestamp
  notes?: string | null;
  dueAt?: string | null; // ISO timestamp
}

/** One per-wheel link under a fan: its own spin balance + which wheel/campaign. */
export interface FanPassInfo {
  token: string;
  wheelId: string;
  wheelTitle: string;
  campaignName: string | null;
  spinsRemaining: number;
}

/** A persistent fan account with its links — for the creator's Fans tab. */
export interface FanAccountSummary {
  fanId: string;
  name: string;
  spinsRemaining: number; // total across all wheels (sum of passes)
  grantedTotal: number; // lifetime granted
  primaryToken: string | null;
  totalSpent: number; // cents
  campaignNames: string[]; // campaigns this fan has grants in
  tags: string[]; // creator-applied labels (VIP, whale, …)
  links: { token: string }[];
  passes: FanPassInfo[]; // per-wheel: link + balance + wheel/campaign
  lastWin: { label: string; rarity: Rarity; at: string } | null;
}

export interface FanDetail {
  fanId: string; name: string;
  blocked: boolean; // fan is currently blocked (fans.blocked_at set)
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
  /** Phase 3: count of unread fan messages. Optional so existing literals compile. */
  unreadMessages?: number;
  /** Phase 3: whether the creator's public leaderboard is on. Optional. */
  leaderboardEnabled?: boolean;
  /**
   * Onboarding: whether the creator has actually built a wheel — i.e. saved an
   * edit (a wheel updated since creation) or has more than the bootstrap wheel.
   * Drives the "Build your prize wheel" checklist step. Optional so literals
   * compile.
   */
  wheelBuilt?: boolean;
}

/** Everything the creator dashboard's metrics + inbox need. */
export interface CreatorOverview {
  metrics: CreatorMetrics;
  redemptions: RedemptionItem[];
}

// --- Phase 4 (deeper analytics) --------------------------------------------

/** #17 Best-time heatmap: 168 cells (7 weekdays × 24 hours, UTC). */
export interface EngagementHeatmap {
  cells: { weekday: number; hour: number; count: number }[]; // weekday 0=Sun..6=Sat, hour 0..23
  max: number;
}

/** #18 Prize ROI: a creator's per-prize win count and your cost to fulfil it. */
export interface PrizeRoiRow {
  label: string;
  rarity: Rarity;
  timesWon: number;
  costCents: number | null;
  totalCostCents: number; // (costCents ?? 0) * timesWon
}

/** #19 Cohort retention: fans cohorted by their first grant's campaign. */
export interface CohortRow {
  campaignId: string | null;
  campaignName: string;
  fans: number;
  returningFans: number; // fans in the cohort with ≥2 grants
  repeatRate: number; // returningFans / fans, 0 if fans=0
}

export interface DailyCount { date: string; spins: number } // YYYY-MM-DD (UTC)
export interface RevenueDaily { date: string; cents: number } // YYYY-MM-DD (UTC)
// Per-fan funnel (one permanent link per fan): fans created → fans who spun at
// least once → fans with a fulfilled prize. Measures real audience conversion,
// not link/spin volume.
export interface ConversionFunnel { fans: number; spun: number; fulfilled: number }
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
