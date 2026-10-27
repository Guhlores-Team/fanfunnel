import type { Prize, PublicWheelConfig, Rarity } from "@/lib/games/wheel/types";
import type { FanGlow } from "@/lib/glow/glow";

// Generated Supabase schema types (`npm run gen:types`; CI fails on drift).
// Use Tables<"name"> / Enums<"name"> for row shapes in new data-layer code.
export type { Database, Tables, TablesInsert, TablesUpdate, Enums, Json } from "./db.types";

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
  /** #26: this win delivered an instant reward the fan can reopen (never the value). */
  instant?: boolean;
}

/** Phase 3: a render-ready shareable win card. */
export interface ShareCardData { creatorTitle: string; prizeLabel: string; rarity: Rarity; emoji?: string; color: string; imageUrl?: string | null; at: string }
/** Phase 3: a prize a fan has flagged they want. */
export interface WishlistItem { id: string; prizeLabel: string; rarity: Rarity; at: string }
/** Phase 3: aggregated wishlist demand for a prize, for the creator. */
export interface WishlistDemand { prizeLabel: string; rarity: Rarity; count: number; fanNames: string[] }
/**
 * Phase 3: a single row in a public leaderboard.
 *
 * Privacy: this shape is served unauthenticated from /api/leaderboard/[creatorId]
 * and rendered on a public page, so it carries NO spend/revenue figure and no
 * fan id, email or token — only the handle the fan chose and activity counts.
 * Ranking is by spins, then rare wins. Don't add a money field here.
 */
export interface LeaderboardEntry { rank: number; handle: string; spins: number; rareWins: number }
/** Phase 3: the leaderboard as shown to fans. */
export interface LeaderboardView { enabled: boolean; creatorTitle: string; entries: LeaderboardEntry[] }
/** Phase 3: a scheduled happy-hour rare-boost window. */
export interface HappyHour { id: string; wheelId: string; multiplier: number; startsAt: string; endsAt: string }
/** Phase 3: the current happy-hour status for a wheel. */
export interface HappyHourStatus { active: boolean; multiplier: number; endsAt: string | null }
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
  wheel: PublicWheelConfig;
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
  /**
   * Whether THIS fan has explicitly consented to appear on that public board.
   * Always false until the fan ticks the toggle on their spin page — spinning
   * never opts them in.
   */
  leaderboardOptIn?: boolean;
  /** Phase 8C: optional personal note + avatar from the creator (mini-hero). */
  creatorNote?: string | null;
  creatorAvatarUrl?: string | null;
  /** Commit-reveal: sha256 of the pre-committed seed for the fan's NEXT spin. */
  nextSpinHash?: string | null;
  /** RM-3: the visit glow before this visit's check-in (null = none / gate closed). */
  glow?: FanGlow | null;
  /** RM-6: the fan's own play (counts, their reminder, their break). */
  play?: FanPlayView;
}

/**
 * RM-6: what a fan sees about their own play. Fan-only: the reminder and the
 * counts never reach the creator (the creator sees only the break state).
 */
export interface FanPlayView {
  /** Spins in the last 24 hours (rolling). */
  today: number;
  /** Spins in the last 7 days (rolling). */
  week: number;
  /** The fan's daily reminder, or null when off. */
  reminder: number | null;
  /** When the fan's break ends; null (or past) when not on a break. */
  breakUntil: string | null;
}

/**
 * How a spin obtained its server seed (recorded per spin, migration 0041).
 *  - `published`: the pass's pre-committed seed, whose hash was on the fan's
 *    spin page before the request — the full commit-reveal guarantee. This
 *    assumes no concurrent rotation between the request's arrival and the
 *    read: a seed rotated in by another in-flight spin and read on the first
 *    attempt is indistinguishable from one the page showed.
 *  - `stored`: a concurrent spin consumed the shown commitment first, so this
 *    spin consumed the seed that spin committed — generated on the server
 *    while this request (client seed included) was already in flight, and
 *    never shown to the fan in advance. No stronger than `fresh`.
 *  - `fresh`: generated at spin time (pass with no commitment, or a pre-0022
 *    DB). The hash was never published in advance.
 * `null` on spins recorded before this was tracked.
 */
export type SeedCommitment = "published" | "stored" | "fresh";

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
  /** Whether the seed was pre-committed; null when the spin predates tracking. */
  commitment?: SeedCommitment | null;
  /**
   * Which fairness derivation the spin used: 3 = odds inside the commitment
   * (replayable); null/1/2 = an earlier spin, verified by its seed hash only.
   */
  fairVersion?: number | null;
  /**
   * The recorded v3 inputs, exactly as stored (untrusted shapes). The verify
   * page re-hashes and replays them with `replayV3`; present only when
   * `fairVersion === 3`.
   */
  v3?: {
    prizeId: string | null;
    poolSnapshot: unknown;
    poolHash: string | null;
    fairTrace: unknown;
  };
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
  /**
   * The pass a spin-count edit of this grant moves (editGrant's rule, see
   * grantPass.ts), so the drawer previews that balance exactly. Null when the
   * fan has no active pass: a spin change is then refused (no_active_pass).
   */
  editPass: { spinsRemaining: number; wheelTitle: string | null } | null;
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
  /** #26: auto-delivered instantly (link / text / code); never the value. */
  auto?: { kind: "link" | "text" | "code"; views: number; lastViewedAt: string | null };
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
  blocked: boolean; // the creator blocked this fan (fans.blocked_at set)
  selfExcluded: boolean; // the fan paused (self-excluded) one of their links
  // Newest link that is active and not paused (null when none). Outreach
  // (win-back "Copy link") offers only this, never a paused link.
  activeToken: string | null;
  /** RM-6: when the fan's break ends (null / absent = not on a break). */
  breakUntil?: string | null;
  /** RM-3: days visited out of the last 7 (the "Regulars" filter). */
  visits7?: number;
}

export interface FanDetail {
  fanId: string; name: string;
  blocked: boolean; // fan is currently blocked (fans.blocked_at set)
  /** RM-6: when the fan's break ends (null / absent = not on a break). */
  breakUntil?: string | null;
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
  /** RM-3: days visited out of the last 7. */
  visits7?: number;
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
  /**
   * ISO timestamp of the oldest still-pending redemption across ALL rows (the
   * overview's redemptions list is capped at the newest 200). null when none.
   */
  oldestPendingAt?: string | null;
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
/** Distinct fans with ≥1 spin in the rolling last 7 days, and the 7 days before. */
export interface WeeklyActiveFans { thisWeek: number; lastWeek: number }
export interface CreatorMetricsExtra {
  trend: DailyCount[];
  funnel: ConversionFunnel;
  revenueTrend: RevenueDaily[];
  activeFans: WeeklyActiveFans;
}

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
