import { creatorGameFeatures, gameSettings } from "./gameSettings";
import { buildScratchPoolSnapshot, hashGamePoolSnapshot, primarySnapshot, type GamePoolSnapshot } from "@/lib/games/core/gameProof";
import { makeGameRngV3 } from "@/lib/games/core/fairness";
import { finishGame, type GamePresentation, type GameTrace } from "@/lib/games/core/play";
import { beginMockCreatorRequest, finishMockCreatorRequest, reconcileMockCreatorRequest, eraseMockCreatorRequestFan, resetMockCreatorRequestBusinessData, mockCreatorRequests } from "./mockCreatorRequests";
import { isUuid } from "./shared";
import { serverCreatorIntentHash, serverImportHash } from "@/lib/imports/serverDigest";
import { applyFocusStock, focusDisplay } from "./focusDisplay";
import { focusPackTerms, type FocusPackTerms } from "./focusPacks";
import { isFocusLength, isFocusMultiplier, MAX_COMBINED_BOOST } from "@/lib/focus/config";
import { mockFocusState, withMockFanLock, eraseMockFocusIdentity, clearMockFocusState, type MockFocus } from "./mockFocus";
import { toFanFocusView } from "./focusView";
import type { SpinIntent, SpinAttemptStatus } from "./spinAttempts";
import { randomBytes } from "node:crypto";
import { demoCodeFingerprint } from "@/lib/rewards/demoFingerprint";
import { decodeRewardHistoryCursor, encodeRewardHistoryCursor, rewardHistoryTimestamp } from "@/lib/rewards/history";
import { mockGetTheme, mockListMedia } from "./mockTheme";
import { toDbTheme } from "@/lib/creatorTheme/config";
import { makeFairRng, makeFairRngV3, normalizeClientSeed, randomSeedHex, sha256Hex } from "@/lib/games/wheel/fairness";
import {
  NEW_SPIN_FAIR_VERSION,
  buildFocusPoolSnapshot,
  drawFromSnapshot,
  hashPoolSnapshot,
  snapshotOdds,
  type FairTrace,
  type PoolSnapshot,
} from "@/lib/games/wheel/fairnessV3";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import { isPlayableGame, pickLiveGame } from "@/lib/games/liveGame";
import { RARITY_COLORS, RARITY_ORDER, type Prize, type PublicPrize, type PublicWheelConfig, type Rarity, type WheelConfig } from "@/lib/games/wheel/types";
import { storedWeight } from "@/lib/games/wheel/weights";
import { hasLimitedPrize, showsStock, toPublicPrize, toPublicStockMap, toPublicWheel } from "@/lib/games/wheel/publicView";
import { defaultFeatures } from "@/lib/features";
import { LEGAL, fanNeedsAck } from "@/lib/legal";
import { DEFAULT_PWA_ICON_MODE, type PwaIconMode } from "@/lib/pwa/config";
import type { FanAppInfo } from "@/lib/pwa/manifest";
import { countPlay, fanEngagementAllowed, isOnBreak, lengthenBreak, reminderDue } from "@/lib/play/playGuard";
import { PLAY_WEEK_WINDOW_MS } from "@/lib/play/config";
import { CHECKIN_READ_DAYS } from "@/lib/glow/config";
import { glowGateOpen, type GlowGateInput } from "@/lib/glow/gate";
import {
  addDays,
  checkinResult,
  clampCheckinDay,
  latestCheckinDay,
  computeGlow,
  glowAnchor,
  visitsLast7,
  type CheckinResult,
  type FanGlow,
} from "@/lib/glow/glow";
import { WINBACK_SNOOZE_DAYS, type OutreachAction } from "@/lib/winback/config";
import type { OutreachRow } from "@/lib/winback/list";
import {
  CODE_PREVIEW_COUNT,
  REWARD_HISTORY_PAGE_SIZE,
  MAX_CODES_PER_PRIZE,
  codeHint,
  maskCode,
  rewardReviewAllowed,
  type InstantRewardHistory,
  type DeliveredReward,
  type PrizeDeliveryView,
  type RewardKind,
} from "@/lib/rewards/config";
import type {
  AdminAccount,
  AdminOverview,
  Campaign,
  CampaignPack,
  CampaignStats,
  ChatMessage,
  ChatSettings,
  CohortRow,
  CreatorMetricsExtra,
  CreatorOverview,
  EngagementHeatmap,
  FanAccountSummary,
  FanCampaignBreakdown,
  FanDetail,
  FanThread,
  DmTemplate,
  FanPassView,
  FanPlayView,
  Grant,
  HappyHour,
  HappyHourStatus,
  LeaderboardEntry,
  LeaderboardView,
  PrizeRoiRow,
  PrizeTemplate,
  RedemptionItem,
  RedemptionStatus,
  SeedCommitment,
  ShareCardData,
  SpinVerification,
  Webhook,
  WheelSummary,
  WheelTemplate,
  WishlistDemand,
  WishlistItem,
  WonPrize,
} from "./types";
import { activeFans, bucketByDay, bucketCentsByDay, clampDays } from "./metrics";
import { pickGrantPass } from "./grantPass";
import type { Json } from "./db.types";
import {
  CREATOR_EXPORT_ABOUT,
  CREATOR_EXPORT_FORMAT,
  FAN_EXPORT_ABOUT,
  FAN_EXPORT_FORMAT,
  FAN_EXPORT_EXCLUDED,
  CREATOR_EXPORT_EXCLUDED,
  maskToken,
  type CreatorDataExport,
  type FanDataExport,
} from "@/lib/privacy/exportTypes";
import { EXPORT_ROW_CAP, exportStatus, safeExportValue } from "@/lib/privacy/exportRecords";
import {
  FEED_LIMIT,
  LOW_STOCK_THRESHOLD,
  OUT_OF_SPINS_WINDOW_DAYS,
  type NotificationSources,
} from "./notificationFeed";

// In-memory demo store. Used automatically when Supabase env vars are absent,
// so `npm run dev` gives a fully working app with zero setup. State resets when
// the dev server restarts.
//
// Mirrors production semantics:
//  * ONE editable creator wheel (the editor saves here; fans read from it;
//    limited stock is shared across all fans, like a real prizes table).
//  * balance + win history live on the FAN account, not the link, so many
//    tokens can point at one fan and share everything.

const CREATOR_TITLE = "Demo Creator";

// Phase 3 referral constants.
const REFERRAL_CAP = 3;
const REFERRAL_BONUS = 3;

// A win record carries the FIFO-attributed campaign for the spin that won it.
export interface MockWin extends WonPrize {
  campaignId: string | null;
  shareId: string; // Phase 3: opaque id for the shareable card
  imageUrl?: string | null; // Phase 3: snapshot of the prize photo
  // Phase 5b (#23): provably-fair commitment for this spin.
  serverSeed: string;
  serverSeedHash: string;
  nonce: number;
  // Commit-reveal v2: the fan-contributed seed mixed into the RNG.
  clientSeed?: string | null;
  // Whether the seed was pre-committed (absent on seeded demo wins).
  commitment?: SeedCommitment | null;
  // Fairness v3 (absent on older/seeded wins, which verify as v1/v2).
  prizeId?: string | null;
  fairVersion?: number | null;
  gameKind?: "wheel" | "scratch" | "bingo";
  wheelId?: string;
  presentation?: GamePresentation;
  poolSnapshot?: PoolSnapshot | GamePoolSnapshot | null;
  poolHash?: string | null;
  fairTrace?: FairTrace | GameTrace | null;
}

// A per-wheel link under a fan: its own balance + which wheel/campaign it's for.
interface MockPass {
  id?: string;
  nextSpinNonce?: number;
  token: string;
  wheelId: string;
  campaignId: string | null;
  // Commit-reveal v2: pre-committed seed for the NEXT spin on this link.
  nextServerSeed?: string;
  nextServerSeedHash?: string;
  spinsRemaining: number;
  spinsGrantedTotal: number;
  createdAt: string;
}

interface MockFan {
  id: string;
  name: string;
  spinsRemaining: number; // maintained aggregate = sum of passes
  spinsGrantedTotal: number; // tracked independently of remaining
  primaryToken: string;
  passes: MockPass[]; // per-wheel links/balances (authoritative)
  wins: MockWin[];
  notes: string | null; // free-form creator notes
  tags: string[]; // creator-applied labels
  pityCounter: number; // spins-without-a-rare, drives the pity guarantee
  // Phase 3
  leaderboardOptIn: boolean; // opted into the public leaderboard
  handle?: string; // optional public handle for the leaderboard
  referralCode: string; // this fan's own referral code
  referredByFanId: string | null; // who referred this fan, if anyone
  referralCredited: boolean; // whether this fan's referral has been credited
  // Phase 5b (#24): age-gate / ToS acknowledgement timestamp (null = not yet).
  ackedAt: string | null;
  // 0055: the Terms version the fan agreed to at the gate (null = none recorded).
  ackedTermsVersion: string | null;
  // Phase 5b: fan self-excluded (paused) their own link (null = active).
  selfExcludedAt: string | null;
  // The creator blocked this fan (mirrors fans.blocked_at; unset = not blocked).
  blockedAt?: string | null;
  // RM-6 (mirrors fans.break_until / fan_play_reminders.daily): the fan's own
  // break and private daily reminder, and their spin times for the rolling
  // counts (fan.wins is capped at 50, so it can't count a heavy week).
  breakUntil?: string | null;
  playReminderDaily?: number | null;
  spinTimes?: string[];
}

// Phase 5b (#24): a creator's registered outbound webhook (demo, in-memory).
interface MockWebhook {
  id: string;
  url: string;
  event: string;
  createdAt: string;
}

// Phase 3 store rows.
interface MockWishlist {
  prizeId?: string;
  id: string;
  fanId: string;
  prizeLabel: string;
  prizeRarity: Rarity;
  at: string;
}
interface MockHappyHour {
  id: string;
  wheelId: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
}
interface MockReferral {
  id: string;
  referrerFanId: string;
  referredFanId: string;
  bonusSpins: number;
  creditedAt: string | null;
  at: string;
}
interface MockMessage {
  id: string;
  fanId: string;
  sender: "fan" | "creator";
  body: string;
  readAt: string | null;
  at: string;
}

// A single grant (new fan creation OR a top-up), tagged to a campaign.
interface MockGrant {
  id: string;
  fanId: string;
  passToken?: string; // the per-wheel pass the spins landed on (grants.fan_pass_id)
  campaignId: string | null;
  spins: number;
  amountCents: number;
  bonusSpins: number;
  at: string;
}

// Redemptions in the mock carry the fan + FIFO campaign so stats can be exact.
interface MockRedemption extends RedemptionItem {
  fanId: string | null;
  campaignId: string | null;
  /** #26: the winning spin, so Fulfilment can show the "Auto" tag. */
  shareId?: string;
}

interface Store {
  wheels: Map<string, WheelConfig>; // wheelId -> wheel config (multiple wheels)
  fans: Map<string, MockFan>; // fanId -> fan
  tokens: Map<string, string>; // token -> fanId
  redemptions: MockRedemption[]; // creator-wide fulfilment queue (newest first)
  accounts: AdminAccount[]; // demo creator/admin accounts for the admin panel
  campaigns: Campaign[]; // creator's campaigns (newest first)
  tokenCampaign: Map<string, string>; // token -> campaignId
  grants: MockGrant[]; // every grant ever made (oldest first per fan via push order)
  dmTemplates: DmTemplate[]; // creator's saved DM templates (newest first)
  campaignPacks: CampaignPack[]; // purchasable spin packs (global or per-campaign)
  prizeTemplates: PrizeTemplate[]; // reusable prizes
  wheelTemplates: WheelTemplate[]; // reusable wheel presets
  // Phase 3
  wishlists: MockWishlist[];
  happyHours: MockHappyHour[];
  referrals: MockReferral[];
  messages: MockMessage[];
  leaderboardEnabled: boolean;
  // Get-started checklist dismissal (account-level; survives reloads in demo).
  onboardingDismissed: boolean;
  // Phase 9 #6: account settings (display name + notification prefs).
  displayName: string;
  notifyNewSpin: boolean;
  notifyLowBalance: boolean;
  notifyMessages: boolean;
  // RD-7: when the creator last opened the notification bell (null = never).
  notificationsSeenAt: string | null;
  // Phase 5b
  webhooks: MockWebhook[];
  // Wave 3: editable auto intro/outro chat messages (creator-level).
  chatIntro: string | null;
  chatOutro: string | null;
}

// Wave 3: flirty defaults so the auto-messages feature works out of the box.
const DEFAULT_CHAT_INTRO =
  "Hey you 😘 so glad you're here — spin and let's see what you get…";
const DEFAULT_CHAT_OUTRO =
  "Out of spins already? 🥵 Top me up and let's keep going…";

/** Short, unique id with a stable prefix (mirrors the file's existing style). */
function genId(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10);
}

// Track creation order for wheels (the Map preserves insertion order, but an
// explicit field keeps "newest"/"oldest" resolution robust across saves).
interface WheelMeta {
  createdAt: string;
  updatedAt: string;
}
const g2 = globalThis as unknown as { __ffWheelMeta?: Map<string, WheelMeta> };
const wheelMeta: Map<string, WheelMeta> =
  g2.__ffWheelMeta ?? (g2.__ffWheelMeta = new Map());

// A few seeded accounts so the admin panel is explorable in demo mode.
function seedAccounts(): AdminAccount[] {
  return [
    {
      id: "acc-you",
      email: "you@fanfunnel.app",
      displayName: "You (Agency)",
      role: "admin",
      isActive: true,
      features: { ...defaultFeatures(), scratch: true, bingo: true },
      wheels: 1,
      fans: 0,
      spins: 0,
      pending: 0,
    },
    {
      id: "acc-bella",
      email: "bella@example.com",
      displayName: "Bella",
      role: "creator",
      isActive: true,
      features: { ...defaultFeatures(), scratch: true },
      wheels: 2,
      fans: 48,
      spins: 312,
      pending: 7,
    },
    {
      id: "acc-mia",
      email: "mia@example.com",
      displayName: "Mia Rose",
      role: "creator",
      isActive: true,
      features: defaultFeatures(),
      wheels: 1,
      fans: 23,
      spins: 96,
      pending: 2,
    },
    {
      id: "acc-jade",
      email: "jade@example.com",
      displayName: "Jade",
      role: "creator",
      isActive: false,
      features: defaultFeatures(),
      wheels: 1,
      fans: 5,
      spins: 11,
      pending: 0,
    },
  ];
}

// Two default DM templates so the "Copy DM" picker is useful out of the box.
// `{link}` is replaced with the fan's full spin URL when a template is used.
function seedDmTemplates(): DmTemplate[] {
  return [
    {
      id: "dm-spin-invite",
      title: "Spin invite",
      body: "Hey! 🎡 Here's your spin link: {link}",
      createdAt: new Date().toISOString(),
    },
    {
      id: "dm-topup-nudge",
      title: "Top-up nudge",
      body: "You're out of spins — top up and let's go again: {link}",
      createdAt: new Date().toISOString(),
    },
  ];
}

// Two demo spin packs (global — attached to no campaign) so the presets UI
// shows something out of the box.
function seedCampaignPacks(): CampaignPack[] {
  const now = new Date().toISOString();
  return [
    {
      id: "pack-starter",
      campaignId: null,
      label: "Starter — 5 spins",
      spins: 5,
      amountCents: 1000,
      bonusSpins: 0,
      sortOrder: 0,
      createdAt: now,
    },
    {
      id: "pack-value",
      campaignId: null,
      label: "Value — 12 spins (+2 bonus)",
      spins: 12,
      amountCents: 2000,
      bonusSpins: 2,
      sortOrder: 1,
      createdAt: now,
    },
  ];
}

// A couple of reusable prizes so the prize library isn't empty in demo mode.
function seedPrizeTemplates(): PrizeTemplate[] {
  const now = new Date().toISOString();
  return [
    {
      id: "ptpl-selfie",
      label: "Exclusive Selfie",
      rarity: "common",
      weight: 40,
      emoji: "🤳",
      color: RARITY_COLORS.common,
      createdAt: now,
    },
    {
      id: "ptpl-call",
      label: "10-min Video Call",
      rarity: "rare",
      weight: 6,
      emoji: "📞",
      color: RARITY_COLORS.rare,
      createdAt: now,
    },
  ];
}

// One reusable wheel preset (derived from the sample wheel, ids stripped).
function seedWheelTemplates(): WheelTemplate[] {
  return [
    {
      id: "wtpl-starter",
      name: "Starter Wheel",
      title: SAMPLE_WHEEL.title,
      subtitle: SAMPLE_WHEEL.subtitle,
      brandColor: SAMPLE_WHEEL.brandColor ?? "#ec4899",
      prizes: SAMPLE_WHEEL.prizes.map(({ id: _id, ...rest }) => rest),
      createdAt: new Date().toISOString(),
    },
  ];
}

// Build the initial single active wheel seeded from SAMPLE_WHEEL.
function seedWheels(): Map<string, WheelConfig> {
  const wheel: WheelConfig = {
    ...structuredClone(SAMPLE_WHEEL),
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    archivedAt: null,
  };
  const m = new Map<string, WheelConfig>();
  m.set(wheel.id, wheel);
  return m;
}

// Pin to globalThis so the store is shared across every Next.js entry point
// (pages and route handlers are bundled separately).
const g = globalThis as unknown as { __ffStore?: Store };
const store: Store =
  g.__ffStore ??
  (g.__ffStore = {
    wheels: seedWheels(),
    fans: new Map(),
    tokens: new Map(),
    redemptions: [],
    accounts: seedAccounts(),
    campaigns: [],
    tokenCampaign: new Map(),
    grants: [],
    dmTemplates: seedDmTemplates(),
    campaignPacks: seedCampaignPacks(),
    prizeTemplates: seedPrizeTemplates(),
    wheelTemplates: seedWheelTemplates(),
    wishlists: [],
    happyHours: [],
    referrals: [],
    messages: [],
    leaderboardEnabled: false,
    onboardingDismissed: false,
    displayName: "Demo Creator",
    notifyNewSpin: true,
    notifyLowBalance: true,
    notifyMessages: true,
    notificationsSeenAt: null,
    webhooks: [],
    chatIntro: DEFAULT_CHAT_INTRO,
    chatOutro: DEFAULT_CHAT_OUTRO,
  });

// A store pinned by an older dev-server build may predate these fields, so
// backfill them defensively rather than crashing on the new code paths.
store.campaigns ??= [];
store.tokenCampaign ??= new Map();
store.grants ??= [];
store.dmTemplates ??= seedDmTemplates();
store.wheels ??= seedWheels();
store.campaignPacks ??= seedCampaignPacks();
store.prizeTemplates ??= seedPrizeTemplates();
store.wheelTemplates ??= seedWheelTemplates();
// Phase 3 collections (defensive-init for stores pinned before they existed).
store.wishlists ??= [];
store.happyHours ??= [];
store.referrals ??= [];
store.messages ??= [];
store.leaderboardEnabled ??= false;
store.onboardingDismissed ??= false;
store.displayName ??= "Demo Creator";
store.notifyNewSpin ??= true;
store.notifyLowBalance ??= true;
store.notifyMessages ??= true;
store.notificationsSeenAt ??= null;
store.webhooks ??= [];
// Wave 3: backfill auto-message defaults on stores pinned before they existed.
if (store.chatIntro === undefined) store.chatIntro = DEFAULT_CHAT_INTRO;
if (store.chatOutro === undefined) store.chatOutro = DEFAULT_CHAT_OUTRO;

// Migrate a store pinned before the multi-wheel refactor: a `wheel` single
// field may exist on the old shape. Fold it into the wheels map as active.
{
  const legacy = (store as unknown as { wheel?: WheelConfig }).wheel;
  if (legacy && store.wheels.size === 0) {
    legacy.isActive ??= true;
    legacy.activeFrom ??= null;
    legacy.activeUntil ??= null;
    legacy.archivedAt ??= null;
    store.wheels.set(legacy.id, legacy);
  }
}

// Backfill wheel meta + lifecycle fields for every wheel.
for (const w of store.wheels.values()) {
  w.activeFrom ??= null;
  w.activeUntil ??= null;
  w.archivedAt ??= null;
  if (!wheelMeta.has(w.id)) {
    const now = new Date().toISOString();
    wheelMeta.set(w.id, { createdAt: now, updatedAt: now });
  }
}

// Backfill notes/tags/pity on any fan pinned before these fields existed.
for (const fan of store.fans.values()) {
  fan.notes ??= null;
  fan.tags ??= [];
  fan.pityCounter ??= 0;
  // Phase 3 fields.
  fan.leaderboardOptIn ??= false;
  fan.referralCode ??= genId("ref");
  fan.referredByFanId ??= null;
  fan.referralCredited ??= false;
  // Phase 5b: default un-acked so the age-gate shows for pre-existing fans.
  fan.ackedAt ??= null;
  fan.ackedTermsVersion ??= null;
  fan.selfExcludedAt ??= null;
  // Backfill shareId + fairness fields on any win pinned before they existed.
  for (const w of fan.wins) {
    w.shareId ??= genId("share");
    w.serverSeed ??= randomSeedHex();
    w.nonce ??= 0;
    w.serverSeedHash ??= "";
  }
}
// Backfill bonusSpins on any grant pinned before that field existed.
for (const grant of store.grants) {
  grant.bonusSpins ??= 0;
}
// Backfill pinnedWheelId on any campaign pinned before that field existed.
for (const campaign of store.campaigns) {
  campaign.pinnedWheelId ??= null;
}

if (!store.fans.has("demo-fan")) {
  const demoSpins = 5;
  store.fans.set("demo-fan", {
    id: "demo-fan",
    name: "Demo Fan",
    spinsRemaining: demoSpins,
    spinsGrantedTotal: demoSpins,
    primaryToken: "demo",
    passes: [
      {
        token: "demo",
        wheelId: mockResolveActiveWheelId(),
        campaignId: null,
        spinsRemaining: demoSpins,
        spinsGrantedTotal: demoSpins,
        createdAt: new Date().toISOString(),
      },
    ],
    wins: [],
    notes: null,
    tags: ["new"],
    pityCounter: 0,
    leaderboardOptIn: false,
    referralCode: genId("ref"),
    referredByFanId: null,
    referralCredited: false,
    ackedAt: null,
    ackedTermsVersion: null,
    selfExcludedAt: null,
  });
  store.tokens.set("demo", "demo-fan");
  // Seed a grant so revenue/per-campaign data is coherent in demo mode.
  store.grants.push({
    id: "g-demo",
    fanId: "demo-fan",
    campaignId: null,
    spins: demoSpins,
    amountCents: 0,
    bonusSpins: 0,
    at: new Date().toISOString(),
  });
  // Phase 3: seed a wishlist + a fan message so demo views aren't empty.
  const seedWheel = seedWheels().values().next().value as WheelConfig | undefined;
  const seedPrize = seedWheel?.prizes[0];
  if (seedPrize) {
    store.wishlists.push({
      id: genId("wish"),
      fanId: "demo-fan",
      prizeLabel: seedPrize.label,
      prizeRarity: seedPrize.rarity,
      at: new Date().toISOString(),
    });
  }
  store.messages.push({
    id: genId("msg"),
    fanId: "demo-fan",
    sender: "fan",
    body: "Hi! Loving the wheel 🎡",
    readAt: null,
    at: new Date().toISOString(),
  });
}

function fanForToken(token: string): MockFan | null {
  const fanId = store.tokens.get(token);
  return fanId ? store.fans.get(fanId) ?? null : null;
}

// --- Wheel resolution -------------------------------------------------------

function wheelCreatedAt(id: string): string {
  return wheelMeta.get(id)?.createdAt ?? new Date(0).toISOString();
}

/** Wheels in creation order (oldest → newest). */
function wheelsByAge(): WheelConfig[] {
  return Array.from(store.wheels.values()).sort((a, b) =>
    wheelCreatedAt(a.id).localeCompare(wheelCreatedAt(b.id))
  );
}

/**
 * Resolve the wheel id that's "active right now" among non-archived wheels:
 *  1. window match (activeFrom <= now AND (activeUntil null OR > now)) — prefer
 *     the latest activeFrom, then the newest wheel;
 *  2. else the flagged isActive wheel;
 *  3. else the oldest wheel (always returns something if any wheel exists).
 */
export function mockResolveActiveWheelId(now: Date = new Date()): string {
  const live = wheelsByAge().filter((w) => !w.archivedAt && w.gameReady !== false && w.gameKind !== "bingo");
  if (live.length === 0) {
    // Should never happen in demo mode, but stay defensive.
    return store.wheels.keys().next().value ?? SAMPLE_WHEEL.id;
  }

  const picked = pickLiveGame(live.map(w => ({ id: w.id, isActive: w.isActive === true, archivedAt: w.archivedAt ?? null,
    activeFrom: w.activeFrom ?? null, activeUntil: w.activeUntil ?? null, createdAt: wheelCreatedAt(w.id), gameKind: w.gameKind, gameReady: w.gameReady })), now);
  return picked ? picked.game.id : live[0].id;
}

/** The currently-active wheel config (always defined in demo mode). */
function activeWheel(): WheelConfig {
  const id = mockResolveActiveWheelId();
  return store.wheels.get(id) ?? wheelsByAge()[0];
}

/**
 * Resolve which wheel a fan's pass should use: a campaign pin (if the campaign
 * exists, has pinnedWheelId, and that wheel is non-archived) wins; otherwise
 * fall back to the active wheel.
 */
export function mockResolveWheelId(
  pass: { campaignId: string | null; wheelId?: string },
  now: Date = new Date()
): string {
  // An explicit wheel wins (per-wheel top-ups target a specific wheel).
  if (pass.wheelId) {
    const w = store.wheels.get(pass.wheelId);
    if (w && !w.archivedAt && w.gameReady !== false && w.gameKind !== "bingo") return pass.wheelId;
  }
  if (pass.campaignId) {
    const campaign = store.campaigns.find((c) => c.id === pass.campaignId);
    const pinned = campaign?.pinnedWheelId ?? null;
    if (pinned) {
      const w = store.wheels.get(pinned);
      if (w && !w.archivedAt && w.gameReady !== false && w.gameKind !== "bingo") return pinned;
    }
  }
  return mockResolveActiveWheelId(now);
}

/** Model C play resolution: campaign pin, live creator wheel, stored fallback. */
export function mockResolvedSpinWheelId(pass: { campaignId: string | null; wheelId: string }, now = new Date()): string {
  const pinnedId = pass.campaignId ? store.campaigns.find(campaign => campaign.id === pass.campaignId)?.pinnedWheelId : null;
  const pinned = pinnedId ? store.wheels.get(pinnedId) : null;
  if (pinned && !pinned.archivedAt && pinned.gameReady !== false && pinned.gameKind !== "bingo") return pinned.id;
  const active = mockResolveActiveWheelId(now);
  return store.wheels.get(active)?.archivedAt ? pass.wheelId : active;
}

/** The campaign attached to a fan's primary token, if any. */
function campaignForFan(fan: MockFan): string | null {
  return store.tokenCampaign.get(fan.primaryToken) ?? null;
}

/** Find the pass (per-wheel link) + its fan for a token. */
function passForToken(token: string): { fan: MockFan; pass: MockPass } | null {
  for (const fan of store.fans.values()) {
    const pass = fan.passes?.find((p) => p.token === token);
    if (pass) return { fan, pass };
  }
  return null;
}

/** Re-derive a fan's aggregate balance from the sum of their passes. */
function recomputeFanAggregate(fan: MockFan) {
  fan.spinsRemaining = (fan.passes ?? []).reduce((s, p) => s + p.spinsRemaining, 0);
  fan.spinsGrantedTotal = (fan.passes ?? []).reduce((s, p) => s + p.spinsGrantedTotal, 0);
}

/** Backfill: give any fan without per-wheel passes a single pass derived from
 *  their legacy primaryToken + balance (so older in-memory stores keep working). */
function ensurePasses(fan: MockFan) {
  if (fan.passes && fan.passes.length > 0) return;
  const campaignId = store.tokenCampaign.get(fan.primaryToken) ?? null;
  const wheelId = mockResolveWheelId({ campaignId });
  fan.passes = [
    {
      token: fan.primaryToken,
      wheelId,
      campaignId,
      spinsRemaining: fan.spinsRemaining,
      spinsGrantedTotal: fan.spinsGrantedTotal,
      createdAt: new Date().toISOString(),
    },
  ];
}

/** Credit spins to a fan's OLDEST pass (their original link — matching the
 *  Supabase 0020 backfill convention) so fan-level bonuses land somewhere
 *  spendable, then resync the aggregate to the sum of passes. */
function creditSpinsToOldestPass(fan: MockFan, n: number) {
  if (n <= 0) return;
  ensurePasses(fan);
  const oldest = (fan.passes ?? [])
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!oldest) return;
  oldest.spinsRemaining += n;
  oldest.spinsGrantedTotal += n;
  recomputeFanAggregate(fan);
}

/** Lifecycle fields a WheelSummary needs, normalized. */
function toWheelSummary(w: WheelConfig): WheelSummary {
  const meta = wheelMeta.get(w.id);
  return {
    id: w.id,
    title: w.title,
    subtitle: w.subtitle ?? null,
    brandColor: w.brandColor ?? "#ec4899",
    isActive: w.id === mockResolveActiveWheelId(),
    archivedAt: w.archivedAt ?? null,
    activeFrom: w.activeFrom ?? null,
    activeUntil: w.activeUntil ?? null,
    prizeCount: w.prizes.length,
    updatedAt: meta?.updatedAt ?? new Date().toISOString(),
    createdAt: wheelCreatedAt(w.id),
    gameKind: w.gameKind ?? "wheel",
    gameReady: w.gameReady !== false,
  };
}

/** The pass a spin-count edit of this grant moves (grantPass.ts rule). Mock
 *  passes carry no is_active flag, so every pass counts as active; ties on
 *  createdAt keep push (creation) order. */
function grantEditPass(fan: MockFan, grant: MockGrant): MockPass | null {
  ensurePasses(fan);
  const oldestFirst = fan.passes
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((p) => ({ id: p.token, isActive: true, pass: p }));
  return pickGrantPass(oldestFirst, grant.passToken)?.pass ?? null;
}

// A fan's grants, oldest→newest (push order is creation order in the mock).
function fanGrants(fanId: string): MockGrant[] {
  return store.grants.filter((g) => g.fanId === fanId);
}

export function mockGetWheel(): WheelConfig {
  const wheel = activeWheel();
  return { ...structuredClone(wheel), gameKind: wheel.gameKind ?? "wheel", gameConfig: wheel.gameConfig ?? {}, gameReady: wheel.gameReady !== false, gameKindLocked: wheel.gameKindLocked === true };
}

export function mockSaveWheel(config: WheelConfig): WheelConfig {
  // Save by id into the wheels map. If the id matches no existing wheel, treat
  // the save as targeting the active wheel (preserving its stable id).
  const targetId = store.wheels.has(config.id) ? config.id : activeWheel().id;
  const existing = store.wheels.get(targetId);
  const settings = gameSettings(config.gameKind ?? existing?.gameKind, config.gameConfig ?? existing?.gameConfig);
  if (settings.gameKind !== (existing?.gameKind ?? "wheel")) {
    if (existing?.gameKindLocked) throw new Error("game_kind_locked");
    if (!mockGameFeatures()[settings.gameKind]) throw new Error("feature_disabled");
  }
  for (const focus of mockFocusState().focuses.values()) {
    const target = config.prizes.find(prize => prize.id === focus.prize_id);
    if (focus.wheel_id === targetId && !target) mockCancelFanFocus(focus.fan_id);
  }
  const saved: WheelConfig = {
    ...structuredClone(config),
    ...settings, gameReady: true, gameKindLocked: existing?.gameKindLocked === true,
    // Mirror the int4 weight column (see prizeRow): round, positive stays ≥ 1.
    prizes: config.prizes.map((p) => ({ ...structuredClone(p), weight: storedWeight(p.weight) })),
    id: targetId,
    // Preserve lifecycle/schedule fields unless the incoming config sets them.
    isActive: config.isActive ?? existing?.isActive,
    // RM-2: same rule as saveWheel — only a real boolean changes the switch.
    showStock: typeof config.showStock === "boolean" ? config.showStock : existing?.showStock,
    activeFrom: config.activeFrom ?? existing?.activeFrom ?? null,
    activeUntil: config.activeUntil ?? existing?.activeUntil ?? null,
    archivedAt: config.archivedAt ?? existing?.archivedAt ?? null,
  };
  store.wheels.set(targetId, saved);
  // #26: delivery comes from the reward store, never the editor; a code
  // prize's stock is its unused-code count.
  syncMockWheelRewards(saved);
  const meta = wheelMeta.get(targetId);
  const now = new Date().toISOString();
  if (meta) meta.updatedAt = now;
  else wheelMeta.set(targetId, { createdAt: now, updatedAt: now });
  return structuredClone(saved);
}

// --- Wheel management (multi-wheel) ----------------------------------------

/** Every wheel as a compact summary, newest first. */
export function mockListWheels(includeArchived = false): WheelSummary[] {
  const wheels = wheelsByAge()
    .slice()
    .reverse() // newest first
    .filter((w) => includeArchived || !w.archivedAt);
  return wheels.map((w) => structuredClone(toWheelSummary(w)));
}

/** A single wheel's full config by id, or null. */
export function mockGetWheelById(id: string): WheelConfig | null {
  const w = store.wheels.get(id);
  return w ? { ...structuredClone(w), gameKind: w.gameKind ?? "wheel", gameConfig: w.gameConfig ?? {}, gameReady: w.gameReady !== false, gameKindLocked: w.gameKindLocked === true } : null;
}

/**
 * Create a new wheel, seeded from a wheel template (if given) or SAMPLE_WHEEL.
 * Only the very first wheel in the store is created active.
 */
export function mockCreateWheel(opts?: {
  fromTemplateId?: string;
  name?: string;
  gameKind?: unknown;
  gameConfig?: unknown;
}): { wheel: WheelConfig } {
  const isFirst = store.wheels.size === 0;
  const id = genId("wheel");
  const now = new Date().toISOString();

  let title: string;
  let subtitle: string | undefined;
  let brandColor: string;
  let prizes: Prize[];

  const tpl = opts?.fromTemplateId
    ? store.wheelTemplates.find((t) => t.id === opts.fromTemplateId)
    : undefined;
  if (tpl) {
    title = tpl.title;
    subtitle = tpl.subtitle;
    brandColor = tpl.brandColor;
    prizes = tpl.prizes.map((p) => ({ ...structuredClone(p), id: genId("prize") }));
  } else {
    // #7: a blank "New wheel" starts EMPTY (no prizes) → editor shows the empty
    // state + "Add your first prize". Templates still seed their prizes above.
    title = "New wheel";
    subtitle = undefined;
    brandColor = SAMPLE_WHEEL.brandColor ?? "#ec4899";
    prizes = [];
  }

  const settings = gameSettings(tpl?.gameKind ?? opts?.gameKind, tpl?.gameConfig ?? opts?.gameConfig);
  if (!mockGameFeatures()[settings.gameKind]) throw new Error("feature_disabled");
  const wheel: WheelConfig = {
    ...settings, gameReady: true, gameKindLocked: false,
    id,
    title: opts?.name?.trim() || title,
    subtitle,
    brandColor,
    prizes,
    isActive: isFirst,
    activeFrom: null,
    activeUntil: null,
    archivedAt: null,
  };
  store.wheels.set(id, wheel);
  wheelMeta.set(id, { createdAt: now, updatedAt: now });
  return { wheel: structuredClone(wheel) };
}

/** Duplicate an existing wheel (deep copy, " copy" suffix, inactive). */
export function mockDuplicateWheel(id: string): { wheel: WheelConfig } {
  const src = store.wheels.get(id);
  if (!src) throw new Error("not_found");
  const settings = gameSettings(src.gameKind, src.gameConfig);
  if (!mockGameFeatures()[settings.gameKind]) throw new Error("feature_disabled");
  const newId = genId("wheel");
  const now = new Date().toISOString();
  const wheel: WheelConfig = {
    ...structuredClone(src),
    ...settings, gameKindLocked: false,
    id: newId,
    title: src.title,
    prizes: src.prizes.map((p) => ({ ...structuredClone(p), id: genId("prize") })),
    isActive: false,
    activeFrom: null,
    activeUntil: null,
    archivedAt: null,
  };
  store.wheels.set(newId, wheel);
  wheelMeta.set(newId, { createdAt: now, updatedAt: now });
  return { wheel: structuredClone(wheel) };
}

/**
 * Archive a wheel. If it was the active one, promote the oldest remaining
 * non-archived wheel to active so the creator always has a live wheel.
 */
export function mockUnarchiveWheel(id: string): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  wheel.archivedAt = null;
  return { ok: true };
}

export function mockArchiveWheel(id: string): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  if (wheel.archivedAt) return { ok: true };

  const wasActive = wheel.isActive;
  for (const focus of mockFocusState().focuses.values()) if (focus.wheel_id === id) mockCancelFanFocus(focus.fan_id);
  wheel.archivedAt = new Date().toISOString();
  wheel.isActive = false;

  if (wasActive) {
    const remaining = wheelsByAge().filter((w) => !w.archivedAt);
    if (remaining.length > 0) remaining[0].isActive = true; // oldest remaining
  }
  return { ok: true };
}

/** Permanently remove a wheel (demo has no real spin history to protect). */
export function mockDeleteWheel(id: string): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  const wasActive = wheel.isActive;
  for (const focus of mockFocusState().focuses.values()) if (focus.wheel_id === id) mockCancelFanFocus(focus.fan_id);
  store.wheels.delete(id);
  wheelMeta.delete(id);
  if (wasActive) {
    const remaining = wheelsByAge().filter((w) => !w.archivedAt);
    if (remaining.length > 0) remaining[0].isActive = true;
  }
  return { ok: true };
}

/** Make a wheel the active one (clears the flag on all others). */
export function mockSetActiveWheel(id: string): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  if (wheel.archivedAt) return { error: "archived" };
  for (const w of store.wheels.values()) w.isActive = false;
  wheel.isActive = true;
  return { ok: true };
}

/** Set (or clear) a wheel's scheduled active window. */
export function mockSetWheelSchedule(
  id: string,
  schedule: { activeFrom: string | null; activeUntil: string | null }
): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  const { activeFrom, activeUntil } = schedule;
  if (activeFrom != null && activeUntil != null && activeUntil <= activeFrom) {
    return { error: "invalid_window" };
  }
  wheel.activeFrom = activeFrom;
  wheel.activeUntil = activeUntil;
  const meta = wheelMeta.get(id);
  if (meta) meta.updatedAt = new Date().toISOString();
  return { ok: true };
}

/** True when a fan has any lifetime spins (unlocks chat). */
function chatUnlockedFor(fan: MockFan): boolean {
  return fan.spinsRemaining > 0 || fan.spinsGrantedTotal > 0;
}

/** RM-6: the fan's own play, as getFanPass's readPlayState builds it. */
function mockPlayState(fan: MockFan, now = Date.now()): FanPlayView {
  return {
    ...countPlay(fan.spinTimes ?? [], now),
    reminder: fan.playReminderDaily ?? null,
    breakUntil: isOnBreak(fan.breakUntil, now) ? fan.breakUntil ?? null : null,
  };
}

/** A fan's wishlist, newest first. */
function wishlistFor(fanId: string): WishlistItem[] {
  return store.wishlists
    .filter((w) => w.fanId === fanId)
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((w) => ({ id: w.id, prizeLabel: w.prizeLabel, rarity: w.prizeRarity, at: w.at }));
}

export async function mockGetFanPass(
  token: string
): Promise<FanPassView | null> {
  const fan = fanForToken(token);
  if (!fan) return null;
  // Parity with Supabase: self-exclusion deactivates the link entirely (the
  // real path filters is_active=true), so the paused page 404s, not just spins.
  if (fan.selfExcludedAt) return null;
  ensurePasses(fan);
  // Per-wheel: this token's pass decides the wheel + the balance shown.
  const pass = fan.passes.find((p) => p.token === token) ?? fan.passes[0];
  const wheelId = pass ? mockResolvedSpinWheelId(pass) : mockResolveWheelId({ campaignId: campaignForFan(fan) });
  const wheel = store.wheels.get(wheelId) ?? activeWheel();
  if (wheel.gameKind === "bingo" || wheel.gameReady === false) return null;
  // Commit-reveal: make sure this link holds a pre-committed seed for the next
  // spin and publish its hash on the page (commitment predates the spin).
  if (pass && !pass.nextServerSeedHash) {
    await withMockFanLock(fan.id, async () => {
      if (pass.nextServerSeedHash) return;
      const seed = pass.nextServerSeed ?? randomSeedHex();
      const hash = await sha256Hex(seed);
      if (!store.fans.has(fan.id) || fan.selfExcludedAt || fan.blockedAt) return;
      pass.nextServerSeed = seed; pass.nextServerSeedHash = hash;
    });
  }
  const modifierDisplay = mockFanFocusDisplay(token);
  return structuredClone({
    token,
    blocked: !!fan.blockedAt,
    fanName: fan.name,
    fanHandle: fan.handle ?? null,
    creatorTitle: CREATOR_TITLE,
    // Parity with the Supabase path: fan-safe projection (no prize costs).
    wheel: applyFocusStock(toPublicWheel(wheel), modifierDisplay.stock),
    spinsRemaining: pass?.spinsRemaining ?? fan.spinsRemaining,
    recentWins: fan.wins.slice(0, 50).map(win => ({ label: win.label, rarity: win.rarity, emoji: win.emoji, color: win.color,
      at: win.at, shareId: win.shareId, imageUrl: win.imageUrl, ...(win.instant ? { instant: true } : {}) })),
    wishlist: wishlistFor(fan.id),
    happyHour: mockGetActiveHappyHour(wheel.id),
    referral: { code: fan.referralCode, bonusPerReferral: REFERRAL_BONUS },
    chatUnlocked: chatUnlockedFor(fan),
    needsAck: fanNeedsAck(fan.ackedAt, fan.ackedTermsVersion),
    creatorId: "demo-creator",
    leaderboardEnabled: store.leaderboardEnabled,
    leaderboardOptIn: fan.leaderboardOptIn === true,
    creatorNote: "Hey you 😘 spin away — every spin wins!",
    creatorAvatarUrl: null,
    nextSpinHash: pass?.nextServerSeedHash ?? null,
    play: mockPlayState(fan),
    glow: mockFanGlow(fan),
    ...modifierDisplay,
  });
}

export const MAX_GAME_FIXTURE_ATTEMPTS = 1024;
/** Alters only the next committed demo seed, never a result, balance or card. */
export async function mockGameFixture(token: string, clientSeed: string, targetPrizeId: string): Promise<{ nextServerSeedHash: string; attempts: number } | { error: string }> {
  const found = passForToken(token);
  if (!found) return { error: "not_found" };
  return withMockFanLock(found.fan.id, async () => {
    const { fan, pass } = found;
    if (!store.fans.has(fan.id) || !fanEngagementAllowed({ blocked: !!fan.blockedAt, selfExcluded: !!fan.selfExcludedAt, breakUntil: fan.breakUntil })) return { error: "blocked" };
    if ([...mockFocusState().attempts.values()].some(attempt => attempt.fanId === fan.id && !attempt.finishedAt)) return { error: "spin_pending" };
    const wheel = store.wheels.get(mockResolvedSpinWheelId(pass));
    if (!wheel || wheel.gameReady === false || wheel.gameKind === "bingo") return { error: "game_unavailable" };
    const focusRow = mockFocusState().focuses.get(fan.id);
    const focus = focusRow && (focusRow.status === "active" || focusRow.status === "paused") ? toFanFocusView(focusRow) : null;
    const personal = structuredClone(wheel);
    if (focus?.kind === "chase" && focusRow?.reservation?.held) {
      const target = personal.prizes.find(prize => prize.id === focus.prizeId);
      if (target && typeof target.stock === "number") target.stock += 1;
    }
    const hh = mockGetActiveHappyHour(wheel.id);
    const options = { pityCounter: fan.pityCounter, happyHourMultiplier: hh.active ? hh.multiplier : null,
      ...(focus?.kind === "focus" ? { focus: { prizeId: focus.prizeId, multiplier: focus.multiplier, spinsLeft: focus.spinsLeft, totalSpins: focus.totalSpins } } : {}),
      ...(focus?.kind === "chase" ? { chase: { prizeId: focus.prizeId, counter: focus.chaseCounter, within: focus.chaseWithin, reserved: !!focusRow?.reservation?.held } } : {}) };
    let snapshot: PoolSnapshot | GamePoolSnapshot;
    try { snapshot = wheel.gameKind === "scratch" ? buildScratchPoolSnapshot(personal, options) : buildFocusPoolSnapshot(personal, options); } catch { return { error: "no_prizes" }; }
    const primary = snapshot.game === "scratch" ? primarySnapshot(snapshot as GamePoolSnapshot) : snapshot as PoolSnapshot;
    if (!(snapshotOdds(primary).rows.find(row => row.prize.id === targetPrizeId)?.chance ?? 0)) return { error: "target_unavailable" };
    const fingerprint = () => JSON.stringify([store.wheels.get(wheel.id), mockFocusState().focuses.get(fan.id), fan.pityCounter,
      fan.blockedAt, fan.selfExcludedAt, fan.breakUntil, pass.spinsRemaining, pass.nextSpinNonce, pass.nextServerSeedHash, fan.wins.length]);
    const before = fingerprint();
    const hash = snapshot.game === "scratch" ? await hashGamePoolSnapshot(snapshot as GamePoolSnapshot) : await hashPoolSnapshot(snapshot as PoolSnapshot);
    for (let attempts = 1; attempts <= MAX_GAME_FIXTURE_ATTEMPTS; attempts++) {
      const seed = randomSeedHex();
      const rng = snapshot.game === "scratch" ? await makeGameRngV3(seed, normalizeClientSeed(clientSeed), pass.nextSpinNonce ?? 0, hash) : await makeFairRngV3(seed, normalizeClientSeed(clientSeed), pass.nextSpinNonce ?? 0, hash);
      let selected: ReturnType<typeof drawFromSnapshot>;
      try { selected = drawFromSnapshot(snapshot.game === "scratch" ? primarySnapshot(snapshot as GamePoolSnapshot) : snapshot as PoolSnapshot, new Set(), rng); } catch { return { error: "no_prizes" }; }
      if (selected.prize.id !== targetPrizeId) continue;
      const nextHash = await sha256Hex(seed);
      if (fingerprint() !== before || !store.fans.has(fan.id)) return { error: "context_changed" };
      pass.nextServerSeed = seed; pass.nextServerSeedHash = nextHash;
      return { nextServerSeedHash: nextHash, attempts };
    }
    return { error: "target_unavailable" };
  });
}

type MockSpinSuccess = import("@/lib/games/wheel/types").SpinResult & { shareId: string; nextSpinHash: string };
export async function mockSpin(token: string, clientSeed = "", requestId: string = crypto.randomUUID(), publishedSeedHash?: string): Promise<MockSpinSuccess | import("./shared").SpinError> {
  requestId = requestId.toLowerCase();
  const found = passForToken(token);
  if (!found) return { error: "not_found" as const };
  // Hash inside the lock: async digests can finish out of order, and the lock
  // must be taken in call order so a simultaneous retry is the replay.
  return withMockFanLock(found.fan.id, async () => {
    const hash = await sha256Hex(JSON.stringify(["spin-attempt-v1", "wheel", clientSeed, publishedSeedHash?.toLowerCase() ?? null]));
    const state = mockFocusState();
    const existing = state.attempts.get(requestId);
    if (existing) {
      if (existing.token !== token || existing.hash !== hash) return { error: "db_error" as const };
      if (!existing.result) return { error: "spin_pending" as const };
      if ("error" in existing.result) return existing.result;
      const response = { ...structuredClone(existing.result), replayed: true, spinsRemaining: found.pass.spinsRemaining, nextSpinHash: found.pass.nextServerSeedHash!, ...mockFanFocusDisplay(token),
        play: countPlay(found.fan.spinTimes ?? []), reminderDue: reminderDue(countPlay(found.fan.spinTimes ?? []).today, found.fan.playReminderDaily ?? null) } as MockSpinSuccess;
      return mockRecordRewardDisclosures(token,response)?response:{error:"spin_pending" as const};
    }
    const attempt = { token, fanId: found.fan.id, hash, createdAt: new Date().toISOString() } as { token: string; fanId: string; hash: string; createdAt?: string; finishedAt?: string; result?: import("@/lib/games/wheel/types").SpinResult | import("./shared").SpinError };
    state.attempts.set(requestId, attempt);
    const result = await mockSpinLocked(token, clientSeed, requestId, publishedSeedHash);
    attempt.result = structuredClone(result);
    if (!("error" in result) || result.error !== "spin_pending") attempt.finishedAt = new Date().toISOString();
    return "error" in result || mockRecordRewardDisclosures(token,result)?result:{error:"spin_pending" as const};
  });
}

export async function mockReadSpinAttempt(token: string, intent: SpinIntent): Promise<SpinAttemptStatus> {
  const found = passForToken(token);
  if (!found) return { status: "unavailable" };
  // A break forbids new paid plays, while safe receipt/status reads remain available (SQL parity).
  if (found.fan.blockedAt || found.fan.selfExcludedAt) return { status: "unavailable" };
  const hash = await sha256Hex(JSON.stringify(["spin-attempt-v1", "wheel", normalizeClientSeed(intent.clientSeed), intent.publishedSeedHash?.toLowerCase() ?? null]));
  const attempt = mockFocusState().attempts.get(intent.requestId.toLowerCase());
  if (!attempt) return { status: "absent" };
  if (attempt.token !== token || attempt.hash !== hash) return { status: "conflict" };
  if (!attempt.result) return { status: "pending" };
  if ("error" in attempt.result) return {status:"declined",error:attempt.result.error};
  const result = { ...structuredClone(attempt.result), replayed: true, spinsRemaining: found.pass.spinsRemaining, nextSpinHash: found.pass.nextServerSeedHash!, ...mockFanFocusDisplay(token),
    play: countPlay(found.fan.spinTimes ?? []), reminderDue: reminderDue(countPlay(found.fan.spinTimes ?? []).today, found.fan.playReminderDaily ?? null) };
  return mockRecordRewardDisclosures(token,result)?{status:"committed",result}:{status:"pending"};
}

async function mockSpinLocked(token: string, clientSeed: string, requestId: string, publishedSeedHash?: string, contextTry = 0): Promise<MockSpinSuccess | import("./shared").SpinError> {
  const found = passForToken(token);
  if (!found) {
    // Legacy fan with no pass row yet — backfill then retry resolution.
    const f = fanForToken(token);
    if (!f) return { error: "not_found" as const };
    ensurePasses(f);
  }
  const ctx = passForToken(token);
  if (!ctx) return { error: "not_found" as const };
  const { fan, pass } = ctx;
  // Mirror the hardened claim_spin guards so the demo behaves like production:
  // a self-excluded fan can't spin, and the age-gate/ToS must be acknowledged
  // first (the client modal is not the enforcement boundary).
  if (fan.selfExcludedAt || fan.blockedAt) return { error: "blocked" as const };
  if (fanNeedsAck(fan.ackedAt, fan.ackedTermsVersion)) return { error: "needs_ack" as const };
  // RM-6: claim_spin refuses a fan on a break (migration 0049).
  if (!fanEngagementAllowed({ breakUntil: fan.breakUntil })) return { error: "on_break" as const };

  // Pre-generate the NEXT commitment before touching shared state, so the
  // claim + seed consumption below has no `await` inside it: in single-threaded
  // JS that makes it atomic, mirroring claim_spin's row lock + the guarded seed
  // swap on the Supabase path. (Awaiting between the read and the rotation let
  // two concurrent spins consume the same committed seed.)
  const nextServerSeed = randomSeedHex();
  const nextServerSeedHash = await sha256Hex(nextServerSeed);

  // Per-wheel: spend only THIS pass's balance, on THIS pass's wheel.
  if (pass.spinsRemaining <= 0) return { error: "no_spins" as const };
  // Provably-fair commit-reveal: consume the seed pre-committed on this pass
  // (its hash was already shown to the fan) and rotate so the next spin is
  // committed too — mirroring the Supabase path.
  const committedSeed = pass.nextServerSeed;
  const committedHash = pass.nextServerSeedHash;
  const serverSeed = committedSeed ?? randomSeedHex();
  // No CAS loser here (the claim + swap below is synchronous), so a seed is
  // either the one the page showed or generated right now.
  const commitment: SeedCommitment = committedSeed && committedHash ? publishedSeedHash?.toLowerCase() === committedHash.toLowerCase() ? "published" : "stored" : "fresh";
  // All spending/seed writes wait until the validated draw can commit.
  // Same basis as the Supabase path: claim_spin returns THIS pass's balance
  // after the decrement, and that is the spin's nonce.
  const nonce = pass.nextSpinNonce ?? 0;

  const wheelId = mockResolvedSpinWheelId(pass);
  const wheel = store.wheels.get(wheelId) ?? activeWheel();

  // Fairness v3, same derivation as the Supabase path: snapshot the effective
  // pool (happy hour applied, sold-out prizes left out) with the fan's pity
  // state, and mix its hash into the RNG with the fan's clientSeed.
  const hh = mockGetActiveHappyHour(wheel.id);
  const focusRow = mockFocusState().focuses.get(fan.id);
  const focus = focusRow && (focusRow.status === "active" || focusRow.status === "paused") ? toFanFocusView(focusRow) : null;
  const personalWheel = structuredClone(wheel);
  if (focus?.kind === "chase" && focusRow?.reservation?.held) {
    const target = personalWheel.prizes.find(p => p.id === focus.prizeId);
    if (target && typeof target.stock === "number") target.stock += 1;
  }
  const gameKind = wheel.gameKind ?? "wheel";
  if (gameKind === "bingo" || wheel.gameReady === false) return { error: "no_prizes" as const };
  const options = {
    happyHourMultiplier: hh.active ? hh.multiplier : null,
    pityCounter: fan.pityCounter,
    ...(focus?.kind === "focus" ? { focus: { prizeId: focus.prizeId, multiplier: focus.multiplier, spinsLeft: focus.spinsLeft, totalSpins: focus.totalSpins } } : {}),
    ...(focus?.kind === "chase" ? { chase: { prizeId: focus.prizeId, counter: focus.chaseCounter, within: focus.chaseWithin, reserved: !!focusRow?.reservation?.held } } : {}),
  };
  let snapshot: PoolSnapshot | GamePoolSnapshot;
  try { snapshot = gameKind === "scratch" ? buildScratchPoolSnapshot(personalWheel, options) : buildFocusPoolSnapshot(personalWheel, options); } catch { return { error: "no_prizes" as const }; }
  const gameSnapshot = snapshot.game === "scratch" ? snapshot as GamePoolSnapshot : null;
  const v3 = NEW_SPIN_FAIR_VERSION === 3;
  const contextFingerprint = () => {
    const currentWheel = store.wheels.get(wheel.id);
    const currentFocus = mockFocusState().focuses.get(fan.id);
    const target = currentWheel?.prizes.find(prize => prize.id === currentFocus?.prize_id);
    const targetAvailable = currentFocus ? !!target && (currentFocus.reservation?.held || target.stock == null || target.stock > 0) : null;
    return JSON.stringify([currentWheel ? { ...currentWheel, prizes: currentWheel.prizes.map(prize => ({ ...prize, stock: undefined })) } : null,
      fan.pityCounter, pass.nextServerSeed, pass.nextSpinNonce ?? 0, pass.spinsRemaining, currentFocus ?? null, targetAvailable]);
  };
  const expectedContext = contextFingerprint();
  const poolHash = gameSnapshot ? await hashGamePoolSnapshot(gameSnapshot) : await hashPoolSnapshot(snapshot as PoolSnapshot);
  const serverSeedHash =
    committedSeed && committedHash ? committedHash : await sha256Hex(serverSeed);
  const rng = gameSnapshot ? await makeGameRngV3(serverSeed, clientSeed, nonce, poolHash) : v3
    ? await makeFairRngV3(serverSeed, clientSeed, nonce, poolHash)
    : await makeFairRng(serverSeed, clientSeed, nonce);

  if (contextFingerprint() !== expectedContext) {
    if (contextTry >= 8) return { error: "spin_pending" as const };
    return mockSpinLocked(token, clientSeed, requestId, publishedSeedHash, contextTry + 1);
  }
  // A moderation action during hashing cannot authorize a spend from stale state.
  if (fan.selfExcludedAt || fan.blockedAt) return { error: "blocked" as const };
  if (!fanEngagementAllowed({ breakUntil: fan.breakUntil })) return { error: "on_break" as const };
  if (!store.fans.has(fan.id)) return { error: "not_found" as const };

  // Draw + take stock with no `await` in between: in single-threaded JS that
  // is atomic, the mock mirror of the Supabase path's stock compare-and-swap.
  // A limited prize another spin sold out after the snapshot was taken is
  // excluded and re-drawn, and the exclusion recorded, exactly as there.
  let chosen: {
    live: Prize;
    shown: PublicPrize;
    index: number;
    pityAwarded: boolean;
    nextPityCounter: number;
    reward: { kind: RewardKind; value: string; code?: MockCode } | null;
    focusConsumed?: boolean; chaseConsumed?: boolean; chaseCompleted?: boolean; chaseAwarded?: boolean;
    nextFocusSpinsLeft?: number | null; nextChaseCounter?: number | null;
  } | null = null;
  const excluded = new Set<string>();
  const excludedOrder: string[] = [];
  let gamePresentation: GamePresentation | undefined;
  let gameTrace: GameTrace | undefined;
  try {
    for (let attempt = 0; attempt < snapshot.prizes.length + 1; attempt++) {
      const draw = drawFromSnapshot(gameSnapshot ? primarySnapshot(gameSnapshot) : snapshot as PoolSnapshot, excluded, rng);
      const index = wheel.prizes.findIndex((p) => p.id === draw.prize.id);
      const live = wheel.prizes[index];
      // #26: an instant prize that can't be delivered right now (no code
      // left, no reward set) counts as sold out, exactly as on Supabase.
      const ownReserved = live && focusRow?.prize_id === live.id && focusRow.reservation?.held ? focusRow.reservation : null;
      const available = live && (ownReserved || live.stock == null || live.stock > 0) && mockRewardAvailable(live, ownReserved?.codeId);
      if (available && gameSnapshot) {
        // Validate the full cosmetic result before touching inventory. No await
        // occurs until the credit/stock/proof receipt have committed together.
        const played = finishGame(gameSnapshot, draw, { excluded: [...excludedOrder], won: live.id }, rng);
        gamePresentation = played.presentation; gameTrace = played.trace;
      }
      const take = available ? mockTakeReward(live, ownReserved?.codeId) : null;
      if (live && take?.ok) {
        // As read before the decrement, like the Supabase path's response.
        const shown = structuredClone(toPublicPrize(live, { showStock: showsStock(wheel) }));
        // Decrement limited stock on the RESOLVED wheel so rare prizes can sell
        // out; a code prize's stock is its unused codes (one was just taken).
        if (live.delivery === "codes") syncMockPrizeDelivery(live);
        else if (typeof live.stock === "number" && !ownReserved) live.stock -= 1;
        if (ownReserved) ownReserved.held = false;
        chosen = { ...draw, live, shown, index, reward: take.reward };
        break;
      }
      excluded.add(draw.prize.id);
      excludedOrder.push(draw.prize.id);
    }
  } catch {
    // Nothing left to draw: handled below.
  }
  if (!chosen) {
    // Every prize sold out: refund the claimed spin (parity with the Supabase
    // path's rollback_claimed_spin) instead of charging the fan for nothing.
    return { error: "no_prizes" as const };
  }
  const { live: prize, shown, index, pityAwarded, nextPityCounter, reward } = chosen;

  // Per-wheel: the spin belongs to THIS pass's campaign directly.
  const campaignId = pass.campaignId;

  wheel.gameKindLocked = true;
  pass.nextServerSeed = nextServerSeed;
  pass.nextServerSeedHash = nextServerSeedHash;
  pass.spinsRemaining -= 1;
  pass.nextSpinNonce = nonce + 1;
  recomputeFanAggregate(fan);
  fan.pityCounter = nextPityCounter;
  if (focusRow && focus) {
    if (chosen.nextFocusSpinsLeft != null) focusRow.spins_left = chosen.nextFocusSpinsLeft;
    if (chosen.nextChaseCounter != null) focusRow.chase_counter = chosen.nextChaseCounter;
    focusRow.status = chosen.chaseCompleted || focusRow.spins_left === 0 ? "completed" : "active";
    focusRow.version = (focusRow.version ?? 0) + 1;
    focusRow.ended_at = focusRow.status === "completed" ? new Date().toISOString() : null;
    const proof = snapshot.modifiers.focus ?? snapshot.modifiers.chase;
    focusRow.pause_reason = proof?.pauseReason ?? null;
    if (focusRow.status === "active" && proof?.pauseReason) focusRow.status = "paused";
  }
  // RM-6: log the spin time for the rolling counts (a week is all they need).
  const spunAt = Date.now();
  fan.spinTimes = [...(fan.spinTimes ?? []).filter((t) => spunAt - Date.parse(t) < PLAY_WEEK_WINDOW_MS), new Date(spunAt).toISOString()];
  const play = countPlay(fan.spinTimes, spunAt);
  // Spinning must NOT touch `leaderboardOptIn` — appearing on the creator's
  // public leaderboard is the fan's own explicit choice (the toggle on their
  // spin page). Mirrors the same fix in ./index.ts's spin().

  // Record the win on the fan account (persists across all their links).
  const at = new Date().toISOString();
  const shareId = genId("share");
  fan.wins = [
    {
      label: prize.label,
      rarity: prize.rarity,
      emoji: prize.emoji,
      color: prize.color ?? RARITY_COLORS[prize.rarity],
      at,
      campaignId,
      shareId,
      imageUrl: prize.imageUrl ?? null,
      serverSeed,
      serverSeedHash,
      nonce,
      clientSeed: clientSeed || null,
      commitment,
      prizeId: prize.id,
      wheelId: wheel.id, gameKind, ...(gamePresentation ? { presentation: gamePresentation } : {}),
      ...(reward ? { instant: true } : {}),
      ...(v3
        ? {
            fairVersion: 3,
            poolSnapshot: snapshot,
            poolHash,
            fairTrace: gameTrace ?? { excluded: excludedOrder, won: prize.id },
          }
        : {}),
    },
    ...fan.wins,
  ];

  // Add it to the creator's fulfilment queue (with fan + campaign attribution).
  // #26: an instant reward is delivered right here, so its row is fulfilled.
  if (reward) mockRecordDelivery(shareId, fan.id, reward, at, prize);
  store.redemptions.unshift({
    gameKind,
    id: "r-" + Math.random().toString(36).slice(2, 10),
    fanName: fan.name,
    prizeLabel: prize.label,
    rarity: prize.rarity,
    emoji: prize.emoji,
    status: reward ? "fulfilled" : "pending",
    at,
    fanId: fan.id,
    campaignId,
    shareId,
    ...(chosen.focusConsumed ? { focusKind: "focus" as const } : chosen.chaseConsumed ? { focusKind: "chase" as const, chaseAwarded: chosen.chaseAwarded === true } : {}),
  });

  // RM-2: the projection follows the wheel's "Show stock to fans" switch, and
  // the live map (read after the decrement above) lets the page update counts.
  const showStock = showsStock(wheel);
  return {
    ...(gamePresentation ? { gameKind, presentation: gamePresentation, bonusWins: [] } : {}),
    attemptId: requestId,
    awardedAt: at,
    ...mockFanFocusDisplay(token),
    focusConsumed: chosen.focusConsumed ?? false, chaseConsumed: chosen.chaseConsumed ?? false,
    chaseCompleted: chosen.chaseCompleted ?? false, chaseAwarded: chosen.chaseAwarded ?? false,
    prize: shown,
    prizeIndex: index,
    ...(hasLimitedPrize(wheel.prizes) ? { stock: toPublicStockMap(wheel.prizes, showStock) } : {}),
    // Per-wheel: report THIS pass's remaining balance (not the fan aggregate),
    // so the spin page shows the right count for the wheel being played.
    spinsRemaining: pass.spinsRemaining,
    pityAwarded,
    shareId,
    // THIS spin's rotation (not whatever a concurrent spin left on the pass).
    nextSpinHash: nextServerSeedHash,
    ...(v3 ? { fairVersion: 3 as const, poolHash } : {}),
    // #26: only this winner's own response carries the value.
    ...(reward ? { reward: { kind: reward.kind, value: reward.value } } : {}),
    // RM-6: the fan's fresh counts, and whether they have reached their reminder.
    play,
    reminderDue: reminderDue(play.today, fan.playReminderDaily ?? null),
  };
}

/**
 * Create a link. With no fanId, creates a NEW fan account. With an existing
 * fanId, mints a fresh link for that SAME account (history + balance kept) and
 * adds the granted spins on top.
 */
export function mockCreatePass(name: string, spins: number, fanId?: string, campaignId?: string, amountCents?: number,
  bonusSpins?: number, packId?: string, referralCode?: string, wheelId?: string, requestId = crypto.randomUUID(), packUnits = 1): { token: string; fanId: string } {
  requestId = requestId.toLowerCase();
  const requests = mockFocusState().passRequests ??= new Map();
  const hash = serverCreatorIntentHash("pass", [name.trim(),spins,fanId ?? null,campaignId ?? null,amountCents ?? 0,bonusSpins ?? 0,packId ?? null,referralCode ?? null,wheelId ?? null,packUnits]);
  const gate = beginMockCreatorRequest(requestId, "pass", hash, fanId ? { fanId } : {});
  if (gate !== "ready" && gate !== "committed") throw new Error(gate);
  const prior = requests.get(requestId);
  if (prior) {
    if (prior.hash !== hash) throw new Error("conflict");
    const fan = prior.fanId ? store.fans.get(prior.fanId) : null;
    const pass = fan?.passes.find(pass => mockPassId(pass) === prior.passId);
    if (prior.erased || !fan || !pass) throw new Error("gone");
    return { token: pass.token, fanId: fan.id };
  }
  if (gate === "committed") throw new Error("gone");
  const checkpoint = mockEconomicCheckpoint();
  try {
    const result = mockCreatePassOnce(name, spins, fanId, campaignId, amountCents, bonusSpins, packId, referralCode, wheelId, packUnits);
    const pass = passForToken(result.token)?.pass;
    const grant = store.grants.at(-1);
    if (!pass || !grant) throw new Error("incomplete_grant");
    const passId = mockPassId(pass);
    requests.set(requestId, { hash, fanId: result.fanId, passId });
    finishMockCreatorRequest(requestId, "committed", { fanId: result.fanId, passId, grantId: grant.id });
    return result;
  } catch (error) {
    restoreMockEconomicCheckpoint(checkpoint);
    if (error instanceof Error && ["invalid_pack", "fan_not_found", "blocked", "on_break"].includes(error.message)) finishMockCreatorRequest(requestId, "rejected");
    throw error;
  }
}

function mockCreatePassOnce(
  name: string,
  spins: number,
  fanId?: string,
  campaignId?: string,
  amountCents?: number,
  bonusSpins?: number,
  packId?: string,
  referralCode?: string,
  wheelId?: string,
  packUnits = 1
): { token: string; fanId: string } {
  if (!Number.isInteger(packUnits) || packUnits < 1 || packUnits > 1_000_000 || (!packId && packUnits !== 1)) throw new Error("invalid_pack");
  // If a pack is supplied, its spins/amount/bonus are authoritative.
  let baseSpins = spins;
  let money = Math.max(0, Math.floor(amountCents ?? 0) || 0);
  let bonus = Math.max(0, Math.floor(bonusSpins ?? 0) || 0);
  if (packId) {
    const pack = store.campaignPacks.find((p) => p.id === packId);
    if (!pack) throw new Error("invalid_pack");
    if (pack) {
      if (pack.packKind && pack.packKind !== "spins") throw new Error("invalid_pack");
      baseSpins = pack.spins * packUnits;
      money = pack.amountCents * packUnits;
      bonus = pack.bonusSpins * packUnits;
      if (!Number.isSafeInteger(baseSpins + bonus) || baseSpins + bonus > 1_000_000 || !Number.isSafeInteger(money) || money > 100_000_000) throw new Error("invalid_pack");
    }
  }

  // Effective spins added = paid spins + bonus spins.
  const paid = Math.max(0, Math.floor(baseSpins) || 0);
  const add = paid + bonus;
  const fan = fanId ? store.fans.get(fanId) : undefined;
  if (fanId && !fan) throw new Error("fan_not_found");
  if (fan && !fanEngagementAllowed({ blocked: !!fan.blockedAt, selfExcluded: !!fan.selfExcludedAt, breakUntil: fan.breakUntil })) {
    throw new Error(fan.blockedAt || fan.selfExcludedAt ? "blocked" : "on_break");
  }

  const requestedWheel = wheelId ? store.wheels.get(wheelId) : null;
  if (wheelId && (!requestedWheel || requestedWheel.archivedAt || requestedWheel.gameReady === false || requestedWheel.gameKind === "bingo")) throw new Error("no_wheel");
  const resolved = store.wheels.get(mockResolveWheelId({ campaignId: campaignId ?? null, wheelId }));
  if (!resolved || resolved.archivedAt || resolved.gameReady === false || resolved.gameKind === "bingo") throw new Error("no_wheel");

  // Credit a pending referral once, idempotently, when this grant is the fan's
  // first PAID grant (money > 0) and the referrer is still under the cap.
  const maybeCreditReferral = (creditedFan: MockFan, grantMoney: number) => {
    if (grantMoney <= 0) return; // only paid grants trigger credit
    if (creditedFan.referralCredited) return; // already credited (idempotent)
    if (!creditedFan.referredByFanId) return; // not referred by anyone
    const row = store.referrals.find(
      (r) => r.referredFanId === creditedFan.id && r.creditedAt === null
    );
    if (!row) return;
    const referrer = store.fans.get(creditedFan.referredByFanId);
    if (!referrer) return;
    // Enforce the cap on the REFERRER's credited referrals.
    const creditedForReferrer = store.referrals.filter(
      (r) => r.referrerFanId === referrer.id && r.creditedAt !== null
    ).length;
    if (creditedForReferrer >= REFERRAL_CAP) return;
    // Award both fans + mark credited. The bonus lands on each fan's oldest
    // pass (spendable) rather than only the aggregate — otherwise the aggregate
    // would inflate above the true pass-sum and snap back down on the next spin.
    creditSpinsToOldestPass(referrer, REFERRAL_BONUS);
    creditSpinsToOldestPass(creditedFan, REFERRAL_BONUS);
    row.bonusSpins = REFERRAL_BONUS;
    row.creditedAt = new Date().toISOString();
    creditedFan.referralCredited = true;
  };

  const pushGrant = (id: string, passToken: string) => {
    store.grants.push({
      id: genId("g"),
      fanId: id,
      passToken,
      campaignId: campaignId ?? null,
      spins: add,
      amountCents: money,
      bonusSpins: bonus,
      at: new Date().toISOString(),
    });
  };

  if (!fan) {
    // New fan: create with a single minted token as the permanent link.
    const id = "fan-" + Math.random().toString(36).slice(2, 9);
    const token =
      ((name.trim() || "fan").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "fan") +
      "-" +
      Math.random().toString(36).slice(2, 8);

    // Resolve a referrer from the supplied code (cannot self-refer; the fan
    // doesn't exist yet so self-referral is impossible here, but guard anyway).
    let referredByFanId: string | null = null;
    const code = referralCode?.trim();
    if (code) {
      const referrer = Array.from(store.fans.values()).find(
        (f) => f.referralCode === code
      );
      if (referrer && referrer.id !== id) referredByFanId = referrer.id;
    }

    const newWheelId = mockResolveWheelId({ campaignId: campaignId ?? null, wheelId });
    const newFan: MockFan = {
      id,
      name: name.trim() || "Fan",
      spinsRemaining: add,
      spinsGrantedTotal: add,
      primaryToken: token,
      passes: [
        {
          token,
          wheelId: newWheelId,
          campaignId: campaignId ?? null,
          spinsRemaining: add,
          spinsGrantedTotal: add,
          createdAt: new Date().toISOString(),
        },
      ],
      wins: [],
      notes: null,
      tags: [],
      pityCounter: 0,
      leaderboardOptIn: false,
      referralCode: genId("ref"),
      referredByFanId,
      referralCredited: false,
      ackedAt: null,
      ackedTermsVersion: null,
      selfExcludedAt: null,
    };
    store.fans.set(id, newFan);
    store.tokens.set(token, id);
    if (campaignId) store.tokenCampaign.set(token, campaignId);

    // Record an (uncredited) referral row linking referrer → this new fan.
    if (referredByFanId) {
      store.referrals.push({
        id: genId("rfl"),
        referrerFanId: referredByFanId,
        referredFanId: id,
        bonusSpins: 0,
        creditedAt: null,
        at: new Date().toISOString(),
      });
    }

    pushGrant(id, token);
    maybeCreditReferral(newFan, money);
    return { token, fanId: id };
  }

  // Existing fan (top-up): per-wheel — find this fan's pass for the target wheel
  // and top it up, or mint a NEW per-wheel link if they don't have one yet.
  ensurePasses(fan);
  const targetWheel = mockResolveWheelId({ campaignId: campaignId ?? null, wheelId });
  let pass = fan.passes.find((p) => p.wheelId === targetWheel);
  let tokenOut: string;
  if (pass) {
    pass.spinsRemaining += add;
    pass.spinsGrantedTotal += add;
    if (campaignId) pass.campaignId = campaignId;
    tokenOut = pass.token;
  } else {
    tokenOut =
      ((name.trim() || fan.name || "fan").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "fan") +
      "-" +
      Math.random().toString(36).slice(2, 8);
    pass = {
      token: tokenOut,
      wheelId: targetWheel,
      campaignId: campaignId ?? null,
      spinsRemaining: add,
      spinsGrantedTotal: add,
      createdAt: new Date().toISOString(),
    };
    fan.passes.push(pass);
    store.tokens.set(tokenOut, fan.id);
  }
  recomputeFanAggregate(fan);
  pushGrant(fan.id, tokenOut);
  maybeCreditReferral(fan, money);
  if (campaignId) store.tokenCampaign.set(tokenOut, campaignId);
  return { token: tokenOut, fanId: fan.id };
}

/** Top up spins on the per-wheel pass behind a token; returns that pass's balance. */
export function mockGrantSpins(token: string, n: number, requestId = crypto.randomUUID()) {
  requestId = requestId.toLowerCase();
  const hash = serverCreatorIntentHash("grant", [token,n]);
  const gate = beginMockCreatorRequest(requestId, "grant", hash);
  if (gate !== "ready" && gate !== "committed") throw new Error(gate);
  const found = passForToken(token);
  if (!found) { finishMockCreatorRequest(requestId, "rejected"); return null; }
  const requests = mockFocusState().topupRequests ??= new Map();
  const previous = requests.get(requestId);
  if (previous) {
    if (previous.hash !== hash) throw new Error("conflict");
    return found.pass.spinsRemaining;
  }
  if (gate === "committed") throw new Error("gone");
  if (!fanEngagementAllowed({ blocked: !!found.fan.blockedAt, selfExcluded: !!found.fan.selfExcludedAt, breakUntil: found.fan.breakUntil })) { finishMockCreatorRequest(requestId, "rejected"); return null; }
  const checkpoint = mockEconomicCheckpoint();
  try {
    const add = Math.max(0, n);
    found.pass.spinsRemaining += add; found.pass.spinsGrantedTotal += add; recomputeFanAggregate(found.fan);
    const passId = mockPassId(found.pass);
    store.grants.push({ id: requestId, fanId: found.fan.id, passToken: token, campaignId: found.pass.campaignId, spins: add, bonusSpins: 0, amountCents: 0, at: new Date().toISOString() });
    requests.set(requestId, { hash, fanId: found.fan.id });
    finishMockCreatorRequest(requestId, "committed", { fanId: found.fan.id, passId, grantId: requestId });
    return found.pass.spinsRemaining;
  } catch (error) { restoreMockEconomicCheckpoint(checkpoint); throw error; }
}

/**
 * Delete a fan's personal data and links, including visits and outreach.
 * Retain anonymized wins and redemptions for fulfilment and accounting.
 * Returns false if the fan doesn't exist.
 */
export function mockDeleteFan(fanId: string): boolean {
  if (!store.fans.has(fanId)) return false;
  mockCancelFanFocus(fanId);
  const anonymous = mockFocusState().anonymousWins ??= new Map();
  for (const win of store.fans.get(fanId)!.wins) anonymous.set(win.shareId, structuredClone(win));
  eraseMockFocusIdentity(fanId);
  eraseMockCreatorRequestFan(fanId);
  mockEraseFanRewards(fanId);
  store.fans.delete(fanId);
  for (const [token, id] of store.tokens) {
    if (id === fanId) {
      store.tokens.delete(token);
      store.tokenCampaign.delete(token);
    }
  }
  // Parity with the database (0054): links, grants, chat, wishlist and
  // referrals go with the fan; their spins stay anonymized, so their prizes
  // stay in the fulfilment queue and stats as "Fan" with no link to them.
  store.grants = store.grants.filter((g) => g.fanId !== fanId);
  checkinStore().delete(fanId); // fan_checkins cascades with the fan
  clearOutreach(fanId);
  store.messages = store.messages.filter((m) => m.fanId !== fanId);
  store.wishlists = store.wishlists.filter((w) => w.fanId !== fanId);
  store.referrals = store.referrals.filter(
    (r) => r.referrerFanId !== fanId && r.referredFanId !== fanId
  );
  for (const f of store.fans.values()) {
    if (f.referredByFanId === fanId) f.referredByFanId = null;
  }
  for (const r of store.redemptions) {
    if (r.fanId === fanId) {
      r.fanId = "";
      r.fanName = "Fan";
    }
  }
  return true;
}

export function mockListFans(): FanAccountSummary[] {
  const tokensByFan = new Map<string, string[]>();
  for (const [token, fanId] of store.tokens) {
    (tokensByFan.get(fanId) ?? tokensByFan.set(fanId, []).get(fanId)!).push(token);
  }
  const campaignName = new Map(store.campaigns.map((c) => [c.id, c.name]));

  return Array.from(store.fans.values()).map((f) => {
    ensurePasses(f);
    const grants = fanGrants(f.id);
    const totalSpent = grants.reduce((s, g) => s + g.amountCents, 0);
    const campaignNames: string[] = [];
    const seen = new Set<string>();
    for (const g of grants) {
      if (g.campaignId === null) continue;
      const name = campaignName.get(g.campaignId);
      if (name && !seen.has(g.campaignId)) {
        seen.add(g.campaignId);
        campaignNames.push(name);
      }
    }
    const passes = f.passes.map((p) => ({
      token: p.token,
      wheelId: p.wheelId,
      wheelTitle: store.wheels.get(p.wheelId)?.title ?? "Wheel",
      campaignId: p.campaignId ?? null,
      campaignName: p.campaignId ? campaignName.get(p.campaignId) ?? null : null,
      spinsRemaining: p.spinsRemaining,
    }));
    return {
      fanId: f.id,
      name: f.name,
      spinsRemaining: f.spinsRemaining,
      grantedTotal: f.spinsGrantedTotal,
      primaryToken: f.primaryToken,
      totalSpent,
      campaignNames,
      tags: f.tags ?? [],
      links: (tokensByFan.get(f.id) ?? []).map((token) => ({ token })),
      passes,
      lastWin: f.wins[0]
        ? { label: f.wins[0].label, rarity: f.wins[0].rarity, at: f.wins[0].at }
        : null,
      blocked: !!f.blockedAt,
      selfExcluded: !!f.selfExcludedAt,
      // Self-exclusion pauses the fan's links (mockGetFanPass 404s them), so a
      // paused fan has no active link. Otherwise: the newest pass, as on the
      // Supabase path (ties go to the later-created pass).
      activeToken: f.selfExcludedAt
        ? null
        : ([...f.passes].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.token ?? null),
      // RM-6: only the break state, never the fan's reminder or counts.
      breakUntil: isOnBreak(f.breakUntil) ? f.breakUntil ?? null : null,
      visits7: visitsLast7(checkinDays(f.id), new Date()),
    };
  });
}

export function mockGetFanDetail(fanId: string): FanDetail | null {
  const fan = store.fans.get(fanId);
  if (!fan) return null;

  const rarityCounts = new Map<Rarity, number>();
  for (const w of fan.wins) {
    rarityCounts.set(w.rarity, (rarityCounts.get(w.rarity) ?? 0) + 1);
  }
  const winsByRarity = [...rarityCounts.entries()].map(([rarity, count]) => ({
    rarity,
    count,
  }));

  const grantedTotal = fan.spinsGrantedTotal;

  // Pending prizes: the mock store has no spin/fan_id link on redemptions, so we
  // match by fan NAME. Two fans sharing a name would collide here.
  const pendingPrizes = store.redemptions
    .filter((r) => r.fanName === fan.name && r.status === "pending")
    .map((r) => ({
      label: r.prizeLabel,
      rarity: r.rarity,
      emoji: r.emoji,
      at: r.at,
    }));

  // Links: every token pointing at this fan. The mock doesn't record link
  // creation time, so createdAt is a stable epoch placeholder.
  const links = Array.from(store.tokens.entries())
    .filter(([, id]) => id === fanId)
    .map(([token]) => ({ token, createdAt: new Date(0).toISOString() }));

  const campaignName = new Map(store.campaigns.map((c) => [c.id, c.name]));
  const myGrants = fanGrants(fanId);
  const totalSpent = myGrants.reduce((s, g) => s + g.amountCents, 0);

  // Grants newest-first, with campaign name resolved and the balance of the
  // pass an edit would move (mockEditGrant uses the same grantEditPass).
  const grants: Grant[] = myGrants
    .slice()
    .reverse()
    .map((g) => {
      const pass = grantEditPass(fan, g);
      return {
        id: g.id,
        spins: g.spins,
        amountCents: g.amountCents,
        campaignId: g.campaignId,
        campaignName: g.campaignId ? campaignName.get(g.campaignId) ?? null : null,
        at: g.at,
        editPass: pass
          ? { spinsRemaining: pass.spinsRemaining, wheelTitle: store.wheels.get(pass.wheelId)?.title ?? null }
          : null,
      };
    });

  // Per-campaign breakdown: grant rollups (spinsBought, spentCents) merged with
  // spins attributed to each campaign (spinsPlayed + prizes from win records).
  // The bucket key is the campaignId, or "" for null-campaign grants/spins.
  interface Bucket {
    campaignId: string;
    name: string;
    spinsBought: number;
    spinsPlayed: number;
    spentCents: number;
    prizeCounts: Map<string, { label: string; rarity: Rarity; count: number }>;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (campaignId: string | null): Bucket => {
    const key = campaignId ?? "";
    let b = buckets.get(key);
    if (!b) {
      b = {
        campaignId: key,
        name: campaignId ? campaignName.get(campaignId) ?? "Uncategorized" : "Uncategorized",
        spinsBought: 0,
        spinsPlayed: 0,
        spentCents: 0,
        prizeCounts: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const g of myGrants) {
    const b = bucketFor(g.campaignId);
    b.spinsBought += g.spins;
    b.spentCents += g.amountCents;
  }
  for (const w of fan.wins) {
    const b = bucketFor(w.campaignId);
    b.spinsPlayed += 1;
    const cur = b.prizeCounts.get(w.label);
    if (cur) cur.count += 1;
    else b.prizeCounts.set(w.label, { label: w.label, rarity: w.rarity, count: 1 });
  }

  const byCampaign: FanCampaignBreakdown[] = [...buckets.values()].map((b) => ({
    campaignId: b.campaignId,
    name: b.name,
    spinsBought: b.spinsBought,
    spinsPlayed: b.spinsPlayed,
    spentCents: b.spentCents,
    prizes: [...b.prizeCounts.values()],
  }));

  return {
    fanId: fan.id,
    name: fan.name,
    blocked: !!(fan as { blockedAt?: string | null }).blockedAt,
    breakUntil: isOnBreak(fan.breakUntil) ? fan.breakUntil ?? null : null,
    notes: fan.notes ?? null,
    tags: fan.tags ?? [],
    spinsRemaining: fan.spinsRemaining,
    grantedTotal,
    totalSpins: fan.wins.length,
    totalSpent,
    lastActive: fan.wins[0]?.at ?? null,
    winsByRarity,
    pendingPrizes,
    links,
    grants,
    byCampaign,
    visits7: visitsLast7(checkinDays(fan.id), new Date()),
  };
}

/** Patch a fan's notes and/or tags in place. */
export function mockUpdateFanMeta(
  fanId: string,
  patch: { notes?: string | null; tags?: string[] }
): { ok: true } | { error: string } {
  const fan = store.fans.get(fanId);
  if (!fan) return { error: "not_found" };
  if ("notes" in patch) fan.notes = patch.notes ?? null;
  if (patch.tags) fan.tags = patch.tags;
  return { ok: true };
}

export function mockGetOverview(): CreatorOverview {
  const redemptions = store.redemptions;
  const revenue = store.grants.reduce((s, g) => s + g.amountCents, 0);
  // Map internal redemptions back to plain RedemptionItem (drop fanId/campaignId).
  const items: RedemptionItem[] = redemptions.slice(0, 200).map((r) => ({
    id: r.id,
    fanName: r.fanName,
    prizeLabel: r.prizeLabel,
    rarity: r.rarity,
    emoji: r.emoji,
    status: r.status,
    at: r.at,
    notes: r.notes ?? null,
    dueAt: r.dueAt ?? null,
    ...((r.auto ?? mockAutoInfo(r.shareId)) ? { auto: r.auto ?? mockAutoInfo(r.shareId) } : {}),
  }));
  const unreadMessages = store.messages.filter(
    (m) => m.sender === "fan" && m.readAt === null
  ).length;
  // Mirror getOverview: built = saved an edit (updatedAt past createdAt) or has
  // more than the single bootstrap wheel.
  const liveWheels = [...store.wheels.values()].filter((w) => !w.archivedAt);
  const wheelBuilt =
    liveWheels.length > 1 ||
    liveWheels.some((w) => {
      const m = wheelMeta.get(w.id);
      return m
        ? new Date(m.updatedAt).getTime() - new Date(m.createdAt).getTime() > 1500
        : false;
    });
  return {
    gamePlays: { wheel: redemptions.filter(row => !row.gameKind || row.gameKind === "wheel").length, scratch: redemptions.filter(row => row.gameKind === "scratch").length, bingo: 0 },
    metrics: {
      fans: store.fans.size,
      spinsPlayed: redemptions.length,
      pending: redemptions.filter((r) => r.status === "pending").length,
      fulfilled: redemptions.filter((r) => r.status === "fulfilled").length,
      revenue,
      unreadMessages,
      leaderboardEnabled: store.leaderboardEnabled,
      wheelBuilt,
      // Oldest pending across ALL redemptions, not just the 200-row display slice.
      oldestPendingAt:
        redemptions
          .filter((r) => r.status === "pending")
          .reduce<string | null>((min, r) => (min === null || r.at < min ? r.at : min), null),
    },
    redemptions: structuredClone(items),
  };
}

export function mockGetMetricsExtra(days: number): CreatorMetricsExtra {
  const n = clampDays(days);
  const trend = bucketByDay(
    store.redemptions.map((r) => r.at),
    n
  );
  const revenueTrend = bucketCentsByDay(
    store.grants.map((g) => ({ at: g.at, cents: g.amountCents })),
    n
  );
  return {
    trend,
    funnel: {
      // Per-fan funnel: fans created → fans with ≥1 spin → fans with a
      // fulfilled prize. Each redemption is one spin and carries its fanId.
      fans: store.fans.size,
      spun: new Set(store.redemptions.flatMap((r) => r.fanId ? [r.fanId] : [])).size,
      fulfilled: new Set(
        store.redemptions.filter((r) => r.status === "fulfilled" && r.fanId !== null).map((r) => r.fanId)
      ).size,
    },
    revenueTrend,
    // Each redemption is one spin and carries its fanId.
    activeFans: activeFans(store.redemptions.flatMap((r) => r.fanId ? [{ fanId: r.fanId, at: r.at }] : [])),
  };
}

// --- Phase 4 (deeper analytics) --------------------------------------------

/** #17 Best-time heatmap: bucket spin timestamps by (UTC weekday, UTC hour). */
export function mockGetEngagementHeatmap(days?: number): EngagementHeatmap {
  const n = clampDays(days ?? 90);
  const since = Date.now() - n * 24 * 60 * 60 * 1000;
  // 7×24 grid of zeros.
  const counts = new Array<number>(7 * 24).fill(0);
  for (const r of store.redemptions) {
    const d = new Date(r.at);
    if (Number.isNaN(d.getTime()) || d.getTime() < since) continue;
    counts[d.getUTCDay() * 24 + d.getUTCHours()] += 1;
  }
  const cells: EngagementHeatmap["cells"] = [];
  let max = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const count = counts[weekday * 24 + hour];
      if (count > max) max = count;
      cells.push({ weekday, hour, count });
    }
  }
  return { cells, max };
}

/** #18 Prize ROI: count wins per prize label and join the creator's cost. */
export function mockGetProfitSummary(days?: number): {
  revenueCents: number;
  costCents: number;
  profitCents: number;
  marginPct: number;
  costsComplete: boolean;
} {
  const n = clampDays(days ?? 90);
  const since = Date.now() - n * 24 * 60 * 60 * 1000;
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t >= since;
  };
  const revenueCents = store.grants
    .filter((g) => inWindow(g.at))
    .reduce((s, g) => s + g.amountCents, 0);

  const costByLabel = new Map<string, number | null>();
  for (const w of store.wheels.values())
    for (const p of w.prizes) costByLabel.set(p.label, p.cost ?? null);

  let costCents = 0;
  let costsComplete = true;
  for (const r of store.redemptions) {
    if (!inWindow(r.at)) continue;
    const c = costByLabel.get(r.prizeLabel);
    if (c == null) costsComplete = false;
    else costCents += c;
  }
  const profitCents = revenueCents - costCents;
  return {
    revenueCents,
    costCents,
    profitCents,
    marginPct: revenueCents > 0 ? profitCents / revenueCents : 0,
    costsComplete,
  };
}

export function mockGetPrizeRoi(days?: number): PrizeRoiRow[] {
  const n = clampDays(days ?? 90);
  const since = Date.now() - n * 24 * 60 * 60 * 1000;

  // Costs + rarity come from every wheel's prize config (last write wins).
  const meta = new Map<string, { rarity: Rarity; costCents: number | null }>();
  for (const w of store.wheels.values()) {
    for (const p of w.prizes) {
      meta.set(p.label, { rarity: p.rarity, costCents: p.cost ?? null });
    }
  }

  // Counts come from redemptions (one row per spin) inside the window.
  const counts = new Map<string, { rarity: Rarity; timesWon: number }>();
  for (const r of store.redemptions) {
    const d = new Date(r.at);
    if (Number.isNaN(d.getTime()) || d.getTime() < since) continue;
    const cur = counts.get(r.prizeLabel);
    if (cur) cur.timesWon += 1;
    else counts.set(r.prizeLabel, { rarity: r.rarity, timesWon: 1 });
  }

  const rows: PrizeRoiRow[] = [];
  for (const [label, { rarity, timesWon }] of counts) {
    const costCents = meta.get(label)?.costCents ?? null;
    rows.push({
      label,
      rarity: meta.get(label)?.rarity ?? rarity,
      timesWon,
      costCents,
      totalCostCents: (costCents ?? 0) * timesWon,
    });
  }
  rows.sort((a, b) => b.totalCostCents - a.totalCostCents);
  return rows;
}

/** #19 Cohort retention: cohort each fan by their first grant's campaign. */
export function mockGetCohortRetention(): CohortRow[] {
  const campaignName = new Map<string, string>();
  for (const c of store.campaigns) campaignName.set(c.id, c.name);

  // First grant (earliest `at`) per fan determines the cohort; also track grant
  // counts per fan for the "returning" definition (≥2 grants).
  const firstCampaign = new Map<string, string | null>();
  const firstAt = new Map<string, number>();
  const grantCount = new Map<string, number>();
  for (const g of store.grants) {
    grantCount.set(g.fanId, (grantCount.get(g.fanId) ?? 0) + 1);
    const t = new Date(g.at).getTime();
    const prev = firstAt.get(g.fanId);
    if (prev === undefined || t < prev) {
      firstAt.set(g.fanId, Number.isNaN(t) ? Infinity : t);
      firstCampaign.set(g.fanId, g.campaignId);
    }
  }

  // Group fans into cohorts keyed by their first campaign (null => direct).
  const cohorts = new Map<string | null, { fans: number; returningFans: number }>();
  for (const [fanId, campaignId] of firstCampaign) {
    const c = cohorts.get(campaignId) ?? { fans: 0, returningFans: 0 };
    c.fans += 1;
    if ((grantCount.get(fanId) ?? 0) >= 2) c.returningFans += 1;
    cohorts.set(campaignId, c);
  }

  const rows: CohortRow[] = [];
  for (const [campaignId, { fans, returningFans }] of cohorts) {
    rows.push({
      campaignId,
      campaignName:
        campaignId === null
          ? "Direct / no campaign"
          : campaignName.get(campaignId) ?? "Direct / no campaign",
      fans,
      returningFans,
      repeatRate: fans === 0 ? 0 : returningFans / fans,
    });
  }
  rows.sort((a, b) => b.fans - a.fans);
  return rows;
}

export function mockSetRedemptionStatus(id: string, status: RedemptionStatus) {
  const r = store.redemptions.find((x) => x.id === id);
  if (!r || (status !== "fulfilled" && mockIsInstantRedemption(id))) return null;
  r.status = status;
  return r;
}

export function mockSetRedemptionMeta(
  id: string,
  patch: { notes?: string | null; dueAt?: string | null }
) {
  const r = store.redemptions.find((x) => x.id === id);
  if (!r || (patch.dueAt != null && mockIsInstantRedemption(id))) return null;
  if ("notes" in patch) r.notes = patch.notes ?? null;
  if ("dueAt" in patch) r.dueAt = patch.dueAt ?? null;
  return r;
}

// --- Campaigns --------------------------------------------------------------

export function mockGetUncategorizedStats(): {
  revenue: number;
  spinsBought: number;
  spinsPlayed: number;
  fans: number;
} {
  const g = store.grants.filter((x) => x.campaignId == null);
  const spinsPlayed = store.redemptions.filter((r) => r.campaignId == null).length;
  return {
    revenue: g.reduce((s, x) => s + x.amountCents, 0),
    spinsBought: g.reduce((s, x) => s + x.spins, 0),
    spinsPlayed,
    fans: new Set(g.map((x) => x.fanId)).size,
  };
}

export function mockEditGrant(
  grantId: string,
  patch: { spins?: number; amountCents?: number; campaignId?: string | null },
  requestId: string = crypto.randomUUID(),
): { ok: true; requestId: string; grantId: string; replayed: boolean; spinsRemaining: number | null; grant: { id: string; spins: number; bonusSpins: number; amountCents: number; campaignId: string | null } } | { error: string } {
  if (!isUuid(requestId) || !patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "invalid" };
  requestId = requestId.toLowerCase();
  // Match JSON transport: absent/undefined fields stay absent. Never fill in
  // today's grant terms before binding a retry to its original raw patch.
  const rawPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  // Nonfinite numbers have no JSON wire representation, so reject the trusted
  // direct-call convenience before canonicalizing them to a different value.
  if (Object.values(rawPatch).some(value => typeof value === "number" && !Number.isFinite(value))) return { error: "invalid" };
  const hash = serverCreatorIntentHash("edit", [grantId, rawPatch]);
  const gate = beginMockCreatorRequest(requestId, "edit", hash);
  if (gate !== "ready" && gate !== "committed") return { error: gate };
  const reject = (error: string) => { finishMockCreatorRequest(requestId, "rejected"); return { error }; };
  if (Object.keys(rawPatch).some(key => !["spins", "amountCents", "campaignId"].includes(key)) ||
      ("spins" in rawPatch && (!Number.isInteger(rawPatch.spins) || Number(rawPatch.spins) < 0 || Number(rawPatch.spins) > 1_000_000)) ||
      ("amountCents" in rawPatch && (!Number.isInteger(rawPatch.amountCents) || Number(rawPatch.amountCents) < 0 || Number(rawPatch.amountCents) > 100_000_000))) return reject("invalid");
  const grant = store.grants.find((x) => x.id === grantId);
  if (!grant) return reject(gate === "committed" ? "gone" : "not_found");
  const fan = store.fans.get(grant.fanId);
  if (!fan) return reject("gone");
  const pass = fan.selfExcludedAt ? undefined : grantEditPass(fan, grant) ?? undefined;
  const response = (replayed: boolean) => ({ ok: true as const, requestId, grantId: grant.id, replayed,
    spinsRemaining: pass?.spinsRemaining ?? null,
    grant: { id: grant.id, spins: grant.spins, bonusSpins: grant.bonusSpins, amountCents: grant.amountCents, campaignId: grant.campaignId } });
  // A late replay observes today's grant/balance without repeating yesterday's
  // absolute edit over a newer legitimate correction.
  if (gate === "committed") return response(true);
  if ("campaignId" in rawPatch && rawPatch.campaignId !== null &&
      (typeof rawPatch.campaignId !== "string" || !store.campaigns.some(campaign => campaign.id === rawPatch.campaignId))) return reject("campaign_not_found");
  // Resolve the balance change first so a refused edit changes nothing.
  let delta = 0;
  if (patch.spins != null) {
    delta = patch.spins - grant.spins;
    if (delta !== 0) {
      if (!pass) return reject("no_active_pass");
      if ([...mockFocusState().focuses.values()].some(focus => focus.grant_id === grantId) ||
          [...mockFocusState().grants.values()].some(receipt => receipt.grantId === grantId)) return reject("invalid");
      // Spins already spun can't be un-granted: refuse a cut deeper than the
      // pass's unspent balance instead of clamping (clamping lost the deficit,
      // and growing the grant back afterwards minted already-spent spins).
      if (pass.spinsRemaining + delta < 0) return reject("insufficient_spins");
      if (delta > 0 && !fanEngagementAllowed({ blocked: !!fan.blockedAt, selfExcluded: !!fan.selfExcludedAt, breakUntil: fan.breakUntil })) return reject(fan.blockedAt || fan.selfExcludedAt ? "blocked" : "on_break");
    }
  }
  if (patch.amountCents != null) grant.amountCents = patch.amountCents;
  if (patch.campaignId !== undefined) grant.campaignId = patch.campaignId;
  if (patch.spins != null) {
    grant.spins += delta;
    grant.bonusSpins = Math.min(grant.bonusSpins, grant.spins);
    if (delta !== 0) {
      if (pass) {
        pass.spinsRemaining += delta;
        pass.spinsGrantedTotal = Math.max(0, pass.spinsGrantedTotal + delta);
      }
      recomputeFanAggregate(fan);
    }
  }
  finishMockCreatorRequest(requestId, "committed", { fanId: fan.id, ...(pass ? { passId: mockPassId(pass) } : {}), grantId: grant.id });
  return response(false);
}

export function mockClearMyData(): { ok: true } | { error: string } {
  clearMockFocusState();
  resetMockCreatorRequestBusinessData();
  store.fans = new Map();
  store.tokens = new Map();
  store.tokenCampaign = new Map();
  store.grants = [];
  store.redemptions = [];
  store.campaigns = [];
  store.wishlists = [];
  store.happyHours = [];
  store.referrals = [];
  store.messages = [];
  checkinStore().clear(); // fan_checkins cascades with the fans
  clearOutreach();
  // #26: spin_rewards go with the spins; the starter wheel below has no rewards.
  rewardState().consumedFingerprints?.clear();
  rewardState().deliveries.clear();
  rewardState().prizes.clear();
  // Keep one fresh starter wheel so the account isn't wheel-less. Its id is
  // stable, so stamp fresh meta too (Supabase recreates the row, so
  // updated_at = created_at and the "Build your first wheel" step un-ticks).
  store.wheels = seedWheels();
  wheelMeta.clear();
  for (const w of store.wheels.values()) {
    const now = new Date().toISOString();
    wheelMeta.set(w.id, { createdAt: now, updatedAt: now });
  }
  // Parity with Supabase: a reset also restores profile prefs to defaults.
  store.leaderboardEnabled = false;
  store.onboardingDismissed = false;
  store.chatIntro = DEFAULT_CHAT_INTRO;
  store.chatOutro = DEFAULT_CHAT_OUTRO;
  store.webhooks = [];
  return { ok: true };
}

export function mockCreateCampaign(
  name: string,
  pinnedWheelId?: string | null
): Campaign {
  const campaign: Campaign = {
    id: "camp-" + Math.random().toString(36).slice(2, 9),
    name: name.trim() || "Campaign",
    isActive: true,
    createdAt: new Date().toISOString(),
    pinnedWheelId: pinnedWheelId ?? null,
  };
  store.campaigns.unshift(campaign);
  return structuredClone(campaign);
}

/** Demo twin of campaignPinError: only an existing, playable game. */
export function mockCampaignPinError(wheelId: string | null | undefined): "not_found" | "game_not_playable" | null {
  if (wheelId == null) return null;
  const wheel = store.wheels.get(wheelId);
  if (!wheel) return "not_found";
  return isPlayableGame(wheel) ? null : "game_not_playable";
}

/** Pin (or unpin) a campaign's default wheel. */
export function mockSetCampaignPinnedWheel(
  campaignId: string,
  wheelId: string | null
): { ok: true } | { error: string } {
  const campaign = store.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { error: "not_found" };
  const pinError = mockCampaignPinError(wheelId);
  if (pinError) return { error: pinError };
  campaign.pinnedWheelId = wheelId;
  return { ok: true };
}

export function mockRenameCampaign(
  campaignId: string,
  name: string
): { ok: true } | { error: string } {
  const campaign = store.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { error: "not_found" };
  campaign.name = name;
  return { ok: true };
}

export function mockDeleteCampaign(campaignId: string): { ok: true } | { error: string } {
  const before = store.campaigns.length;
  store.campaigns = store.campaigns.filter((c) => c.id !== campaignId);
  // Detach grants from the deleted campaign (keep their history).
  for (const g of store.grants) if (g.campaignId === campaignId) g.campaignId = null;
  return before === store.campaigns.length ? { error: "not_found" } : { ok: true };
}

export function mockListCampaigns(): Campaign[] {
  // Already stored newest-first.
  return structuredClone(store.campaigns);
}

export function mockGetCampaignStats(): CampaignStats[] {
  // Pre-collect every win across all fans (each carries its FIFO campaignId).
  const allWins: MockWin[] = [];
  for (const f of store.fans.values()) allWins.push(...f.wins);

  return store.campaigns.map((campaign) => {
    const grants = store.grants.filter((g) => g.campaignId === campaign.id);
    const spinsBought = grants.reduce((s, g) => s + g.spins, 0);
    const revenue = grants.reduce((s, g) => s + g.amountCents, 0);
    const uniqueFans = new Set(grants.map((g) => g.fanId)).size;

    const campaignWins = allWins.filter((w) => w.campaignId === campaign.id);
    const spinsPlayed = campaignWins.length;

    const fulfilled = store.redemptions.filter(
      (r) => r.status === "fulfilled" && r.campaignId === campaign.id
    ).length;

    // Top prize: the mode of this campaign's attributed wins (carrying rarity).
    const counts = new Map<string, { label: string; rarity: Rarity; count: number }>();
    for (const w of campaignWins) {
      const cur = counts.get(w.label);
      if (cur) cur.count += 1;
      else counts.set(w.label, { label: w.label, rarity: w.rarity, count: 1 });
    }
    let topPrize: { label: string; rarity: Rarity; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!topPrize || entry.count > topPrize.count) topPrize = entry;
    }

    const arpu = uniqueFans ? Math.round(revenue / uniqueFans) : 0;

    return {
      campaign: structuredClone(campaign),
      spinsBought,
      spinsPlayed,
      uniqueFans,
      fulfilled,
      pending: Math.max(0, spinsPlayed - fulfilled),
      playThroughPct: spinsBought > 0 ? spinsPlayed / spinsBought : 0,
      revenue,
      arpu,
      topPrize,
    };
  });
}

// --- Campaign packs (purchasable spin presets) ------------------------------

/** Packs, optionally filtered to a campaign (or globals), ordered by sortOrder. */
export function mockListCampaignPacks(campaignId?: string): CampaignPack[] {
  const packs = store.campaignPacks
    .filter((p) =>
      campaignId === undefined ? true : p.campaignId === campaignId
    )
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return structuredClone(packs);
}

export function mockCreateCampaignPack(input: FocusPackTerms & {
  campaignId?: string | null;
  label: string;
  spins: number;
  amountCents: number;
  bonusSpins?: number;
  sortOrder?: number;
}): CampaignPack {
  const terms = focusPackTerms(input);
  if (!terms) throw new Error("bad_request");
  const pack: CampaignPack = {
    ...terms,
    id: genId("pack"),
    campaignId: input.campaignId ?? null,
    label: input.label.trim() || "Pack",
    spins: Math.max(0, Math.floor(input.spins) || 0),
    amountCents: Math.max(0, Math.floor(input.amountCents) || 0),
    bonusSpins: Math.max(0, Math.floor(input.bonusSpins ?? 0) || 0),
    sortOrder:
      input.sortOrder ??
      store.campaignPacks.reduce((max, p) => Math.max(max, p.sortOrder + 1), 0),
    createdAt: new Date().toISOString(),
  };
  store.campaignPacks.push(pack);
  return structuredClone(pack);
}

export function mockUpdateCampaignPack(
  id: string,
  patch: Partial<Pick<CampaignPack, "label" | "spins" | "amountCents" | "bonusSpins" | "sortOrder" | "campaignId" | "packKind" | "focusMultiplier" | "focusSpins" | "chaseWithin">>
): { ok: true } | { error: string } {
  const pack = store.campaignPacks.find((p) => p.id === id);
  if (!pack) return { error: "not_found" };
  const terms = focusPackTerms({ ...pack, ...patch });
  if (!terms) return { error: "bad_request" };
  Object.assign(pack, terms);
  if (patch.label !== undefined) pack.label = patch.label.trim() || pack.label;
  if (patch.spins !== undefined) pack.spins = Math.max(0, Math.floor(patch.spins) || 0);
  if (patch.amountCents !== undefined)
    pack.amountCents = Math.max(0, Math.floor(patch.amountCents) || 0);
  if (patch.bonusSpins !== undefined)
    pack.bonusSpins = Math.max(0, Math.floor(patch.bonusSpins) || 0);
  if (patch.sortOrder !== undefined) pack.sortOrder = patch.sortOrder;
  if (patch.campaignId !== undefined) pack.campaignId = patch.campaignId;
  return { ok: true };
}

export function mockDeleteCampaignPack(id: string): { ok: true } | { error: string } {
  const before = store.campaignPacks.length;
  store.campaignPacks = store.campaignPacks.filter((p) => p.id !== id);
  return store.campaignPacks.length < before ? { ok: true } : { error: "not_found" };
}

// --- Prize templates (reusable prizes) --------------------------------------

export function mockListPrizeTemplates(): PrizeTemplate[] {
  // Newest first.
  return structuredClone(
    store.prizeTemplates
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

export function mockCreatePrizeTemplate(input: {
  label: string;
  rarity: Rarity;
  weight: number;
  description?: string;
  color?: string;
  emoji?: string;
}): PrizeTemplate {
  const label = input.label.trim() || "Prize";
  // Dedupe by name + rarity (double-clicks shouldn't create duplicates).
  const existing = store.prizeTemplates.find(
    (t) => t.label === label && t.rarity === input.rarity
  );
  if (existing) return structuredClone(existing);

  const tpl: PrizeTemplate = {
    id: genId("ptpl"),
    label,
    rarity: input.rarity,
    weight: storedWeight(input.weight),
    description: input.description,
    color: input.color ?? RARITY_COLORS[input.rarity],
    emoji: input.emoji,
    createdAt: new Date().toISOString(),
  };
  store.prizeTemplates.unshift(tpl);
  return structuredClone(tpl);
}

export function mockDeletePrizeTemplate(id: string): { ok: true } | { error: string } {
  const before = store.prizeTemplates.length;
  store.prizeTemplates = store.prizeTemplates.filter((t) => t.id !== id);
  return store.prizeTemplates.length < before ? { ok: true } : { error: "not_found" };
}

// --- Wheel templates (reusable wheel presets) -------------------------------

export function mockListWheelTemplates(): WheelTemplate[] {
  // Newest first.
  return structuredClone(
    store.wheelTemplates
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

/**
 * Create a wheel template, either from an existing wheel (ids stripped) or from
 * an inline config. `fromWheelId` wins if both are supplied.
 */
export function mockCreateWheelTemplate(input: {
  name: string;
  fromWheelId?: string;
  config?: Pick<WheelConfig, "title" | "subtitle" | "brandColor" | "gameKind" | "gameConfig"> & { prizes: Omit<Prize, "id">[] };
}): WheelTemplate {
  let title = "Wheel";
  let subtitle: string | undefined;
  let brandColor = "#ec4899";
  let prizes: Omit<Prize, "id">[] = [];

  const source = input.fromWheelId ? store.wheels.get(input.fromWheelId) : undefined;
  if (source) {
    title = source.title;
    subtitle = source.subtitle;
    brandColor = source.brandColor ?? "#ec4899";
    prizes = source.prizes.map(({ id: _id, ...rest }) => structuredClone(rest));
  } else if (input.config) {
    title = input.config.title;
    subtitle = input.config.subtitle;
    brandColor = input.config.brandColor ?? "#ec4899";
    prizes = input.config.prizes.map((p) => structuredClone(p));
  }

  const settings = gameSettings(source?.gameKind ?? input.config?.gameKind, source?.gameConfig ?? input.config?.gameConfig);
  if (!mockGameFeatures()[settings.gameKind]) throw new Error("feature_disabled");
  const tpl: WheelTemplate = {
    ...settings,
    id: genId("wtpl"),
    name: input.name.trim() || "Template",
    title,
    subtitle,
    brandColor,
    prizes,
    createdAt: new Date().toISOString(),
  };
  store.wheelTemplates.unshift(tpl);
  return structuredClone(tpl);
}

export function mockDeleteWheelTemplate(id: string): { ok: true } | { error: string } {
  const before = store.wheelTemplates.length;
  store.wheelTemplates = store.wheelTemplates.filter((t) => t.id !== id);
  return store.wheelTemplates.length < before ? { ok: true } : { error: "not_found" };
}

// --- Admin -----------------------------------------------------------------

export function mockGetAdminOverview(): AdminOverview {
  // Keep the "You" account's live numbers in sync with real demo activity.
  const you = store.accounts.find((a) => a.id === "acc-you");
  if (you) {
    you.fans = store.fans.size;
    you.spins = store.redemptions.length;
    you.pending = store.redemptions.filter((r) => r.status === "pending").length;
  }

  // Show ALL accounts — admins included (an account can be promoted to admin
  // and must still appear in the panel).
  const accounts = structuredClone(store.accounts);
  return {
    metrics: {
      creators: accounts.length,
      fans: accounts.reduce((s, a) => s + a.fans, 0),
      spins: accounts.reduce((s, a) => s + a.spins, 0),
      pending: accounts.reduce((s, a) => s + a.pending, 0),
    },
    accounts,
  };
}

export function mockUpdateAccount(
  id: string,
  patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
) {
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc) return null;
  if (patch.role) acc.role = patch.role;
  if (typeof patch.isActive === "boolean") acc.isActive = patch.isActive;
  if (patch.features) acc.features = { ...acc.features, ...patch.features };
  return structuredClone(acc);
}

// --- DM templates -----------------------------------------------------------

export function mockListDmTemplates(): DmTemplate[] {
  // Already stored newest-first.
  return structuredClone(store.dmTemplates);
}

export function mockCreateDmTemplate(title: string, body: string): DmTemplate {
  const template: DmTemplate = {
    id: "dm-" + Math.random().toString(36).slice(2, 9),
    title: title.trim() || "Template",
    body,
    createdAt: new Date().toISOString(),
  };
  store.dmTemplates.unshift(template);
  return structuredClone(template);
}

export function mockDeleteDmTemplate(id: string): boolean {
  const before = store.dmTemplates.length;
  store.dmTemplates = store.dmTemplates.filter((t) => t.id !== id);
  return store.dmTemplates.length < before;
}

// --- Admin (account creation) -----------------------------------------------

// --- Phase 3: Happy hour ----------------------------------------------------

/** The active happy-hour status for a wheel at `now` (max multiplier wins). */
export function mockGetActiveHappyHour(
  wheelId: string,
  now: Date = new Date()
): HappyHourStatus {
  const nowIso = now.toISOString();
  const active = store.happyHours.filter(
    (h) => h.wheelId === wheelId && h.startsAt <= nowIso && h.endsAt > nowIso
  );
  if (active.length === 0) {
    return { active: false, multiplier: 1, endsAt: null };
  }
  // Highest multiplier wins; report the endsAt of that window.
  const best = active.reduce((a, b) => (b.multiplier > a.multiplier ? b : a));
  return { active: true, multiplier: best.multiplier, endsAt: best.endsAt };
}

/** Happy hours, optionally filtered to a wheel, newest start first. */
export function mockListHappyHours(wheelId?: string): HappyHour[] {
  const rows = store.happyHours
    .filter((h) => (wheelId === undefined ? true : h.wheelId === wheelId))
    .slice()
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return structuredClone(rows);
}

export function mockCreateHappyHour(input: {
  wheelId: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
}): HappyHour | { error: string } {
  if (!(input.endsAt > input.startsAt)) return { error: "invalid_window" };
  // Stored as given (the happy_hours.multiplier column is numeric, the UI steps
  // by 0.5): flooring would turn a ×1.5 boost into no boost at all.
  const multiplier = Number(input.multiplier);
  if (!(multiplier >= 1 && multiplier <= MAX_COMBINED_BOOST)) {
    return { error: "invalid_multiplier" };
  }
  const row: MockHappyHour = {
    id: genId("hh"),
    wheelId: input.wheelId,
    multiplier,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };
  store.happyHours.push(row);
  return structuredClone(row);
}

export function mockDeleteHappyHour(id: string): { ok: true } | { error: string } {
  const before = store.happyHours.length;
  store.happyHours = store.happyHours.filter((h) => h.id !== id);
  return store.happyHours.length < before ? { ok: true } : { error: "not_found" };
}

// --- Phase 3: Share cards ---------------------------------------------------

/** Resolve a shareable win card by its opaque shareId, across all fans. */
export function mockGetShareCard(shareId: string): ShareCardData | null {
  const histories = [...Array.from(store.fans.values(), fan => fan.wins), [...(mockFocusState().anonymousWins?.values() ?? [])]];
  for (const wins of histories) {
    const win = wins.find((w) => w.shareId === shareId);
    if (win) {
      return structuredClone({
        creatorTitle: CREATOR_TITLE,
        prizeLabel: win.label,
        rarity: win.rarity,
        emoji: win.emoji,
        color: win.color ?? RARITY_COLORS[win.rarity],
        imageUrl: win.imageUrl ?? null,
        at: win.at,
      });
    }
  }
  return null;
}

// --- Phase 5b: Provably-fair verification (#23) -----------------------------

/** Resolve the fairness data for a spin by its shareId, across all fans. */
export async function mockGetSpinVerification(
  shareId: string
): Promise<SpinVerification | null> {
  const histories = [...Array.from(store.fans.values(), fan => fan.wins), [...(mockFocusState().anonymousWins?.values() ?? [])]];
  for (const wins of histories) {
    const win = wins.find((w) => w.shareId === shareId);
    if (!win) continue;
    if (!win.serverSeed || !win.serverSeedHash) return null;
    const hashOk = (await sha256Hex(win.serverSeed)) === win.serverSeedHash;
    return {
      prizeLabel: win.label,
      rarity: win.rarity,
      serverSeed: win.serverSeed,
      serverSeedHash: win.serverSeedHash,
      nonce: win.nonce ?? 0,
      hashOk,
      at: win.at,
      clientSeed: win.clientSeed ?? null,
      commitment: win.commitment ?? null,
      fairVersion: win.fairVersion ?? null,
      ...(win.fairVersion === 3
        ? {
            v3: {
              prizeId: win.prizeId ?? null,
              poolSnapshot: structuredClone(win.poolSnapshot ?? null),
              poolHash: win.poolHash ?? null,
              fairTrace: structuredClone(win.fairTrace ?? null),
              presentation: structuredClone(win.presentation ?? null),
            },
          }
        : {}),
    };
  }
  return null;
}

// --- Phase 5b: Webhooks (#24) ----------------------------------------------

export function mockListWebhooks(): Webhook[] {
  return structuredClone(
    store.webhooks
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

export function mockCreateWebhook(
  url: string,
  event = "prize_pending"
): Webhook | { error: string } {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return { error: "invalid_url" };
  const hook: MockWebhook = {
    id: genId("wh"),
    url: trimmed,
    event: event.trim() || "prize_pending",
    createdAt: new Date().toISOString(),
  };
  store.webhooks.push(hook);
  return structuredClone(hook);
}

export function mockDeleteWebhook(id: string): { ok: true } | { error: string } {
  const before = store.webhooks.length;
  store.webhooks = store.webhooks.filter((w) => w.id !== id);
  return store.webhooks.length < before ? { ok: true } : { error: "not_found" };
}

/** Demo mode never makes outbound calls — webhook fan-out is a no-op. */
export async function mockFireWebhooks(
  _creatorId: string,
  _payload: object
): Promise<void> {
  /* no-op in demo mode */
}

// --- Phase 5b: Age-gate / ToS (#24) ----------------------------------------

/** Mark the fan behind a token as having acknowledged the age-gate / ToS. */
export function mockAckFan(token: string): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  fan.ackedAt = new Date().toISOString();
  fan.ackedTermsVersion = LEGAL.version;
  return { ok: true };
}

/**
 * A fan self-excludes (pauses) their own link. Unlike the old no-op, this now
 * records the exclusion so mockSpin actually blocks subsequent spins — matching
 * the Supabase path and giving the demo/tests a real guard to exercise.
 */
/** Creator blocks / unblocks a fan (demo mirror of setFanBlocked). */
export function mockSetFanBlocked(fanId: string, blocked: boolean): { ok: true } | { error: string } {
  const fan = store.fans.get(fanId);
  if (!fan) return { error: "not_found" };
  fan.blockedAt = blocked ? new Date().toISOString() : null;
  if (blocked) mockCancelFanFocus(fanId);
  return { ok: true };
}

/** RM-6: the fan behind a live link (unknown -> not_found; paused/blocked -> blocked). */
function liveFanForToken(token: string): MockFan | { error: "not_found" | "blocked" } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  if (fan.selfExcludedAt || fan.blockedAt) return { error: "blocked" };
  return fan;
}

/** RM-6: the fan sets (or, with null, turns off) their own daily reminder. */
export function mockSetPlayReminder(
  token: string,
  daily: number | null,
): { ok: true; reminder: number | null } | { error: "not_found" | "blocked" } {
  const fan = liveFanForToken(token);
  if ("error" in fan) return fan;
  fan.playReminderDaily = daily;
  return { ok: true, reminder: daily };
}

/** RM-6: the fan starts (or lengthens) a break; a shorter ask keeps the longer one. */
export function mockTakeBreak(
  token: string,
  durationMs: number,
): { ok: true; breakUntil: string } | { error: "not_found" | "blocked" } {
  const fan = liveFanForToken(token);
  if ("error" in fan) return fan;
  fan.breakUntil = lengthenBreak(fan.breakUntil, durationMs);
  const focus = mockFocusState().focuses.get(fan.id);
  if (focus && (focus.status === "active" || focus.status === "paused")) focus.status = "paused";
  return { ok: true, breakUntil: fan.breakUntil };
}

export function mockSelfExclude(token: string): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  fan.selfExcludedAt = new Date().toISOString();
  mockCancelFanFocus(fan.id);
  return { ok: true };
}

// In-memory record of fan→creator reports (demo only; mirrors creator_reports).
const mockReports: { token: string; reason: string; detail: string | null; at: string }[] = [];

/** A fan reports the creator behind their token (demo: store it, validate reason). */
export function mockReportCreator(
  token: string,
  reason: string,
  detail?: string
): { ok: true } | { error: string } {
  if (!reason.trim()) return { error: "empty" };
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  mockReports.push({
    token,
    reason: reason.slice(0, 120),
    detail: detail?.slice(0, 2000) ?? null,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

// --- Phase 3: Wishlist ------------------------------------------------------

export function mockAddWishlist(
  token: string,
  prizeLabel: string
): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  const label = prizeLabel.trim();
  if (!label) return { error: "invalid_label" };

  // Validate the label exists on the fan's active wheel; snapshot its rarity.
  const wheel = store.wheels.get(mockResolveActiveWheelId()) ?? activeWheel();
  const prize = wheel.prizes.find((p) => p.label === label);
  if (!prize) return { error: "unknown_prize" };

  // Idempotent: don't double-add the same label for the same fan.
  const exists = store.wishlists.some(
    (w) => w.fanId === fan.id && w.prizeLabel === label
  );
  if (!exists) {
    store.wishlists.push({
      id: genId("wish"),
      fanId: fan.id,
      prizeLabel: label,
      prizeId: prize.id,
      prizeRarity: prize.rarity,
      at: new Date().toISOString(),
    });
  }
  return { ok: true };
}

export function mockRemoveWishlist(
  token: string,
  prizeLabel: string
): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  const label = prizeLabel.trim();
  store.wishlists = store.wishlists.filter(
    (w) => !(w.fanId === fan.id && w.prizeLabel === label)
  );
  return { ok: true };
}

/** Aggregate wishlist demand across all fans, grouped by prize label. */
export function mockGetWishlistDemand(): WishlistDemand[] {
  const byLabel = new Map<
    string,
    { prizeLabel: string; rarity: Rarity; count: number; fanNames: string[] }
  >();
  for (const w of store.wishlists) {
    const fan = store.fans.get(w.fanId);
    const fanName = fan?.name ?? "Fan";
    let entry = byLabel.get(w.prizeLabel);
    if (!entry) {
      entry = { prizeLabel: w.prizeLabel, rarity: w.prizeRarity, count: 0, fanNames: [] };
      byLabel.set(w.prizeLabel, entry);
    }
    entry.count += 1;
    if (!entry.fanNames.includes(fanName)) entry.fanNames.push(fanName);
  }
  const out = [...byLabel.values()].sort((a, b) => b.count - a.count);
  return structuredClone(out);
}

// --- Phase 3: Leaderboard ---------------------------------------------------

export function mockSetLeaderboardEnabled(enabled: boolean): { ok: true } {
  store.leaderboardEnabled = !!enabled;
  return { ok: true };
}

export function mockGetOnboardingDismissed(): boolean {
  return store.onboardingDismissed;
}

export function mockSetOnboardingDismissed(dismissed: boolean): { ok: true } {
  store.onboardingDismissed = !!dismissed;
  return { ok: true };
}

// --- Phase 9 #6: account settings (display name + notification prefs) --------

export function mockGameFeatures() { return creatorGameFeatures(store.accounts.find(account => account.id === "acc-you")?.features); }

export function mockGetMyAccount(): {
  features: ReturnType<typeof creatorGameFeatures>;
  email: string | null;
  displayName: string | null;
  notifications: { newSpin: boolean; lowBalance: boolean; messages: boolean };
} {
  return {
    features: mockGameFeatures(),
    email: "demo@fanfunnel.app",
    displayName: store.displayName,
    notifications: {
      newSpin: store.notifyNewSpin,
      lowBalance: store.notifyLowBalance,
      messages: store.notifyMessages,
    },
  };
}

export function mockSetMyDisplayName(name: string): { ok: true } {
  const trimmed = name.trim();
  if (trimmed) store.displayName = trimmed;
  return { ok: true };
}

export function mockSetMyNotificationPrefs(prefs: {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}): { ok: true } {
  store.notifyNewSpin = !!prefs.newSpin;
  store.notifyLowBalance = !!prefs.lowBalance;
  store.notifyMessages = !!prefs.messages;
  return { ok: true };
}

// --- RD-7: notification bell sources (mirrors notifications.ts) ---------------

export function mockGetNotificationSources(): NotificationSources {
  const fanName = (id: string) => store.fans.get(id)?.name ?? "Fan";
  const pendingWins = store.redemptions
    .filter((r) => r.status === "pending")
    .slice(0, FEED_LIMIT)
    .map((r) => ({ id: r.id, fanName: r.fanName, prizeLabel: r.prizeLabel, emoji: r.emoji ?? null, at: r.at }));
  const unreadMessages = store.messages
    .filter((m) => m.sender === "fan" && m.readAt === null)
    .map((m) => ({ fanId: m.fanId, fanName: fanName(m.fanId), body: m.body, at: m.at }));
  const lowStock: NotificationSources["lowStock"] = [];
  for (const w of store.wheels.values()) {
    if (w.archivedAt) continue;
    for (const p of w.prizes) {
      if (p.stock === null || p.stock === undefined || p.stock > LOW_STOCK_THRESHOLD) continue;
      // Stock moves on a win; the demo has no prize id on a win, so match the label.
      const lastWin = store.redemptions.find((r) => r.prizeLabel === p.label)?.at;
      lowStock.push({
        prizeId: p.id,
        label: p.label,
        emoji: p.emoji ?? null,
        stock: p.stock,
        wheelId: w.id,
        wheelTitle: w.title,
        at: lastWin ?? wheelMeta.get(w.id)?.updatedAt ?? new Date(0).toISOString(),
      });
    }
  }
  const since = Date.now() - OUT_OF_SPINS_WINDOW_DAYS * 86_400_000;
  const outOfSpins = [...store.fans.values()]
    .filter(
      (f) =>
        f.spinsRemaining === 0 &&
        f.wins.length > 0 &&
        fanEngagementAllowed({ selfExcluded: !!f.selfExcludedAt, blocked: !!f.blockedAt, breakUntil: f.breakUntil }) &&
        Date.parse(f.wins[0].at) >= since
    )
    .map((f) => ({ fanId: f.id, fanName: f.name, at: f.wins[0].at }));
  return structuredClone({
    pendingWins,
    unreadMessages,
    lowStock,
    outOfSpins,
    fanDeletions: mockGetFanDeletionNotices(),
  });
}

export function mockGetNotificationsSeenAt(): string | null {
  return store.notificationsSeenAt;
}

export function mockSetNotificationsSeen(): { ok: true } {
  store.notificationsSeenAt = new Date().toISOString();
  return { ok: true };
}

export function mockSetActiveWheelBrandColor(color: string): { ok: true } {
  const w = activeWheel();
  w.brandColor = color;
  store.wheels.set(w.id, w);
  return { ok: true };
}

export function mockSetFanLeaderboardOptIn(
  token: string,
  optIn: boolean,
  handle?: string
): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan || (optIn && fan.selfExcludedAt)) return { error: "not_found" };
  fan.leaderboardOptIn = !!optIn;
  if (optIn && handle !== undefined) {
    const trimmed = handle.trim();
    fan.handle = trimmed || undefined;
  }
  return { ok: true };
}

/**
 * The name a fan is shown under on public surfaces, or null when they have no
 * board handle — in which case they're skipped. Their real name (`f.name`) is
 * never used here.
 */
function publicHandle(f: { handle?: string }): string | null {
  return f.handle?.trim() || null;
}

export function mockGetLeaderboard(_creatorId?: string): LeaderboardView {
  if (!store.leaderboardEnabled) {
    return { enabled: false, creatorTitle: CREATOR_TITLE, entries: [] };
  }
  const rows = Array.from(store.fans.values())
    .filter((f) => f.leaderboardOptIn && publicHandle(f) !== null)
    .map((f) => {
      const spins = f.wins.length;
      const rareWins = f.wins.filter(
        (w) => RARITY_ORDER.indexOf(w.rarity) >= RARITY_ORDER.indexOf("rare")
      ).length;
      // No spend figure: this payload is served publicly and unauthenticated.
      return {
        handle: publicHandle(f) as string,
        spins,
        rareWins,
      };
    })
    .sort((a, b) => b.spins - a.spins || b.rareWins - a.rareWins);
  const entries: LeaderboardEntry[] = rows.map((r, i) => ({ rank: i + 1, ...r }));
  return structuredClone({ enabled: true, creatorTitle: CREATOR_TITLE, entries });
}

export function mockGetRecentWins(): {
  handle: string;
  prizeLabel: string;
  rarity: Rarity;
  at: string;
}[] {
  if (!store.leaderboardEnabled) return [];
  const wins: { handle: string; prizeLabel: string; rarity: Rarity; at: string }[] = [];
  for (const f of store.fans.values()) {
    if (!f.leaderboardOptIn) continue;
    const handle = publicHandle(f);
    if (handle === null) continue; // never fall back to the fan's real name
    for (const w of f.wins) {
      if (RARITY_ORDER.indexOf(w.rarity) >= RARITY_ORDER.indexOf("rare")) {
        wins.push({ handle, prizeLabel: w.label, rarity: w.rarity, at: w.at });
      }
    }
  }
  return structuredClone(
    wins.sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 20)
  );
}

// --- Phase 3: Referrals -----------------------------------------------------

export function mockGetReferralStats(): {
  referredCount: number;
  creditedCount: number;
  bonusAwarded: number;
} {
  const referredCount = store.referrals.length;
  const credited = store.referrals.filter((r) => r.creditedAt !== null);
  const creditedCount = credited.length;
  // Each credited referral awards REFERRAL_BONUS to BOTH fans.
  const bonusAwarded = credited.reduce((s, r) => s + r.bonusSpins * 2, 0);
  return { referredCount, creditedCount, bonusAwarded };
}

// --- Phase 3: Chat ----------------------------------------------------------

export function mockSendFanMessage(
  token: string,
  body: string
): { ok: true } | { error: "not_found" | "locked" | "empty" } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  if (!chatUnlockedFor(fan)) return { error: "locked" };
  const text = body.trim();
  if (text.length < 1 || text.length > 2000) return { error: "empty" };
  store.messages.push({
    id: genId("msg"),
    fanId: fan.id,
    sender: "fan",
    body: text,
    readAt: null,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

/** A fan's full thread (oldest first); marks creator→fan messages read. */
export function mockGetFanMessages(token: string): ChatMessage[] {
  const fan = fanForToken(token);
  if (!fan) return [];
  const now = new Date().toISOString();
  const rows = store.messages
    .filter((m) => m.fanId === fan.id)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const m of rows) {
    if (m.sender === "creator" && m.readAt === null) m.readAt = now;
  }
  return structuredClone(
    rows.map((m) => ({
      id: m.id,
      sender: m.sender,
      body: m.body,
      at: m.at,
      readAt: m.readAt,
    }))
  );
}

/** The creator's inbox: one thread per fan that has messages, newest first. */
export function mockListThreads(): FanThread[] {
  const byFan = new Map<string, MockMessage[]>();
  for (const m of store.messages) {
    (byFan.get(m.fanId) ?? byFan.set(m.fanId, []).get(m.fanId)!).push(m);
  }
  const threads: FanThread[] = [];
  for (const [fanId, msgs] of byFan) {
    const fan = store.fans.get(fanId);
    const sorted = msgs.slice().sort((a, b) => a.at.localeCompare(b.at));
    const last = sorted[sorted.length - 1];
    const unread = sorted.filter(
      (m) => m.sender === "fan" && m.readAt === null
    ).length;
    threads.push({
      fanId,
      fanName: fan?.name ?? "Fan",
      lastBody: last.body,
      lastAt: last.at,
      unread,
    });
  }
  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return structuredClone(threads);
}

/** A single fan's thread for the creator (oldest first); marks fan→creator read. */
export function mockGetThread(fanId: string): ChatMessage[] {
  const now = new Date().toISOString();
  const rows = store.messages
    .filter((m) => m.fanId === fanId)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const m of rows) {
    if (m.sender === "fan" && m.readAt === null) m.readAt = now;
  }
  return structuredClone(
    rows.map((m) => ({
      id: m.id,
      sender: m.sender,
      body: m.body,
      at: m.at,
      readAt: m.readAt,
    }))
  );
}

export function mockSendCreatorMessage(
  fanId: string,
  body: string
): { ok: true } | { error: string } {
  if (!store.fans.has(fanId)) return { error: "not_found" };
  const text = body.trim();
  if (text.length < 1 || text.length > 2000) return { error: "invalid_body" };
  store.messages.push({
    id: genId("msg"),
    fanId,
    sender: "creator",
    body: text,
    readAt: null,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

// --- Wave 3: editable auto intro/outro --------------------------------------

export function mockGetChatSettings(): ChatSettings {
  return { intro: store.chatIntro, outro: store.chatOutro };
}

export function mockSetChatSettings(input: {
  intro?: string | null;
  outro?: string | null;
}): { ok: true } {
  if (input.intro !== undefined) {
    const t = (input.intro ?? "").trim();
    store.chatIntro = t || null;
  }
  if (input.outro !== undefined) {
    const t = (input.outro ?? "").trim();
    store.chatOutro = t || null;
  }
  return { ok: true };
}

/**
 * Auto-send the creator's greeting when a fan first opens chat: only if the
 * creator has a non-empty intro AND the thread currently has zero messages.
 * Idempotent (no-op once any message exists).
 */
export function mockEnsureChatIntro(
  token: string
): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  const intro = (store.chatIntro ?? "").trim();
  if (!intro) return { ok: true };
  const hasAny = store.messages.some((m) => m.fanId === fan.id);
  if (hasAny) return { ok: true };
  store.messages.push({
    id: genId("msg"),
    fanId: fan.id,
    sender: "creator",
    body: intro,
    readAt: null,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

/**
 * Auto-send the creator's out-of-spins nudge: only if the creator has a
 * non-empty outro AND the most-recent message isn't already that exact outro
 * (guards against spamming).
 */
export function mockSendChatOutro(
  token: string
): { ok: true } | { error: string } {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" };
  const outro = (store.chatOutro ?? "").trim();
  if (!outro) return { ok: true };
  const mine = store.messages
    .filter((m) => m.fanId === fan.id)
    .sort((a, b) => a.at.localeCompare(b.at));
  const last = mine[mine.length - 1];
  if (last && last.sender === "creator" && last.body === outro) return { ok: true };
  store.messages.push({
    id: genId("msg"),
    fanId: fan.id,
    sender: "creator",
    body: outro,
    readAt: null,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

// --- Phase 3: Public teaser -------------------------------------------------

/** A token-less public preview of the active wheel + its happy-hour status. */
export function mockGetPublicWheelTeaser(
  _creatorId?: string
): { creatorTitle: string; wheel: PublicWheelConfig; happyHour: HappyHourStatus } | null {
  const wheel = store.wheels.get(mockResolveActiveWheelId()) ?? activeWheel();
  if (!wheel) return null;
  return structuredClone({
    creatorTitle: CREATOR_TITLE,
    wheel: toPublicWheel(wheel),
    happyHour: mockGetActiveHappyHour(wheel.id),
  });
}

export function mockCreateAccount(email: string, displayName: string) {
  const acc: AdminAccount = {
    id: "acc-" + Math.random().toString(36).slice(2, 9),
    email,
    displayName: displayName || email,
    role: "creator",
    isActive: true,
    features: defaultFeatures(),
    wheels: 0,
    fans: 0,
    spins: 0,
    pending: 0,
  };
  store.accounts.push(acc);
  return structuredClone(acc);
}

// --- RM-4: home-screen install (per-link manifest + the creator's icon choice) --

// Kept outside Store so this feature's demo state stays self-contained; pinned
// to globalThis like the store so pages and route handlers share it.
const gPwa = globalThis as unknown as { __ffPwaIconMode?: PwaIconMode };

export function mockGetMyPwaIconMode(): PwaIconMode {
  return gPwa.__ffPwaIconMode ?? DEFAULT_PWA_ICON_MODE;
}

export function mockSetMyPwaIconMode(mode: PwaIconMode): { ok: true } {
  gPwa.__ffPwaIconMode = mode;
  return { ok: true };
}

/** What a fan link's manifest/icons may show. Parity with mockGetFanPass: an
 *  unknown or paused link gets nothing. The demo creator has no avatar. */
export function mockGetFanAppInfo(token: string): FanAppInfo | null {
  const fan = fanForToken(token);
  if (!fan || fan.selfExcludedAt) return null;
  ensurePasses(fan);
  const pass = fan.passes.find((p) => p.token === token) ?? fan.passes[0];
  const wheelId = pass?.wheelId ?? mockResolveWheelId({ campaignId: campaignForFan(fan) });
  const wheel = store.wheels.get(wheelId) ?? activeWheel();
  return {
    creatorTitle: CREATOR_TITLE,
    brandColor: wheel.brandColor ?? "#ec4899",
    iconMode: mockGetMyPwaIconMode(),
    avatarUrl: null,
  };
}

// --- RM-3: visit glow (fan_checkins) ----------------------------------------

// fanId -> the calendar days that fan opened a link on. Outside Store (like the
// RM-4 state above) and pinned to globalThis so pages and routes share it.
const gGlow = globalThis as unknown as { __ffCheckins?: Map<string, Set<string>> };
function checkinStore(): Map<string, Set<string>> {
  return (gGlow.__ffCheckins ??= new Map());
}
function checkinDays(fanId: string): Set<string> {
  return checkinStore().get(fanId) ?? new Set();
}

/** The glow gate's view of a mock fan. */
function mockGlowGateInput(fan: MockFan): GlowGateInput {
  return { blockedAt: fan.blockedAt ?? null, paused: !!fan.selfExcludedAt, breakUntil: fan.breakUntil ?? null };
}

/** Parity with readFanGlow: the glow before this visit, or null when gated. */
function mockFanGlow(fan: MockFan, now: Date = new Date()): FanGlow | null {
  if (!glowGateOpen(mockGlowGateInput(fan), now)) return null;
  const days = checkinDays(fan.id);
  return computeGlow(days, glowAnchor(days, now));
}

/**
 * Parity with recordCheckin: an unknown or paused link is not_found, a blocked
 * fan (or one the gate closes) is not_allowed, else the day is recorded once.
 * Touches nothing but the check-in set: no balance, pass or spin.
 */
export function mockRecordCheckin(
  token: string,
  localDate: unknown,
  now: Date = new Date()
): ({ ok: true } & CheckinResult) | { error: string } {
  const fan = fanForToken(token);
  if (!fan || fan.selfExcludedAt) return { error: "not_found" };
  if (!glowGateOpen(mockGlowGateInput(fan), now)) return { error: "not_allowed" };
  const day = clampCheckinDay(localDate, now);
  const all = checkinStore();
  const set = all.get(fan.id) ?? new Set<string>();
  all.set(fan.id, set);
  const fresh = !set.has(day);
  set.add(day);
  // Same read window as the Supabase path, so both decide milestones alike.
  const from = addDays(day, -(CHECKIN_READ_DAYS - 1));
  const to = latestCheckinDay(now);
  const window = new Set([...set].filter((d) => d >= from && d <= to));
  return { ok: true, ...checkinResult(window, day, fresh, now) };
}

// --- RM-5: win-back outreach log (parity with public.fan_outreach) -----------

// Kept outside Store (like the RM-4 state above); pinned to globalThis so pages
// and route handlers share it. Append-only, as the table is for creators.
interface MockOutreach extends OutreachRow {
  templateId: string | null;
  createdAt: string;
}
const gOutreach = globalThis as unknown as { __ffOutreach?: MockOutreach[] };
function outreachLog(): MockOutreach[] {
  return (gOutreach.__ffOutreach ??= []);
}

/** Log a win-back action for one of the demo creator's fans. */
export function mockRecordOutreach(
  fanId: string,
  action: OutreachAction,
  templateId: string | null,
  now: number = Date.now(),
): { ok: true } | { error: string } {
  if (!store.fans.has(fanId)) return { error: "not_found" };
  // Parity with the insert check: a template must be one of this creator's.
  const tpl = templateId && store.dmTemplates.some((t) => t.id === templateId) ? templateId : null;
  const at = new Date(now).toISOString();
  outreachLog().push({
    fanId,
    templateId: tpl,
    contactedAt: action === "contacted" ? at : null,
    snoozedUntil: action === "snoozed" ? new Date(now + WINBACK_SNOOZE_DAYS * 86_400_000).toISOString() : null,
    createdAt: at,
  });
  return { ok: true };
}

/** The outreach rows created at or after `sinceIso`, for the win-back maths. */
export function mockListOutreach(sinceIso: string): OutreachRow[] {
  return outreachLog()
    .filter((o) => o.createdAt >= sinceIso && store.fans.has(o.fanId))
    .map(({ fanId, contactedAt, snoozedUntil }) => ({ fanId, contactedAt, snoozedUntil }));
}

/** Clear the log (mockClearMyData) or one fan's rows (mockDeleteFan): the table cascades. */
function clearOutreach(fanId?: string) {
  gOutreach.__ffOutreach = fanId ? outreachLog().filter((o) => o.fanId !== fanId) : [];
}

/**
 * Demo/e2e only: move a fan's activity (wins, grants, links) `days` into the
 * past, so the win-back list can be exercised without waiting two weeks.
 * Reachable only through the mock-mode debug route.
 */
export function mockAgeFanActivity(fanId: string, days: number): { ok: true } | { error: string } {
  const fan = store.fans.get(fanId);
  if (!fan) return { error: "not_found" };
  const shift = (iso: string) => new Date(Date.parse(iso) - days * 86_400_000).toISOString();
  for (const w of fan.wins) w.at = shift(w.at);
  for (const p of fan.passes) p.createdAt = shift(p.createdAt);
  for (const g of store.grants) if (g.fanId === fanId) g.at = shift(g.at);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Privacy & safety (0054): audit log, creator notices, link tombstones, the
// fan's and the creator's "Download my data", and the fan's "Delete my data".
// Kept outside Store and pinned to globalThis like it.
// ---------------------------------------------------------------------------
interface MockAuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}
interface MockPrivacyStore {
  audit: MockAuditRow[];
  notices: { id: string; spinsKept: number; at: string }[];
  tombstones: Map<string, "creator_closed" | "fan_deleted">;
}
const gPrivacy = globalThis as unknown as { __ffPrivacy?: MockPrivacyStore };
const privacy: MockPrivacyStore = (gPrivacy.__ffPrivacy ??= {
  audit: [],
  notices: [],
  tombstones: new Map(),
});

export function mockRecordAudit(row: Omit<MockAuditRow, "id" | "created_at">): void {
  privacy.audit.unshift({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() });
  privacy.audit.length = Math.min(privacy.audit.length, 500);
}

export function mockListAudit(limit: number) {
  const label = (id: string | null) =>
    id ? store.accounts.find((a) => a.id === id)?.email ?? null : null;
  return structuredClone(
    privacy.audit.slice(0, limit).map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details,
      createdAt: r.created_at,
      actorLabel: label(r.actor_id),
      targetLabel: r.target_type === "profile" ? label(r.target_id) : null,
    }))
  );
}

export function mockGetFanDeletionNotices(): { id: string; spinsKept: number; at: string }[] {
  return structuredClone(privacy.notices);
}

/** The fan + the pass behind a token, whatever the link's state. */
function mockFanByAnyToken(token: string): { fan: MockFan; pass: MockPass | null } | null {
  const hit = passForToken(token);
  if (hit) return hit;
  const fan = fanForToken(token);
  return fan ? { fan, pass: fan.passes?.find((p) => p.token === token) ?? null } : null;
}

/** Why a link no longer opens, when its tombstone says (else null → 404). */
export async function mockGetFanLinkStatus(
  token: string
): Promise<"creator_closed" | "fan_deleted" | null> {
  return privacy.tombstones.get(await sha256Hex(token)) ?? null;
}

export function mockExportFanData(token: string): FanDataExport | null {
  const hit = mockFanByAnyToken(token);
  if (!hit) return null;
  const { fan } = hit;
  ensurePasses(fan);
  const wheelTitle = (id: string) => store.wheels.get(id)?.title ?? null;
  // Instant receipts outlive the recent-wins display. Read only metadata here:
  // calling mockGetFanReward would reveal values and increment view counters.
  const deliveries = [...rewardState().deliveries].filter(([, delivery]) => delivery.fanId === fan.id);
  const byShare = new Map<string, Partial<MockWin> & Pick<MockWin, "shareId" | "at" | "label" | "rarity">>(fan.wins.map((win) => [win.shareId, win]));
  for (const [shareId, delivery] of deliveries) if (!byShare.has(shareId)) byShare.set(shareId, { shareId, at: delivery.at, label: delivery.label, rarity: delivery.rarity, prizeId: delivery.prizeId });
  const wins = [...byShare.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.shareId.localeCompare(b.shareId));
  const out: FanDataExport = {
    format: FAN_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    about: FAN_EXPORT_ABOUT,
    ...exportStatus([], []),
    excluded: [...FAN_EXPORT_EXCLUDED],
    creator: { displayName: CREATOR_TITLE },
    profile: {
      displayName: fan.name ?? null,
      handle: fan.handle ?? null,
      joinedAt: fan.passes[0]?.createdAt ?? null,
      spinsRemaining: fan.spinsRemaining,
      spinsGrantedTotal: fan.spinsGrantedTotal,
      lastSpinAt: wins.at(-1)?.at ?? null,
      referralCode: fan.referralCode ?? null,
      joinedThroughAReferral: fan.referredByFanId !== null,
      friendsReferred: store.referrals.filter((r) => r.referrerFanId === fan.id).length,
    },
    consents: {
      ageAndTermsAcceptedAt: fan.ackedAt,
      termsVersion: fan.ackedTermsVersion ?? null,
      leaderboardOptIn: fan.leaderboardOptIn,
    },
    links: fan.passes.map((p) => ({
      linkEndsWith: maskToken(p.token),
      isThisLink: p.token === token,
      wheel: wheelTitle(p.wheelId),
      createdAt: p.createdAt,
      active: !fan.selfExcludedAt,
      pausedByYouAt: fan.selfExcludedAt,
      spinsRemaining: p.spinsRemaining,
      spinsGrantedTotal: p.spinsGrantedTotal,
      lastSpinAt: null,
    })),
    topUps: store.grants
      .filter((g) => g.fanId === fan.id)
      .map((g) => ({ at: g.at, spins: g.spins, bonusSpins: g.bonusSpins })),
    spins: wins.map((w) => ({
      gameKind: w.gameKind ?? "wheel", presentation: (w.presentation ?? null) as unknown as Json,
      id: w.shareId,
      at: w.at,
      prize: w.label,
      rarity: w.rarity,
      wheel: null,
      shareId: w.shareId ?? null,
      fairness: {
        version: w.fairVersion ?? null,
        serverSeed: w.serverSeed ?? null,
        serverSeedHash: w.serverSeedHash ?? null,
        clientSeed: w.clientSeed ?? null,
        nonce: w.nonce ?? null,
        seedCommitment: w.commitment ? JSON.stringify(w.commitment) : null,
        poolHash: w.poolHash ?? null,
        poolSnapshot: (w.poolSnapshot ?? null) as unknown as Json,
        trace: (w.fairTrace ?? null) as unknown as Json,
      },
    })),
    prizes: store.redemptions
      .filter((r) => r.fanId === fan.id)
      .map((r) => ({ spinId: null, prize: r.prizeLabel, status: r.status, wonAt: r.at, fulfilledAt: null })),
    instantReceipts: deliveries.sort(([a], [b]) => a.localeCompare(b)).map(([spinId, delivery]) => ({ spinId, kind: delivery.kind, views: delivery.views, lastViewedAt: delivery.lastViewedAt, createdAt: delivery.at, erasedAt: null })),
    focusPacks: [...mockFocusState().grants.values()].filter(grant => grant.focus.fan_id === fan.id).map(({ focus }) => ({ kind: focus.kind, prize: focus.prize_label ?? "Prize", multiplier: focus.multiplier, totalSpins: focus.total_spins, spinsLeft: focus.spins_left, chaseCounter: focus.chase_counter, status: focus.status === "completed" ? "done" : focus.status === "cancelled" ? "released" : focus.status, at: focus.created_at ?? null, endedAt: focus.ended_at ?? null })),
    spinAttempts: [...mockFocusState().attempts.values()].filter(attempt => attempt.fanId === fan.id).map(attempt => ({ status: !attempt.result || ("error" in attempt.result && attempt.result.error === "spin_pending") ? "pending" : "error" in attempt.result ? "declined" : "committed", error: attempt.result && "error" in attempt.result ? attempt.result.error : null, at: attempt.createdAt ?? null, finishedAt: attempt.finishedAt ?? null })),
    wishlist: store.wishlists
      .filter((w) => w.fanId === fan.id)
      .map((w) => ({ prize: w.prizeLabel, rarity: w.prizeRarity, addedAt: w.at })),
    play: { breakUntil: fan.breakUntil ?? null, reminderDaily: fan.playReminderDaily ?? null, reminderUpdatedAt: null },
    checkIns: [...checkinDays(fan.id)].sort().map((day) => ({ day, recordedAt: null })),
    outreach: outreachLog().filter((row) => row.fanId === fan.id).map((row) => ({ at: row.createdAt, contactedAt: row.contactedAt })),
    reportsYouSent: mockReports.filter((row) => (fan.passes ?? []).some((pass) => pass.token === row.token)).map((row) => ({ at: row.at, reason: row.reason, detail: row.detail })),
    messagesYouSent: store.messages
      .filter((m) => m.fanId === fan.id && m.sender === "fan")
      .map((m) => ({ at: m.at, body: m.body })),
  };
  for (const [name, value] of Object.entries(out)) {
    if (Array.isArray(value) && !["failed", "truncated", "excluded"].includes(name) && value.length > EXPORT_ROW_CAP) {
      (out as unknown as Record<string, unknown>)[name] = value.slice(0, EXPORT_ROW_CAP);
      out.truncated.push(name);
    }
  }
  Object.assign(out, exportStatus(out.failed, out.truncated));
  return safeExportValue(structuredClone(out), true) as FanDataExport;
}

/** "Delete my data" in the demo: the creator-side delete, plus a tombstone per
 *  link and a notice for the creator. The seeded demo fan can't be deleted
 *  (every demo journey uses its link). */
export async function mockDeleteFanData(
  token: string
): Promise<{ ok: true; spinsKept: number } | { error: string }> {
  const hit = mockFanByAnyToken(token);
  if (!hit) return { error: "not_found" };
  const { fan } = hit;
  if (fan.id === "demo-fan") return { error: "not_allowed" };
  const tokens = new Set([...store.tokens].filter(([, id]) => id === fan.id).map(([t]) => t));
  for (const p of fan.passes ?? []) tokens.add(p.token);
  const spinsKept = fan.wins.length;
  mockDeleteFan(fan.id);
  for (const t of tokens) privacy.tombstones.set(await sha256Hex(t), "fan_deleted");
  privacy.notices.unshift({ id: crypto.randomUUID(), spinsKept, at: new Date().toISOString() });
  return { ok: true, spinsKept };
}

/** The demo creator's "Download my data": everything in the in-memory store. */
export function mockExportCreatorData(): CreatorDataExport {
  const uid = "demo";
  const truncated: string[] = [];
  // Normalize demo business rows to the database export's field names. Strip
  // secret fields even when future demo rows acquire new nested properties.
  const snake = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(snake);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key === "at" ? "created_at" : key.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase()), snake(entry)]));
  };
  const rows = (name: string, values: unknown[]): Record<string, unknown>[] => {
    if (values.length > EXPORT_ROW_CAP) truncated.push(name);
    return safeExportValue(snake(structuredClone(values.slice(0, EXPORT_ROW_CAP)))) as Record<string, unknown>[];
  };
  const fanList = [...store.fans.values()];
  // Full manual and instant proof history is retained independently of UI display limits.
  const fans = fanList.map((fan) => ({
    id: fan.id, creator_id: uid, display_name: fan.name, handle: fan.handle ?? null,
    spins_remaining: fan.spinsRemaining, spins_granted_total: fan.spinsGrantedTotal,
    notes: fan.notes, tags: fan.tags, leaderboard_opt_in: fan.leaderboardOptIn,
    acked_at: fan.ackedAt, acked_terms_version: fan.ackedTermsVersion,
    blocked_at: fan.blockedAt ?? null, break_until: fan.breakUntil ?? null,
  }));
  const links = fanList.flatMap((fan) => (fan.passes ?? []).map((pass, index) => ({
    id: `mock-link-${fan.id}-${index}`, fan_id: fan.id, wheel_id: pass.wheelId,
    campaign_id: pass.campaignId, created_at: pass.createdAt, is_active: !fan.selfExcludedAt,
    self_excluded_at: fan.selfExcludedAt, spins_remaining: pass.spinsRemaining,
    spins_granted_total: pass.spinsGrantedTotal, next_server_seed_hash: pass.nextServerSeedHash ?? null,
    link_ends_with: maskToken(pass.token),
  })));
  const instant = [...rewardState().deliveries];
  const spins: Record<string, unknown>[] = fanList.flatMap((fan) => {
    const byShare = new Map<string, Partial<MockWin> & Pick<MockWin, "shareId" | "at" | "label" | "rarity">>(fan.wins.map((win) => [win.shareId, win]));
    for (const [shareId, delivery] of instant) if (delivery.fanId === fan.id && !byShare.has(shareId)) byShare.set(shareId, { shareId, at: delivery.at, label: delivery.label, rarity: delivery.rarity, prizeId: delivery.prizeId });
    return [...byShare.values()].sort((a, b) => a.shareId.localeCompare(b.shareId)).map((win) => ({
    id: win.shareId, fan_id: fan.id, creator_id: uid, prize_id: win.prizeId,
    prize_label: win.label, prize_rarity: win.rarity, created_at: win.at, share_id: win.shareId,
    server_seed: win.serverSeed, server_seed_hash: win.serverSeedHash, client_seed: win.clientSeed,
    nonce: win.nonce, seed_commitment: win.commitment ? JSON.stringify(win.commitment) : null,
    fair_version: win.fairVersion ?? null, pool_hash: win.poolHash ?? null,
    pool_snapshot: win.poolSnapshot ?? null, fair_trace: win.fairTrace ?? null,
    game_kind: win.gameKind ?? "wheel", presentation: win.presentation ?? null,
  }));
  });
  for (const win of mockFocusState().anonymousWins?.values() ?? []) spins.push({
    id: win.shareId, fan_id: null, creator_id: uid, prize_id: win.prizeId,
    prize_label: win.label, prize_rarity: win.rarity, created_at: win.at, share_id: win.shareId,
    server_seed: win.serverSeed, server_seed_hash: win.serverSeedHash, client_seed: win.clientSeed,
    nonce: win.nonce, seed_commitment: win.commitment ? JSON.stringify(win.commitment) : null,
    fair_version: win.fairVersion ?? null, pool_hash: win.poolHash ?? null,
    pool_snapshot: win.poolSnapshot ?? null, fair_trace: win.fairTrace ?? null,
    game_kind: win.gameKind ?? "wheel", presentation: win.presentation ?? null,
  });
  const push = (globalThis as unknown as { __ffPushStore?: {
    devices: { id: string; showDetails: boolean; userAgent: string | null; failures: number; lastSuccessAt: string | null; createdAt: string }[];
    log: Map<string, { tag: string; sentAt: number }>;
  } }).__ffPushStore;
  const sections = {
    wheels: rows("wheels", [...store.wheels.values()].map(({ prizes: _prizes, ...wheel }) => ({ ...wheel, creator_id: uid }))),
    prizes: rows("prizes", [...store.wheels.values()].flatMap((wheel) => wheel.prizes.map((prize) => ({ ...prize, wheel_id: wheel.id })))),
    campaigns: rows("campaigns", store.campaigns), campaign_packs: rows("campaign_packs", store.campaignPacks),
    prize_templates: rows("prize_templates", store.prizeTemplates), wheel_templates: rows("wheel_templates", store.wheelTemplates),
    dm_templates: rows("dm_templates", store.dmTemplates), happy_hours: rows("happy_hours", store.happyHours),
    webhooks: rows("webhooks", store.webhooks.map(({ id, event, createdAt }) => ({ id, event, createdAt }))),
    fans: rows("fans", fans), fan_links: rows("fan_links", links), grants: rows("grants", store.grants),
    spins: rows("spins", spins), redemptions: rows("redemptions", store.redemptions),
    prize_rewards: rows("prize_rewards", [...rewardState().prizes].filter(([, definition]) => definition.kind !== "codes").map(([prize_id, definition]) => ({ prize_id, creator_id: uid, kind: definition.kind, updated_at: null }))),
    prize_reward_codes: rows("prize_reward_codes", [...rewardState().prizes].flatMap(([prize_id, definition]) => definition.kind === "codes" ? definition.codes.map((code) => ({ id: code.id, prize_id, creator_id: uid, spin_id: code.shareId && code.shareId !== "reserved" ? code.shareId : null, assigned_at: code.shareId ? rewardState().deliveries.get(code.shareId)?.at ?? null : null, created_at: null, erased_at: code.erasedAt ?? null })) : [])),
    spin_rewards: rows("spin_rewards", instant.map(([spin_id, delivery]) => ({ spin_id, creator_id: uid, kind: delivery.kind, views: delivery.views, last_viewed_at: delivery.lastViewedAt, created_at: delivery.at, erased_at: null }))),
    focus_creator_config: rows("focus_creator_config", [{ creator_id: uid, focus_enabled: true, chase_enabled: mockFocusState().chaseEnabled }]),
    fan_focus: rows("fan_focus", [...mockFocusState().grants.values()].map(({ focus }) => ({ id: focus.id, creator_id: uid, fan_id: focus.fan_id, fan_pass_id: focus.fan_pass_id, wheel_id: focus.wheel_id, prize_id: focus.prize_id, prize_label: focus.prize_label, kind: focus.kind, multiplier: focus.multiplier, total_spins: focus.total_spins, spins_left: focus.spins_left, chase_counter: focus.chase_counter, status: focus.status === "completed" ? "done" : focus.status === "cancelled" ? "released" : focus.status, grant_id: focus.grant_id ?? null, version: focus.version ?? 0, created_at: focus.created_at ?? null, ended_at: focus.ended_at ?? null }))),
    chase_reservations: rows("chase_reservations", [...mockFocusState().grants.values()].filter(({ focus }) => focus.reservation).map(({ focus }) => ({ id: focus.id, focus_id: focus.id, creator_id: uid, prize_id: focus.prize_id, kind: focus.reservation!.kind, state: focus.reservation!.held ? "held" : focus.status === "completed" ? "consumed" : "released", created_at: focus.created_at ?? null, ended_at: focus.ended_at ?? null }))),
    spin_attempts: rows("spin_attempts", [...mockFocusState().attempts].map(([id, attempt]) => ({ id, creator_id: uid, fan_id: attempt.fanId, state: !attempt.result || ("error" in attempt.result && attempt.result.error === "spin_pending") ? "pending" : "error" in attempt.result ? "declined" : "committed", error: attempt.result && "error" in attempt.result ? attempt.result.error : null, spin_id: attempt.result && !("error" in attempt.result) ? id : null, created_at: attempt.createdAt ?? null, finished_at: attempt.finishedAt ?? null }))),
    fan_import_batches: rows("fan_import_batches", [...(mockFocusState().imports ?? [])].map(([id]) => ({ id, creator_id: uid, created_at: null }))),
    fan_import_items: rows("fan_import_items", [...(mockFocusState().imports ?? [])].flatMap(([batch_id, batch]) => batch.items.map(item => ({ batch_id, ordinal: item.ordinal, creator_id: uid, grant_id: item.grantId ?? null, error: item.error ?? null, created_at: null })))),
    creator_request_journal: rows("creator_request_journal", [...mockCreatorRequests().values()].map(entry => ({ id: entry.requestId, creator_id: uid, actor_id: uid, kind: entry.kind, state: entry.status, error: entry.status === "gone" ? "gone" : null, created_at: entry.createdAt, finished_at: entry.finishedAt ?? null }))),
    referrals: rows("referrals", store.referrals), messages: rows("messages", store.messages),
    wishlists: rows("wishlists", store.wishlists), creator_notices: rows("creator_notices", privacy.notices),
    fan_checkins: rows("fan_checkins", [...checkinStore()].flatMap(([fanId, days]) => [...days].sort().map((day) => ({ creator_id: uid, fan_id: fanId, day, created_at: null })))),
    fan_outreach: rows("fan_outreach", outreachLog()),
    creator_media: rows("creator_media", mockListMedia().map((photo) => ({ id: photo.id, creator_id: uid, caption: photo.caption, sort_order: photo.sortOrder, width: photo.width, height: photo.height, sfw_attested_at: photo.createdAt, created_at: photo.createdAt }))),
    storage_objects: [], storage_deletions: [], storage_dispatches: [],
    push_devices: rows("push_devices", (push?.devices ?? []).map((device) => ({ id: device.id, user_id: uid, user_agent: device.userAgent, show_details: device.showDetails, failures: device.failures, last_success_at: device.lastSuccessAt, created_at: device.createdAt }))),
    push_history: rows("push_history", [...(push?.log ?? [])].map(([itemId, log]) => ({ user_id: uid, item_id: itemId, tag: log.tag, sent_at: new Date(log.sentAt).toISOString() }))),
    autopilot_dismissals: [], access_request: [], agency_memberships: [], agencies_owned: [],
    agency_owned_members: [], agency_owned_scopes: [], agency_scopes: [], agency_invitations: [],
  };
  return {
    format: CREATOR_EXPORT_FORMAT, exportedAt: new Date().toISOString(), about: CREATOR_EXPORT_ABOUT,
    ...exportStatus([], truncated), excluded: [...CREATOR_EXPORT_EXCLUDED],
    account: { id: uid, theme: toDbTheme(mockGetTheme()), display_name: store.displayName, leaderboard_enabled: store.leaderboardEnabled,
      notify_new_spin: store.notifyNewSpin, notify_low_balance: store.notifyLowBalance,
      notify_messages: store.notifyMessages, chat_intro: store.chatIntro, chat_outro: store.chatOutro,
      pwa_icon_mode: mockGetMyPwaIconMode(), terms_version: mockGetMyTerms().version,
      terms_accepted_at: mockGetMyTerms().acceptedAt, demo: true },
    sections,
  };
}

// --- 0055: the demo creator's Terms acceptance --------------------------------

// The demo account starts accepted at the current version, so the dashboard's
// re-accept prompt only appears when a test makes the stored version stale.
type MockTerms = { version: string | null; acceptedAt: string | null };
const gTerms = globalThis as unknown as { __ffTerms?: MockTerms };

export function mockGetMyTerms(): MockTerms {
  return { ...(gTerms.__ffTerms ?? { version: LEGAL.version, acceptedAt: "2026-01-01T00:00:00.000Z" }) };
}

export function mockAcceptMyTerms(): { version: string; acceptedAt: string } {
  const rec = { version: LEGAL.version, acceptedAt: new Date().toISOString() };
  gTerms.__ffTerms = rec;
  return { ...rec };
}

// --- Web push: what the demo's latest win on a link means for the creator ----

/**
 * The push event for the win mockSpin JUST recorded on this link: its
 * redemption, the prize, and that prize's stock after the decrement (parity
 * with the Supabase path's notifyCreator call). Null when there is no win.
 */
export function mockSpinPushEvent(
  token: string
): { fanId: string; prizeId: string; stockAfter: number | null; redemptionId?: string } | null {
  const fan = fanForToken(token);
  const win = fan?.wins[0];
  if (!fan || !win?.prizeId) return null;
  const redemption = store.redemptions.find((r) => r.fanId === fan.id && r.at === win.at && r.prizeLabel === win.label);
  let stockAfter: number | null = null;
  for (const w of store.wheels.values()) {
    const p = w.prizes.find((x) => x.id === win.prizeId);
    if (p) {
      stockAfter = typeof p.stock === "number" ? p.stock : null;
      break;
    }
  }
  return { fanId: fan.id, prizeId: win.prizeId, stockAfter, ...(redemption ? { redemptionId: redemption.id } : {}) };
}

/** Web push engagement gate (demo): blocked, paused or on a break. Null = unknown fan. */
export function mockFanPushState(fanId: string): { blocked: boolean; selfExcluded: boolean; breakUntil: string | null } | null {
  const fan = store.fans.get(fanId);
  if (!fan) return null;
  return { blocked: !!fan.blockedAt, selfExcluded: !!fan.selfExcludedAt, breakUntil: fan.breakUntil ?? null };
}

/** The demo fan behind a link (web push: who a new message is from). */
export function mockFanIdForToken(token: string): string | null {
  return fanForToken(token)?.id ?? null;
}

// #26 instant-delivery prizes (mock mirror of migration 0057). The demo keeps
// reward values in server memory (it has no database and no key); the
// Supabase path encrypts them. Same rules either way: a code is handed out at
// most once, a code prize's stock IS its unused-code count, a prize that can't
// be delivered is never awarded, and only the winner's own link reveals it.
// ---------------------------------------------------------------------------

interface MockCode {
  id: string;
  erasedAt?: string;
  fingerprint: string;
  value: string;
  hint: string | null;
  /** The winning spin's share id once delivered (null = unused). */
  shareId: string | null;
  reservedFocusId?: string | null;
}
type MockPrizeReward = { kind: "link" | "text"; value: string } | { kind: "codes"; codes: MockCode[] };
interface MockDelivery {
  fanId: string;
  prizeId: string;
  fingerprint?: string;
  label: string;
  rarity: Rarity;
  kind: RewardKind;
  value: string;
  views: number;
  lastViewedAt: string | null;
  at: string;
}
const gRewards = globalThis as unknown as {
  __ffRewards?: { prizes: Map<string, MockPrizeReward>; deliveries: Map<string, MockDelivery>; fingerprintKey?: Buffer; consumedFingerprints?: Map<string, Set<string>> };
};
function rewardState(): NonNullable<typeof gRewards.__ffRewards> {
  return (gRewards.__ffRewards ??= { prizes: new Map(), deliveries: new Map() });
}

/** Demo-only secret-keyed identity survives erasure without retaining code text. */
function mockCodeFingerprint(prizeId: string, code: string): string {
  const state = rewardState();
  const key = (state.fingerprintKey ??= randomBytes(32));
  return demoCodeFingerprint(key, prizeId, code);
}

/** The live prize object (mutable) on whichever wheel holds it. */
function findMockPrize(prizeId: string): Prize | null {
  for (const w of store.wheels.values()) {
    const p = w.prizes.find((x) => x.id === prizeId);
    if (p) return p;
  }
  return null;
}

const freeCodes = (r: MockPrizeReward | undefined): MockCode[] =>
  r?.kind === "codes" ? r.codes.filter((c) => c.shareId === null && !c.reservedFocusId) : [];

/**
 * Keep every prize's delivery (and a code prize's stock) in line with the
 * reward store, whatever the editor sent: the mirror of saveWheel never
 * writing `delivery` and of trg_sync_code_prize_stock.
 */
function syncMockPrizeDelivery(p: Prize) {
  const r = rewardState().prizes.get(p.id);
  if (!r) {
    p.delivery = "manual";
    return;
  }
  p.delivery = r.kind;
  if (r.kind === "codes") p.stock = freeCodes(r).length;
}

/** After a save: delivery from the store, and rewards of removed prizes dropped. */
function syncMockWheelRewards(wheel: WheelConfig) {
  for (const p of wheel.prizes) syncMockPrizeDelivery(p);
  const live = new Set([...store.wheels.values()].flatMap((w) => w.prizes.map((p) => p.id)));
  for (const id of [...rewardState().prizes.keys()]) if (!live.has(id)) rewardState().prizes.delete(id);
}

export function mockGetPrizeDelivery(prizeId: string): PrizeDeliveryView | { error: "not_found" } {
  const prize = findMockPrize(prizeId);
  if (!prize) return { error: "not_found" };
  syncMockPrizeDelivery(prize);
  const r = rewardState().prizes.get(prizeId);
  const free = freeCodes(r);
  return {
    prizeId,
    delivery: prize.delivery ?? "manual",
    ready: true,
    value: r && r.kind !== "codes" ? r.value : null,
    codesLeft: free.length,
    codesUsed: r?.kind === "codes" ? r.codes.filter(code => code.shareId !== null).length : 0,
    preview: free.slice(0, CODE_PREVIEW_COUNT).map((c) => maskCode(c.hint)),
  };
}

/** Manual, a link or a text. Leaving a code list drops its unused codes; stock stays as a plain limit. */
export function mockSetPrizeDelivery(
  prizeId: string,
  kind: "manual" | "link" | "text",
  value: string | null,
): PrizeDeliveryView | { error: "not_found" } {
  const prize = findMockPrize(prizeId);
  if (!prize) return { error: "not_found" };
  for (const focus of mockFocusState().focuses.values()) if (focus.prize_id === prizeId) mockCancelFanFocus(focus.fan_id);
  const state = rewardState().prizes;
  if (kind === "manual" || value === null) state.delete(prizeId);
  else state.set(prizeId, { kind, value });
  prize.delivery = kind === "manual" || value === null ? "manual" : kind;
  return mockGetPrizeDelivery(prizeId);
}

/** Append codes and make the prize a code list (stock = unused codes). */
export function mockAddPrizeCodes(
  prizeId: string,
  codes: string[],
): (PrizeDeliveryView & { added: number; duplicates: number }) | { error: "not_found" | "too_many_codes" } {
  const prize = findMockPrize(prizeId);
  if (!prize) return { error: "not_found" };
  const state = rewardState().prizes;
  const current = state.get(prizeId);
  const kept = current?.kind === "codes" ? current.codes : [];
  const known = new Set([...(rewardState().consumedFingerprints?.get(prizeId) ?? []), ...kept.map((c) => c.fingerprint)]);
  for (const d of rewardState().deliveries.values()) if (d.kind === "code" && d.prizeId === prizeId && d.fingerprint) known.add(d.fingerprint);
  const fresh: string[] = [];
  for (const value of codes) {
    const fingerprint = mockCodeFingerprint(prizeId, value);
    if (!known.has(fingerprint)) { known.add(fingerprint); fresh.push(value); }
  }
  if (freeCodes(current).length + fresh.length > MAX_CODES_PER_PRIZE) return { error: "too_many_codes" };
  state.set(prizeId, {
    kind: "codes",
    codes: [...kept, ...fresh.map((value) => ({ id: genId("code"), fingerprint: mockCodeFingerprint(prizeId, value), value, hint: codeHint(value), shareId: null }))],
  });
  syncMockPrizeDelivery(prize);
  return { ...mockGetPrizeDelivery(prizeId) as PrizeDeliveryView, added: fresh.length, duplicates: codes.length - fresh.length };
}

/**
 * Inside mockSpin's draw (synchronous, so atomic like the prize-row lock):
 * can this prize be delivered right now? Code prizes take their code here.
 * `ok: false` = treat as sold out (excluded and re-drawn).
 */
function mockRewardAvailable(prize: Prize, ownReservedCodeId?: string): boolean {
  const delivery = prize.delivery ?? "manual";
  if (delivery === "manual") return true;
  const reward = rewardState().prizes.get(prize.id);
  if (delivery === "codes") return !!(ownReservedCodeId && reward?.kind === "codes" ? reward.codes.find(code => code.id === ownReservedCodeId && code.shareId === null) : freeCodes(reward)[0]);
  return !!reward && reward.kind !== "codes";
}

function mockTakeReward(prize: Prize, ownReservedCodeId?: string): { ok: true; reward: { kind: RewardKind; value: string; code?: MockCode } | null } | { ok: false } {
  const delivery = prize.delivery ?? "manual";
  if (delivery === "manual") return { ok: true, reward: null };
  const r = rewardState().prizes.get(prize.id);
  if (delivery === "codes") {
    const code = ownReservedCodeId && r?.kind === "codes" ? r.codes.find(c => c.id === ownReservedCodeId && c.shareId === null) : freeCodes(r)[0];
    if (!code) return { ok: false };
    code.shareId = "reserved";
    code.reservedFocusId = null;
    return { ok: true, reward: { kind: "code", value: code.value, code } };
  }
  if (!r || r.kind === "codes") return { ok: false };
  return { ok: true, reward: { kind: r.kind, value: r.value } };
}

function mockRecordDelivery(shareId: string, fanId: string, reward: { kind: RewardKind; value: string; code?: MockCode }, at: string, prize: Prize) {
  if (reward.code) reward.code.shareId = shareId;
  rewardState().deliveries.set(shareId, { fanId, prizeId: prize.id, ...(reward.code ? { fingerprint: reward.code.fingerprint } : {}), label: prize.label, rarity: prize.rarity, kind: reward.kind, value: reward.value, views: 0, lastViewedAt: null, at });
}

/** Logs only values actually present in one outgoing token-authorized response. */
function mockRecordRewardDisclosures(token:string,result:import("@/lib/games/wheel/types").SpinResult & {bonusWins?:{shareId:string;reward?:DeliveredReward}[]}):boolean {
  const values=[...(result.reward&&result.shareId?[{shareId:result.shareId,reward:result.reward}]:[]),...(result.bonusWins??[]).flatMap(bonus=>bonus.reward?[{shareId:bonus.shareId,reward:bonus.reward}]:[])];
  if(!values.length)return true;
  if(values.length>5||new Set(values.map(value=>value.shareId)).size!==values.length)return false;
  try{
    const fan=liveFanForToken(token);if("error"in fan)return false;
    const state=rewardState(),rows=values.map(value=>({value,row:state.deliveries.get(value.shareId)}));
    if(rows.some(({value,row})=>!row||row.fanId!==fan.id||row.kind!==value.reward.kind||row.value!==value.reward.value||!Number.isSafeInteger(row.views)||row.views>=Number.MAX_SAFE_INTEGER))return false;
    const next=new Map(state.deliveries),at=new Date().toISOString();
    for(const {value,row} of rows)next.set(value.shareId,{...row!,views:row!.views+1,lastViewedAt:at});
    state.deliveries=next;return true;
  }catch{return false;}
}

/** A fan re-opens their own reward (F5 rules: unknown 404, paused/blocked 403). */
export function mockGetFanReward(
  token: string,
  shareId: string,
): { reward: DeliveredReward; views: number } | { error: "not_found" | "blocked" | "not_allowed" } {
  const fan = liveFanForToken(token);
  if ("error" in fan) return fan;
  const d = rewardState().deliveries.get(shareId);
  // Another fan's win looks exactly like no win: no oracle for share ids.
  if (!d || d.fanId !== fan.id) return { error: "not_found" };
  if (!rewardReviewAllowed(d.at)) return { error: "not_allowed" };
  d.views += 1;
  d.lastViewedAt = new Date().toISOString();
  return { reward: { kind: d.kind, value: d.value }, views: d.views };
}

/** Fulfilment's "Auto" tag for a mock redemption (never the value). */
function mockAutoInfo(shareId: string | undefined): RedemptionItem["auto"] {
  const d = shareId ? rewardState().deliveries.get(shareId) : undefined;
  return d ? { kind: d.kind, views: d.views, lastViewedAt: d.lastViewedAt } : undefined;
}

/** Full instant history, independent of the recent-wins display cap. */
export function mockGetFanRewardHistory(token: string, cursor?: string): InstantRewardHistory | { error: "not_found" | "blocked" | "bad_request" } {
  const fan = liveFanForToken(token);
  if ("error" in fan) return fan;
  const decoded = cursor === undefined ? null : decodeRewardHistoryCursor(cursor);
  if (cursor !== undefined && !decoded) return { error: "bad_request" };
  const all = [...rewardState().deliveries].filter(([, d]) => d.fanId === fan.id)
    .map(([shareId, d]) => ({ shareId, label: d.label, rarity: d.rarity, at: d.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.shareId.localeCompare(a.shareId));
  const anchor = decoded ? all.findIndex((w) => w.shareId === decoded.shareId && rewardHistoryTimestamp(w.at) === decoded.at) : -1;
  if (decoded && anchor < 0) return { error: "bad_request" };
  const rows = all.slice(anchor + 1, anchor + 1 + REWARD_HISTORY_PAGE_SIZE + 1);
  const wins = rows.slice(0, REWARD_HISTORY_PAGE_SIZE);
  const last = wins.at(-1);
  return { wins, nextCursor: rows.length > REWARD_HISTORY_PAGE_SIZE && last ? encodeRewardHistoryCursor(last) : null };
}

export function mockIsInstantRedemption(id: string): boolean {
  const row = store.redemptions.find((r) => r.id === id);
  return !!row?.auto || (!!row?.shareId && rewardState().deliveries.has(row.shareId));
}

/** Remove all values for this fan, including wins older than the50-row display. */
function mockEraseFanRewards(fanId: string): void {
  const state = rewardState();
  const tombstones = (state.consumedFingerprints ??= new Map<string, Set<string>>());
  for (const [shareId, d] of [...state.deliveries]) if (d.fanId === fanId) {
    for (const row of store.redemptions) if (row.shareId === shareId) row.auto = {kind:d.kind,views:d.views,lastViewedAt:d.lastViewedAt};
    if (d.kind === "code" && d.fingerprint) {
      const known = tombstones.get(d.prizeId) ?? new Set<string>(); known.add(d.fingerprint); tombstones.set(d.prizeId,known);
      const prize = state.prizes.get(d.prizeId);
      if (prize?.kind === "codes") for (const code of prize.codes) if (code.shareId === shareId) {
        code.value = ""; code.hint = null; code.erasedAt = new Date().toISOString();
      }
    }
    state.deliveries.delete(shareId);
  }
}

/** Focus/chase demo parity: separate promise state; credits remain on the ordinary pass. */
export function mockGetFanFocus(token: string) {
  const fan = liveFanForToken(token);
  if ("error" in fan) return null;
  const row = mockFocusState().focuses.get(fan.id);
  return row && (row.status === "active" || row.status === "paused") ? toFanFocusView(row) : null;
}
function mockPassId(pass: MockPass): string { return pass.id ??= crypto.randomUUID(); }
export function mockGetCreatorFocus(fanId: string): import("./focusView").CreatorFocusView | import("./focus").FocusError {
  const fan = store.fans.get(fanId);
  if (!fan) return { error: "not_found" };
  ensurePasses(fan);
  const row = mockFocusState().focuses.get(fanId);
  const focusPass = row ? fan.passes.find(pass => mockPassId(pass) === row.fan_pass_id) : undefined;
  const focus = row && (row.status === "active" || row.status === "paused") ? mockFanFocusDisplay(focusPass?.token ?? fan.primaryToken).focus : null;
  const targets = [...store.wheels.values()].filter(w => !w.archivedAt).flatMap(w => w.prizes.filter(p => p.boostable).map(p => ({
    id: p.id, label: p.label, wishlisted: store.wishlists.some(wish => wish.fanId === fanId && wish.prizeId === p.id), ...(p.emoji ? { emoji: p.emoji } : {}), rarity: p.rarity, weight: p.weight, wheelId: w.id, wheelTitle: w.title,
    available: p.stock == null || p.stock > 0, finite: p.stock != null, delivery: p.delivery ?? "manual",
  })));
  return { focusId: focus ? row!.id : null, focus, targets, passes: fan.selfExcludedAt ? [] : fan.passes.map(p => ({ id: mockPassId(p), wheelId: mockResolvedSpinWheelId(p), wheelTitle: store.wheels.get(mockResolvedSpinWheelId(p))?.title ?? "Wheel", spinsRemaining: p.spinsRemaining })),
    packs: structuredClone(store.campaignPacks.filter(p => p.packKind === "focus" || p.packKind === "chase")), focusEnabled: true, chaseEnabled: mockFocusState().chaseEnabled,
    canGrant: fanEngagementAllowed({ blocked: !!fan.blockedAt, selfExcluded: !!fan.selfExcludedAt, breakUntil: fan.breakUntil }) && !focus,
    ...(fan.blockedAt ? { blockedReason: "blocked" as const } : fan.selfExcludedAt ? { blockedReason: "self_excluded" as const } : isOnBreak(fan.breakUntil) ? { blockedReason: "on_break" as const } : focus ? { blockedReason: "active_focus" as const } : {}),
  };
}
export function mockGrantFocusPack(fanId: string, input: { requestId: string; packId: string; prizeId: string; passId: string }): { focus: import("./focusView").FanFocusView | null; spinsRemaining: number; grantId: string; replayed: boolean } | import("./focus").FocusError {
  input = { ...input, requestId: input.requestId.toLowerCase() };
  const hash = serverCreatorIntentHash("focus", [fanId,input.packId,input.prizeId,input.passId]);
  const gate = beginMockCreatorRequest(input.requestId, "focus", hash, { fanId, passId: input.passId });
  if (gate !== "ready" && gate !== "committed") return { error: gate };
  const reject = (error: import("./focus").FocusError["error"]): import("./focus").FocusError => { finishMockCreatorRequest(input.requestId, "rejected"); return { error }; };
  const fan = store.fans.get(fanId);
  if (!fan) return reject("unavailable");
  const state = mockFocusState();
  const prior = state.grants.get(input.requestId);
  if (prior) return prior.hash === hash ? { focus: toFanFocusView(state.focuses.get(fanId)?.id === prior.focus.id ? state.focuses.get(fanId) : prior.focus), spinsRemaining: fan.passes.find(p => mockPassId(p) === input.passId)?.spinsRemaining ?? prior.balance, grantId: prior.grantId, replayed: true } : { error: "conflict" };
  if (!fanEngagementAllowed({ blocked: !!fan.blockedAt, selfExcluded: !!fan.selfExcludedAt, breakUntil: fan.breakUntil })) return reject("unavailable");
  if (gate === "committed") return { error: "gone" };
  const current = state.focuses.get(fanId);
  if (current && (current.status === "active" || current.status === "paused")) return reject("focus_exists");
  const pack = store.campaignPacks.find(p => p.id === input.packId);
  // Demo mirrors the default server rollout: chase disabled until explicitly enabled on TEST.
  if (!pack || (pack.packKind !== "focus" && pack.packKind !== "chase") || (pack.packKind === "chase" && !state.chaseEnabled)) return reject("invalid_pack");
  const pass = fan.passes.find(p => mockPassId(p) === input.passId);
  const wheel = pass && store.wheels.get(mockResolvedSpinWheelId(pass));
  const prize = wheel?.prizes.find(p => p.id === input.prizeId);
  if (!pass || !wheel || wheel.archivedAt || !prize?.boostable || (pack.packKind === "focus" && prize.weight <= 0) || (pack.campaignId && pack.campaignId !== pass.campaignId)) return reject("invalid_target");
  if (prize.stock != null && prize.stock <= 0) return reject("sold_out");
  const total = pack.packKind === "chase" ? pack.chaseWithin ?? 10 : pack.focusSpins ?? 10;
  const multiplier = pack.focusMultiplier ?? 3;
  if (!isFocusLength(total) || !isFocusMultiplier(multiplier) || pack.spins + pack.bonusSpins < total) return reject("invalid_pack");
  const checkpoint = mockEconomicCheckpoint();
  const originalStock = prize.stock;
  let heldCode: MockCode | null = null;
  const id = crypto.randomUUID();
  try {
  let reservation: MockFocus["reservation"] = null;
  if (pack.packKind === "chase") {
    if (prize.delivery === "codes") {
      const reward = rewardState().prizes.get(prize.id);
      const code = freeCodes(reward)[0];
      if (!code) return reject("sold_out");
      heldCode = code;
      code.reservedFocusId = id;
      syncMockPrizeDelivery(prize);
      reservation = { kind: "code", codeId: code.id, held: true };
    } else if (typeof prize.stock === "number") {
      prize.stock -= 1; reservation = { kind: "stock", held: true };
    } else reservation = { kind: "unlimited", held: true };
  }
  const row: MockFocus = { id, fan_id: fanId, fan_pass_id: input.passId, wheel_id: wheel.id, kind: pack.packKind,
    prize_id: prize.id, prize_label: prize.label, prize_emoji: prize.emoji, multiplier, total_spins: total, spins_left: total, chase_counter: 0,
    status: "active", reservation, grant_id: input.requestId, version: 0, created_at: new Date().toISOString(), ended_at: null };
  pass.spinsRemaining += pack.spins + pack.bonusSpins;
  pass.spinsGrantedTotal += pack.spins + pack.bonusSpins;
  recomputeFanAggregate(fan);
  store.grants.push({ id: input.requestId, fanId, passToken: pass.token, campaignId: pass.campaignId, spins: pack.spins + pack.bonusSpins, amountCents: pack.amountCents, bonusSpins: pack.bonusSpins, at: new Date().toISOString() });
  state.focuses.set(fanId, row);
  state.grants.set(input.requestId, { hash, focus: row, balance: pass.spinsRemaining, grantId: input.requestId });
  finishMockCreatorRequest(input.requestId, "committed", { fanId, passId: input.passId, grantId: input.requestId });
  return { focus: toFanFocusView(row), spinsRemaining: pass.spinsRemaining, grantId: input.requestId, replayed: false };
  } catch {
    restoreMockEconomicCheckpoint(checkpoint);
    if (heldCode) heldCode.reservedFocusId = null;
    prize.stock = originalStock;
    return { error: "db_error" };
  }
}
export function mockCancelFanFocus(fanId: string, expectedFocusId?: string): { released: boolean; focus: import("./focusView").FanFocusView | null } | import("./focus").FocusError {
  if (!store.fans.has(fanId)) return { error: "not_found" };
  const row = mockFocusState().focuses.get(fanId);
  if (!row || (expectedFocusId != null && row.id !== expectedFocusId) || (row.status !== "active" && row.status !== "paused")) return { released: false, focus: null };
  if (row.reservation?.held) {
    const prize = findMockPrize(row.prize_id);
    if (row.reservation.kind === "code") {
      const reward = rewardState().prizes.get(row.prize_id);
      const code = reward?.kind === "codes" ? reward.codes.find(c => c.id === row.reservation?.codeId && c.shareId === null) : null;
      if (code) code.reservedFocusId = null;
      if (prize) syncMockPrizeDelivery(prize);
    } else if (row.reservation.kind === "stock" && prize && typeof prize.stock === "number") prize.stock += 1;
    row.reservation.held = false;
  }
  row.status = "cancelled";
  row.version = (row.version ?? 0) + 1; row.ended_at = new Date().toISOString();
  return { released: true, focus: toFanFocusView(row) };
}

export function mockFanFocusState(token: string): { focus: import("./focusView").FanFocusView | null; odds?: import("./focusView").FanOddsView; stock?: Record<string, import("@/lib/games/wheel/types").PublicStock> } | { error: "not_found" | "blocked" } {
  const fan = liveFanForToken(token);
  return "error" in fan ? fan : mockFanFocusDisplay(token);
}

export function mockFanFocusDisplay(token: string): { focus: import("./focusView").FanFocusView | null; odds?: import("./focusView").FanOddsView; stock?: Record<string, import("@/lib/games/wheel/types").PublicStock> } {
  const found = passForToken(token);
  if (!found || found.fan.blockedAt || found.fan.selfExcludedAt) return { focus: null };
  const row = mockFocusState().focuses.get(found.fan.id);
  const wheel = structuredClone(store.wheels.get(mockResolvedSpinWheelId(found.pass)) ?? activeWheel());
  if (row?.kind === "chase" && row.reservation?.held) {
    const target = wheel.prizes.find(prize => prize.id === row.prize_id);
    if (target && typeof target.stock === "number") target.stock += 1;
  }
  const hh = mockGetActiveHappyHour(wheel.id);
  return focusDisplay(row, wheel, { pityCounter: found.fan.pityCounter, happyHourMultiplier: hh.active ? hh.multiplier : null, reserved: row?.reservation?.held === true, breakUntil: found.fan.breakUntil });
}

/** Atomic demo import: only the validated subset writes, and a lost response replays IDs. */
export function mockImportFans(batchId: string, requestHash: string, rows: import("@/lib/imports/batch").ImportSlot[]): import("@/lib/imports/batch").ImportBatchResult {
  batchId = batchId.toLowerCase();
  if (!isUuid(batchId) || rows.length < 1 || rows.length > 500 || serverImportHash(rows) !== requestHash) return { status: "conflict" };
  const gate = beginMockCreatorRequest(batchId, "import", requestHash, { batchId });
  if (gate !== "ready" && gate !== "committed") return { status: gate === "conflict" ? "conflict" : "unavailable" };
  const batches = mockFocusState().imports ??= new Map();
  const previous = batches.get(batchId);
  const receipt = (items: import("@/lib/imports/batch").ImportBatchItem[], replayed: boolean): import("@/lib/imports/batch").ImportBatchResult => ({
    status: "imported", batchId, replayed, items: items.map(item => {
      if (item.error) return { ordinal: item.ordinal, error: item.error };
      const fan = item.fanId ? store.fans.get(item.fanId) : null;
      const pass = fan?.passes.find(pass => mockPassId(pass) === item.passId);
      const grant = store.grants.find(grant => grant.id === item.grantId && grant.fanId === item.fanId && grant.passToken === pass?.token);
      return pass && grant ? { ...item, token: pass.token } : { ordinal: item.ordinal, error: "gone" };
    }),
  });
  if (previous) return previous.hash === requestHash ? receipt(previous.items, true) : { status: "conflict" };
  if (gate === "committed") return { status: "unavailable" };
  const checkpoint = { fans: structuredClone(store.fans), tokens: new Map(store.tokens), tokenCampaign: new Map(store.tokenCampaign), grants: structuredClone(store.grants.slice()), referrals: structuredClone(store.referrals) };
  const items: import("@/lib/imports/batch").ImportBatchItem[] = [];
  try {
    for (const [ordinal, row] of rows.entries()) {
      if (row.error) { items.push({ ordinal, error: row.error }); continue; }
      if (row.campaignId && !store.campaigns.some(campaign => campaign.id === row.campaignId)) { items.push({ ordinal, error: "campaign_not_found" }); continue; }
      const wheel = row.wheelId ? store.wheels.get(row.wheelId) : activeWheel();
      if (!wheel || wheel.archivedAt) { items.push({ ordinal, error: "no_wheel" }); continue; }
      const created = mockCreatePassOnce(row.name, row.spins, undefined, row.campaignId ?? undefined, row.amountCents, 0, undefined, undefined, row.wheelId ?? undefined);
      const pass = passForToken(created.token)?.pass;
      const grant = store.grants.at(-1);
      if (!pass || !grant || grant.fanId !== created.fanId || grant.passToken !== created.token) throw new Error("incomplete_import");
      items.push({ ordinal, fanId: created.fanId, passId: mockPassId(pass), grantId: grant.id });
    }
    batches.set(batchId, { hash: requestHash, items: structuredClone(items) });
    finishMockCreatorRequest(batchId, "committed", { batchId });
    return receipt(items, false);
  } catch {
    restoreMockEconomicCheckpoint(checkpoint);
    return { status: "unavailable" };
  }
}

function mockEconomicCheckpoint() {
  return { fans: structuredClone(store.fans), tokens: new Map(store.tokens), tokenCampaign: new Map(store.tokenCampaign), grants: structuredClone(store.grants.slice()), referrals: structuredClone(store.referrals) };
}
function restoreMockEconomicCheckpoint(checkpoint: ReturnType<typeof mockEconomicCheckpoint>) {
  // Preserve existing fan/pass object identities held by an in-flight hash/draw.
  for (const id of store.fans.keys()) if (!checkpoint.fans.has(id)) store.fans.delete(id);
  for (const [id, saved] of checkpoint.fans) {
    const current = store.fans.get(id);
    if (!current) { store.fans.set(id, saved); continue; }
    const passes = saved.passes.map(pass => {
      const existing = current.passes.find(candidate => candidate.token === pass.token);
      return existing ? Object.assign(existing, pass) : pass;
    });
    Object.assign(current, saved, { passes });
  }
  store.tokens = checkpoint.tokens; store.tokenCampaign = checkpoint.tokenCampaign;
  store.grants = checkpoint.grants; store.referrals = checkpoint.referrals;
}
export function mockReconcileCreatorRequest(requestId: string, kind: import("@/lib/creatorRequests").CreatorRequestKind, cancel: boolean): import("@/lib/creatorRequests").CreatorRequestResult {
  return reconcileMockCreatorRequest(requestId, kind, cancel);
}
