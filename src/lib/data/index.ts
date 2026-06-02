import {
  isSupabaseConfigured,
  createServiceClient,
  createClient,
} from "@/lib/supabase/server";
import { externalUrl } from "@/lib/format";
import { pickPrizeWithPity, applyRareBoost } from "@/lib/games/wheel/engine";
import { randomSeedHex, sha256Hex, makeRng } from "@/lib/games/wheel/fairness";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import type { Prize, Rarity, SpinResult, WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_COLORS, RARITY_ORDER } from "@/lib/games/wheel/types";
import type {
  AdminAccount,
  AdminOverview,
  AppRole,
  Campaign,
  CampaignPack,
  CampaignStats,
  CohortRow,
  CreatorMetricsExtra,
  CreatorOverview,
  DmTemplate,
  EngagementHeatmap,
  PrizeRoiRow,
  FanAccountSummary,
  FanCampaignBreakdown,
  FanDetail,
  FanPassView,
  Grant,
  PrizeTemplate,
  RedemptionItem,
  RedemptionStatus,
  WheelSummary,
  WheelTemplate,
  ShareCardData,
  WishlistItem,
  WishlistDemand,
  LeaderboardView,
  LeaderboardEntry,
  HappyHour,
  HappyHourStatus,
  ReferralOverview,
  ChatMessage,
  ChatSettings,
  FanThread,
  SpinVerification,
  Webhook,
} from "./types";
import { bucketByDay, bucketCentsByDay, clampDays } from "./metrics";
import {
  mockGetFanPass,
  mockSpin,
  mockCreatePass,
  mockGrantSpins,
  mockListFans,
  mockGetFanDetail,
  mockGetOverview,
  mockGetMetricsExtra,
  mockGetEngagementHeatmap,
  mockGetPrizeRoi,
  mockGetProfitSummary,
  mockGetCohortRetention,
  mockSetRedemptionStatus,
  mockSetRedemptionMeta,
  mockGetWheel,
  mockSaveWheel,
  mockGetAdminOverview,
  mockUpdateAccount,
  mockCreateAccount,
  mockCreateCampaign,
  mockListCampaigns,
  mockGetCampaignStats,
  mockDeleteFan,
  mockUpdateFanMeta,
  mockListDmTemplates,
  mockCreateDmTemplate,
  mockDeleteDmTemplate,
  mockListWheels,
  mockGetWheelById,
  mockCreateWheel,
  mockDuplicateWheel,
  mockArchiveWheel,
  mockUnarchiveWheel,
  mockDeleteWheel,
  mockSetActiveWheel,
  mockSetWheelSchedule,
  mockListCampaignPacks,
  mockCreateCampaignPack,
  mockUpdateCampaignPack,
  mockDeleteCampaignPack,
  mockSetCampaignPinnedWheel,
  mockRenameCampaign,
  mockDeleteCampaign,
  mockClearMyData,
  mockListPrizeTemplates,
  mockCreatePrizeTemplate,
  mockDeletePrizeTemplate,
  mockListWheelTemplates,
  mockCreateWheelTemplate,
  mockDeleteWheelTemplate,
  mockListHappyHours,
  mockCreateHappyHour,
  mockDeleteHappyHour,
  mockGetShareCard,
  mockAddWishlist,
  mockRemoveWishlist,
  mockGetWishlistDemand,
  mockSetLeaderboardEnabled,
  mockSetFanLeaderboardOptIn,
  mockGetLeaderboard,
  mockGetRecentWins,
  mockGetReferralOverview,
  mockGetReferralStats,
  mockSendFanMessage,
  mockGetFanMessages,
  mockListThreads,
  mockGetThread,
  mockSendCreatorMessage,
  mockGetChatSettings,
  mockSetChatSettings,
  mockEnsureChatIntro,
  mockSendChatOutro,
  mockGetPublicWheelTeaser,
  mockGetSpinVerification,
  mockListWebhooks,
  mockCreateWebhook,
  mockDeleteWebhook,
  mockFireWebhooks,
  mockAckFan,
} from "./mock";

function randomToken(): string {
  // URL-safe, unguessable token for a fan link.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type { FanPassView } from "./types";
export type SpinError = { error: "not_found" | "no_spins" | "no_prizes" | "rate_limited" | "blocked" };

// Phase 3 referral economy: how many referrals a fan can be credited for, and
// how many bonus spins each credited referral grants to BOTH parties.
const REFERRAL_CAP = 3;
const REFERRAL_BONUS = 3;

// Shapes of the Supabase rows we read (keeps us off `any`).
interface DbPrizeRow {
  id: string;
  label: string;
  description: string | null;
  rarity: Rarity;
  weight: number;
  color: string | null;
  emoji: string | null;
  image_url: string | null;
  cost_cents: number | null;
  stock: number | null;
  sort_order: number | null;
}
interface DbWheelRow {
  id: string;
  title: string;
  subtitle: string | null;
  brand_color: string | null;
  is_active?: boolean;
  active_from?: string | null;
  active_until?: string | null;
  archived_at?: string | null;
  prizes: DbPrizeRow[];
}

// The columns we select to load a wheel's full config (prizes joined).
const WHEEL_SELECT =
  `id, title, subtitle, brand_color, is_active, active_from, active_until, archived_at,
   prizes(id, label, description, rarity, weight, color, emoji, image_url, cost_cents, stock, sort_order)`;

// Any Supabase client (auth-scoped or service-role) we resolve wheels with.
type AnyClient =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------------
// Wheel resolution (Model C hybrid). Decides WHICH wheel a fan link points at
// right now, given the creator's wheels, schedules, and the campaign pin.
// ---------------------------------------------------------------------------

/**
 * The creator's currently-live wheel among their non-archived wheels:
 *   1. a scheduled wheel whose window contains `now` (prefer latest
 *      active_from, tie-break newest created_at);
 *   2. else the wheel flagged is_active;
 *   3. else the oldest non-archived wheel.
 */
async function resolveActiveWheelId(
  sb: AnyClient,
  creatorId: string,
  now: Date
): Promise<string | null> {
  const { data } = await sb
    .from("wheels")
    .select("id, is_active, active_from, active_until, created_at")
    .eq("creator_id", creatorId)
    .is("archived_at", null);

  const rows = (data ?? []) as {
    id: string;
    is_active: boolean;
    active_from: string | null;
    active_until: string | null;
    created_at: string;
  }[];
  if (rows.length === 0) return null;

  const nowMs = now.getTime();
  const inWindow = rows.filter((w) => {
    const fromOk = !w.active_from || new Date(w.active_from).getTime() <= nowMs;
    const untilOk = !w.active_until || new Date(w.active_until).getTime() > nowMs;
    return fromOk && untilOk;
  });
  if (inWindow.length > 0) {
    inWindow.sort((a, b) => {
      // Prefer latest active_from (a null active_from sorts oldest).
      const af = a.active_from ? new Date(a.active_from).getTime() : -Infinity;
      const bf = b.active_from ? new Date(b.active_from).getTime() : -Infinity;
      if (af !== bf) return bf - af;
      // Tie-break: newest created_at first.
      return b.created_at.localeCompare(a.created_at);
    });
    return inWindow[0].id;
  }

  const active = rows.find((w) => w.is_active);
  if (active) return active.id;

  // Oldest non-archived wheel.
  return rows
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0].id;
}

/**
 * The wheel a specific pass should use right now: the campaign's pinned wheel
 * (if set + non-archived) wins; otherwise the creator's active wheel; otherwise
 * the pass's own stored wheel_id.
 */
async function resolveWheelId(
  sb: AnyClient,
  pass: { creator_id: string; campaign_id: string | null; wheel_id: string },
  now: Date
): Promise<string | null> {
  if (pass.campaign_id) {
    const { data: campaign } = await sb
      .from("campaigns")
      .select("pinned_wheel_id")
      .eq("id", pass.campaign_id)
      .maybeSingle();
    const pinnedId = (campaign as { pinned_wheel_id: string | null } | null)
      ?.pinned_wheel_id;
    if (pinnedId) {
      const { data: pinned } = await sb
        .from("wheels")
        .select("id, archived_at")
        .eq("id", pinnedId)
        .maybeSingle();
      const row = pinned as { id: string; archived_at: string | null } | null;
      if (row && !row.archived_at) return row.id;
    }
  }

  const active = await resolveActiveWheelId(sb, pass.creator_id, now);
  return active ?? pass.wheel_id;
}

/**
 * The currently-running happy hour for a wheel: any window where
 * starts_at <= now < ends_at. When several overlap we take the largest
 * multiplier. Returns an inactive status (multiplier 1) when none apply.
 */
async function getActiveHappyHour(
  sb: AnyClient,
  wheelId: string,
  now: Date
): Promise<HappyHourStatus> {
  const iso = now.toISOString();
  const { data } = await sb
    .from("happy_hours")
    .select("multiplier, ends_at")
    .eq("wheel_id", wheelId)
    .lte("starts_at", iso)
    .gt("ends_at", iso);

  const rows = (data ?? []) as { multiplier: number; ends_at: string }[];
  if (rows.length === 0) return { active: false, multiplier: 1, endsAt: null };

  let best = rows[0];
  for (const r of rows) if (r.multiplier > best.multiplier) best = r;
  return { active: true, multiplier: best.multiplier, endsAt: best.ends_at };
}

// ---------------------------------------------------------------------------
// Public API. Transparently uses the in-memory mock store when Supabase isn't
// configured, so local dev and previews work with zero setup.
// ---------------------------------------------------------------------------

export async function getFanPass(token: string): Promise<FanPassView | null> {
  if (!isSupabaseConfigured()) return mockGetFanPass(token);

  const sb = createServiceClient();
  const { data } = await sb
    .from("fan_passes")
    .select(
      `id, creator_id, campaign_id, wheel_id, fan_id, is_active,
       fan:fans(id, display_name, handle, spins_remaining, spins_granted_total, referral_code, acked_at),
       creator:profiles(display_name, tip_url, leaderboard_enabled, creator_note, avatar_url)`
    )
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();

  const pass = data as unknown as {
    id: string;
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    fan_id: string;
    fan: {
      id: string;
      display_name: string | null;
      handle: string | null;
      spins_remaining: number;
      spins_granted_total: number;
      referral_code: string | null;
      acked_at: string | null;
    } | null;
    creator: {
      display_name: string | null;
      tip_url: string | null;
      leaderboard_enabled: boolean | null;
      creator_note: string | null;
      avatar_url: string | null;
    } | null;
  } | null;

  if (!pass || !pass.fan) return null;

  // Resolve WHICH wheel this link points at right now, then load its config.
  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return null;
  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return null;
  const wheel = wheelData as unknown as DbWheelRow;

  // The fan's full win history — scoped to the fan ACCOUNT, so it persists
  // across every link the creator has ever minted for them.
  const { data: wins } = await sb
    .from("spins")
    .select("prize_label, prize_rarity, prize_image_url, share_id, created_at")
    .eq("fan_id", pass.fan.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const winRows = (wins ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
    prize_image_url: string | null;
    share_id: string | null;
    created_at: string;
  }[];

  // Phase 3 fan-facing extras.
  const { data: wishRows } = await sb
    .from("wishlists")
    .select("id, prize_label, prize_rarity, created_at")
    .eq("fan_id", pass.fan.id)
    .order("created_at", { ascending: false });
  const wishlist: WishlistItem[] = (
    (wishRows ?? []) as {
      id: string;
      prize_label: string;
      prize_rarity: Rarity;
      created_at: string;
    }[]
  ).map((w) => ({
    id: w.id,
    prizeLabel: w.prize_label,
    rarity: w.prize_rarity,
    at: w.created_at,
  }));

  const happyHour = await getActiveHappyHour(sb, wheelId, new Date());

  return {
    token,
    fanName: pass.fan.display_name ?? pass.fan.handle ?? null,
    creatorTitle: pass.creator?.display_name ?? "Creator",
    spinsRemaining: pass.fan.spins_remaining,
    wheel: toWheelConfig(wheel),
    recentWins: winRows.map((w) => ({
      label: w.prize_label,
      rarity: w.prize_rarity,
      color: RARITY_COLORS[w.prize_rarity],
      at: w.created_at,
      shareId: w.share_id ?? undefined,
      imageUrl: w.prize_image_url ?? null,
    })),
    wishlist,
    happyHour,
    referral: {
      code: pass.fan.referral_code ?? "",
      bonusPerReferral: REFERRAL_BONUS,
    },
    chatUnlocked:
      pass.fan.spins_remaining > 0 || pass.fan.spins_granted_total > 0,
    needsAck: pass.fan.acked_at == null,
    tipUrl: pass.creator?.tip_url ?? null,
    creatorId: pass.creator_id,
    leaderboardEnabled: pass.creator?.leaderboard_enabled ?? false,
    creatorNote: pass.creator?.creator_note ?? null,
    creatorAvatarUrl: pass.creator?.avatar_url ?? null,
  };
}

export async function spin(token: string): Promise<SpinResult | SpinError> {
  if (!isSupabaseConfigured()) {
    return mockSpin(token);
  }

  const sb = createServiceClient();

  // 1. Atomically claim one spin from the fan account (can't be forged).
  const { data: remaining, error: claimErr } = await sb.rpc("claim_spin", {
    p_token: token,
  });
  // -1 is the rate-limit sentinel from claim_spin (too many spins too fast).
  if (remaining === -1) return { error: "rate_limited" };
  if (claimErr || remaining === null || remaining === undefined) {
    // Distinguish blocked/self-excluded/inactive from out-of-spins.
    const { data: existsRow } = await sb
      .from("fan_passes")
      .select("id, is_active, self_excluded_at, fan:fans(blocked_at)")
      .eq("token", token)
      .maybeSingle();
    const row = existsRow as unknown as {
      id: string;
      is_active: boolean;
      self_excluded_at: string | null;
      fan: { blocked_at: string | null } | null;
    } | null;
    if (!row) return { error: "not_found" };
    if (row.fan?.blocked_at || row.self_excluded_at || !row.is_active)
      return { error: "blocked" };
    return { error: "no_spins" };
  }
  const spinsRemaining = remaining as number;

  // 2. Load link context, then resolve WHICH wheel this spin uses + its prizes.
  const { data } = await sb
    .from("fan_passes")
    .select("id, creator_id, campaign_id, wheel_id, fan_id")
    .eq("token", token)
    .single();

  const pass = data as unknown as {
    id: string;
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    fan_id: string;
  };

  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return { error: "no_prizes" };
  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return { error: "no_prizes" };
  const config = toWheelConfig(wheelData as unknown as DbWheelRow);

  // Per-fan pity counter (guarantees a rare-or-better after a dry streak).
  const { data: fanRow } = await sb
    .from("fans")
    .select("pity_counter")
    .eq("id", pass.fan_id)
    .maybeSingle();
  const pityCounter = (fanRow as { pity_counter: number } | null)?.pity_counter ?? 0;

  // Happy hour (if any) boosts rare-or-better weights for this spin only.
  const hh = await getActiveHappyHour(sb, wheelId, new Date());
  const pool0 = hh.active ? applyRareBoost(config, hh.multiplier) : config;

  // Provably-fair commitment: commit to a random server seed (store its hash),
  // derive this spin's RNG deterministically from the seed + nonce, and reveal
  // the seed on the logged spin so the commitment can be verified afterward.
  const serverSeed = randomSeedHex();
  const nonce = spinsRemaining;
  const serverSeedHash = await sha256Hex(serverSeed);
  const rng = makeRng(serverSeed, nonce);

  // 3. Pick a prize in TS (single source of truth), honouring pity. If a
  //    limited prize sold out between our read and write, exclude it + re-pick.
  let chosen: { prize: Prize; index: number; pityAwarded: boolean; nextPityCounter: number } | null = null;
  const excluded = new Set<string>();
  for (let attempt = 0; attempt < pool0.prizes.length + 1; attempt++) {
    const pool: WheelConfig = {
      ...pool0,
      prizes: pool0.prizes.map((p) =>
        excluded.has(p.id) ? { ...p, stock: 0 } : p
      ),
    };
    const pick = pickPrizeWithPity(pool, { pityCounter }, rng);
    if (pick.prize.stock === null || pick.prize.stock === undefined) {
      chosen = pick;
      break;
    }
    const { data: updated } = await sb
      .from("prizes")
      .update({ stock: pick.prize.stock - 1 })
      .eq("id", pick.prize.id)
      .gt("stock", 0)
      .select("id")
      .maybeSingle();
    if (updated) {
      chosen = pick;
      break;
    }
    excluded.add(pick.prize.id);
  }

  if (!chosen) return { error: "no_prizes" };

  // Persist the fan's next pity counter. Spinning also auto-opts the fan into
  // the leaderboard (handle-only; the board only shows when the CREATOR enables
  // it, so this never leaks anything until the creator turns it on).
  await sb
    .from("fans")
    .update({ pity_counter: chosen.nextPityCounter, leaderboard_opt_in: true })
    .eq("id", pass.fan_id);

  // 3b. FIFO-attribute this spin to a campaign. Order the fan's grants
  //     oldest→newest, build cumulative spin ranges; this spin's 0-based index
  //     among the fan's spins (= spins already played) belongs to the grant
  //     whose cumulative range covers it (null if beyond every grant).
  const { data: grantRows } = await sb
    .from("grants")
    .select("campaign_id, spins, created_at")
    .eq("fan_id", pass.fan_id)
    .order("created_at", { ascending: true });
  const { count: playedBefore } = await sb
    .from("spins")
    .select("id", { count: "exact", head: true })
    .eq("fan_id", pass.fan_id);

  let spinCampaignId: string | null = null;
  {
    const grants = (grantRows ?? []) as { campaign_id: string | null; spins: number }[];
    const before = playedBefore ?? 0;
    let cumulative = 0;
    for (const g of grants) {
      cumulative += g.spins;
      if (before < cumulative) {
        spinCampaignId = g.campaign_id;
        break;
      }
    }
  }

  // 4. Log the spin (against the fan account) + a pending redemption.
  const { data: spinRow } = await sb
    .from("spins")
    .insert({
      fan_pass_id: pass.id,
      creator_id: pass.creator_id,
      wheel_id: wheelId,
      fan_id: pass.fan_id,
      prize_id: chosen.prize.id,
      prize_label: chosen.prize.label,
      prize_rarity: chosen.prize.rarity,
      prize_image_url: chosen.prize.imageUrl ?? null,
      campaign_id: spinCampaignId,
      server_seed: serverSeed,
      server_seed_hash: serverSeedHash,
      nonce,
    })
    .select("id, share_id")
    .single();

  if (spinRow) {
    await sb.from("redemptions").insert({
      spin_id: spinRow.id,
      creator_id: pass.creator_id,
      status: "pending",
    });
    // Best-effort fan-out to the creator's webhooks. Never blocks/throws — a
    // slow or failing endpoint must not break the spin.
    void fireWebhooks(pass.creator_id, {
      event: "prize_pending",
      prize: chosen.prize.label,
      rarity: chosen.prize.rarity,
      at: new Date().toISOString(),
    }).catch(() => {});
  }

  return {
    prize: chosen.prize,
    prizeIndex: chosen.index,
    spinsRemaining,
    pityAwarded: chosen.pityAwarded,
    shareId: (spinRow as { id: string; share_id: string | null } | null)?.share_id ?? undefined,
  };
}

/**
 * Create a link. Without `fanId`, creates a NEW fan account. With `fanId`,
 * mints a fresh link for that SAME account (history + balance preserved) and
 * adds the granted spins to the account's balance.
 */
export async function createPass(opts: {
  name: string;
  spins: number;
  fanId?: string;
  wheelId?: string;
  campaignId?: string;
  amountCents?: number;
  packId?: string;
  bonusSpins?: number;
  referralCode?: string;
}): Promise<{ token: string; fanId: string } | { error: string }> {
  let spins = Math.max(0, Math.floor(opts.spins) || 0);
  let amountCents = Math.max(0, Math.floor(opts.amountCents ?? 0) || 0);
  let bonusSpins = Math.max(0, Math.floor(opts.bonusSpins ?? 0) || 0);
  if (!isSupabaseConfigured()) {
    return mockCreatePass(
      opts.name,
      spins,
      opts.fanId,
      opts.campaignId,
      amountCents,
      bonusSpins,
      opts.packId,
      opts.referralCode
    );
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // A pack is authoritative: its spins/price/bonus override any client values.
  if (opts.packId) {
    const { data: pack } = await sb
      .from("campaign_packs")
      .select("spins, amount_cents, bonus_spins")
      .eq("id", opts.packId)
      .eq("creator_id", user.id)
      .maybeSingle();
    const p = pack as
      | { spins: number; amount_cents: number; bonus_spins: number }
      | null;
    if (!p) return { error: "pack_not_found" };
    spins = Math.max(0, p.spins);
    amountCents = Math.max(0, p.amount_cents);
    bonusSpins = Math.max(0, p.bonus_spins);
  }

  // Effective balance added = paid spins + bonus spins.
  const balanceAdd = spins + bonusSpins;

  let wheelId = opts.wheelId;
  if (!wheelId) {
    const { data: w } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    wheelId = w?.id;
  }
  if (!wheelId) return { error: "no_wheel" };

  const campaignId = opts.campaignId ?? null;

  // Reuse the existing fan account (top-up) or create a new one.
  let fanId = opts.fanId;
  let token: string;
  if (fanId) {
    const { data: fan } = await sb
      .from("fans")
      .select("spins_remaining, spins_granted_total")
      .eq("id", fanId)
      .maybeSingle();
    if (!fan) return { error: "fan_not_found" };
    await sb
      .from("fans")
      .update({
        spins_remaining: fan.spins_remaining + balanceAdd,
        spins_granted_total: fan.spins_granted_total + balanceAdd,
      })
      .eq("id", fanId);

    // Top-up: DON'T mint a new link — reuse the fan's newest existing token.
    const { data: pass } = await sb
      .from("fan_passes")
      .select("token")
      .eq("fan_id", fanId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!pass?.token) return { error: "no_pass" };
    token = pass.token;
  } else {
    const { data: fan, error } = await sb
      .from("fans")
      .insert({
        creator_id: user.id,
        display_name: opts.name || "Fan",
        spins_remaining: balanceAdd,
        spins_granted_total: balanceAdd,
      })
      .select("id")
      .single();
    if (error || !fan) return { error: "db_error" };
    fanId = fan.id;

    // Referral: a NEW fan arriving with a code is linked to the referrer (same
    // creator, not self). The credit is awarded later, on this fan's first PAID
    // grant (see the crediting block below).
    if (opts.referralCode) {
      const { data: refRow } = await sb
        .from("fans")
        .select("id")
        .eq("creator_id", user.id)
        .eq("referral_code", opts.referralCode)
        .maybeSingle();
      const referrer = refRow as { id: string } | null;
      if (referrer && referrer.id !== fanId) {
        await sb
          .from("fans")
          .update({ referred_by_fan_id: referrer.id })
          .eq("id", fanId);
        await sb.from("referrals").insert({
          creator_id: user.id,
          referrer_fan_id: referrer.id,
          referred_fan_id: fanId,
          bonus_spins: REFERRAL_BONUS,
        });
      }
    }

    // New fan: mint exactly ONE link.
    token = randomToken();
    const { error: passErr } = await sb.from("fan_passes").insert({
      token,
      creator_id: user.id,
      wheel_id: wheelId,
      fan_id: fanId,
      campaign_id: campaignId,
    });
    if (passErr) return { error: "db_error" };
  }
  if (!fanId) return { error: "db_error" };

  // Every grant (new fan OR top-up) is recorded for revenue + FIFO attribution.
  // `spins` on the grant is the FULL balance added (paid + bonus) so FIFO
  // attribution covers every spin the fan can actually play; `bonus_spins`
  // records the comped portion separately for display.
  const { error: grantErr } = await sb.from("grants").insert({
    creator_id: user.id,
    fan_id: fanId,
    campaign_id: campaignId,
    spins: balanceAdd,
    amount_cents: amountCents,
    bonus_spins: bonusSpins,
  });
  if (grantErr) return { error: "db_error" };

  // Referral crediting (idempotent): the FIRST time this fan makes a PAID
  // grant, if they were referred and haven't been credited yet, award the bonus
  // to BOTH the fan and the referrer — capped at REFERRAL_CAP credited
  // referrals per referrer. Guarded so it runs at most once.
  if (amountCents > 0) {
    const { data: meRow } = await sb
      .from("fans")
      .select("referred_by_fan_id, referral_credited, spins_remaining, spins_granted_total")
      .eq("id", fanId)
      .maybeSingle();
    const me = meRow as {
      referred_by_fan_id: string | null;
      referral_credited: boolean;
      spins_remaining: number;
      spins_granted_total: number;
    } | null;

    if (me && me.referred_by_fan_id && !me.referral_credited) {
      // How many referrals has the referrer already had credited?
      const { count: creditedCount } = await sb
        .from("referrals")
        .select("id", { count: "exact", head: true })
        .eq("referrer_fan_id", me.referred_by_fan_id)
        .not("credited_at", "is", null);

      if ((creditedCount ?? 0) < REFERRAL_CAP) {
        // Mark this fan credited FIRST (idempotency guard): only proceed if the
        // flag was still false at update time.
        const { data: claimed } = await sb
          .from("fans")
          .update({ referral_credited: true })
          .eq("id", fanId)
          .eq("referral_credited", false)
          .select("id")
          .maybeSingle();

        if (claimed) {
          // Bonus to the referred fan (this fan).
          await sb
            .from("fans")
            .update({
              spins_remaining: me.spins_remaining + REFERRAL_BONUS,
              spins_granted_total: me.spins_granted_total + REFERRAL_BONUS,
            })
            .eq("id", fanId);

          // Bonus to the referrer.
          const { data: refFan } = await sb
            .from("fans")
            .select("spins_remaining, spins_granted_total")
            .eq("id", me.referred_by_fan_id)
            .maybeSingle();
          const rf = refFan as {
            spins_remaining: number;
            spins_granted_total: number;
          } | null;
          if (rf) {
            await sb
              .from("fans")
              .update({
                spins_remaining: rf.spins_remaining + REFERRAL_BONUS,
                spins_granted_total: rf.spins_granted_total + REFERRAL_BONUS,
              })
              .eq("id", me.referred_by_fan_id);
          }

          // Mark the referral row credited.
          await sb
            .from("referrals")
            .update({
              credited_at: new Date().toISOString(),
              bonus_spins: REFERRAL_BONUS,
            })
            .eq("referred_fan_id", fanId);
        }
      }
    }
  }

  return { token, fanId };
}

// ---------------------------------------------------------------------------
// Campaigns: named groupings of links a creator can compare against each other.
// ---------------------------------------------------------------------------

export async function createCampaign(
  name: string,
  pinnedWheelId?: string | null
): Promise<{ campaign: Campaign } | { error: string }> {
  if (!isSupabaseConfigured())
    return { campaign: mockCreateCampaign(name, pinnedWheelId) };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data, error } = await sb
    .from("campaigns")
    .insert({ creator_id: user.id, name, pinned_wheel_id: pinnedWheelId ?? null })
    .select("id, name, is_active, created_at, pinned_wheel_id")
    .single();
  if (error || !data) return { error: "db_error" };

  return {
    campaign: {
      id: data.id,
      name: data.name,
      isActive: data.is_active,
      createdAt: data.created_at,
      pinnedWheelId: data.pinned_wheel_id ?? null,
    },
  };
}

export async function listCampaigns(): Promise<Campaign[]> {
  if (!isSupabaseConfigured()) return mockListCampaigns();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("campaigns")
    .select("id, name, is_active, created_at, pinned_wheel_id")
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as {
    id: string;
    name: string;
    is_active: boolean;
    created_at: string;
    pinned_wheel_id: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isActive: r.is_active,
    createdAt: r.created_at,
    pinnedWheelId: r.pinned_wheel_id ?? null,
  }));
}

export async function getCampaignStats(): Promise<CampaignStats[]> {
  if (!isSupabaseConfigured()) return mockGetCampaignStats();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const campaigns = await listCampaigns();

  const result: CampaignStats[] = [];
  for (const campaign of campaigns) {
    // Grants tagged to this campaign → spinsBought, revenue, uniqueFans.
    const { data: grantRows } = await sb
      .from("grants")
      .select("fan_id, spins, amount_cents")
      .eq("creator_id", user.id)
      .eq("campaign_id", campaign.id);

    const grants = (grantRows ?? []) as {
      fan_id: string;
      spins: number;
      amount_cents: number;
    }[];
    const spinsBought = grants.reduce((s, g) => s + g.spins, 0);
    const revenue = grants.reduce((s, g) => s + g.amount_cents, 0);
    const uniqueFans = new Set(grants.map((g) => g.fan_id)).size;

    // Spins attributed (FIFO) to this campaign → spinsPlayed + top prize.
    const { data: spinRows } = await sb
      .from("spins")
      .select("id, prize_label, prize_rarity")
      .eq("creator_id", user.id)
      .eq("campaign_id", campaign.id);

    const spins = (spinRows ?? []) as {
      id: string;
      prize_label: string;
      prize_rarity: Rarity;
    }[];
    const spinsPlayed = spins.length;
    const spinIds = spins.map((s) => s.id);

    // Fulfilled redemptions joined to those campaign-attributed spins.
    let fulfilled = 0;
    if (spinIds.length > 0) {
      const { count } = await sb
        .from("redemptions")
        .select("id", { count: "exact", head: true })
        .eq("status", "fulfilled")
        .in("spin_id", spinIds);
      fulfilled = count ?? 0;
    }

    // Top prize: the most frequent (label + rarity) among those spins.
    const counts = new Map<
      string,
      { label: string; rarity: Rarity; count: number }
    >();
    for (const s of spins) {
      const cur = counts.get(s.prize_label);
      if (cur) cur.count += 1;
      else counts.set(s.prize_label, { label: s.prize_label, rarity: s.prize_rarity, count: 1 });
    }
    let topPrize: { label: string; rarity: Rarity; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!topPrize || entry.count > topPrize.count) topPrize = entry;
    }

    const arpu = uniqueFans ? Math.round(revenue / uniqueFans) : 0;

    result.push({
      campaign,
      spinsBought,
      spinsPlayed,
      uniqueFans,
      fulfilled,
      pending: Math.max(0, spinsPlayed - fulfilled),
      playThroughPct: spinsBought > 0 ? spinsPlayed / spinsBought : 0,
      revenue,
      arpu,
      topPrize,
    });
  }

  return result;
}

/** Top up spins on the fan account behind a token (e.g. after another tip). */
export async function grantSpins(
  token: string,
  n: number
): Promise<{ spinsRemaining: number } | { error: string }> {
  const add = Math.max(1, Math.floor(n) || 0);
  if (!isSupabaseConfigured()) {
    const remaining = mockGrantSpins(token, add);
    return remaining === null
      ? { error: "not_found" }
      : { spinsRemaining: remaining };
  }

  const sb = await createClient();
  const { data: pass } = await sb
    .from("fan_passes")
    .select("fan:fans(id, spins_remaining, spins_granted_total)")
    .eq("token", token)
    .maybeSingle();

  const fan = (pass as unknown as { fan: { id: string; spins_remaining: number; spins_granted_total: number } | null } | null)
    ?.fan;
  if (!fan) return { error: "not_found" };

  const { data: updated, error } = await sb
    .from("fans")
    .update({
      spins_remaining: fan.spins_remaining + add,
      spins_granted_total: fan.spins_granted_total + add,
    })
    .eq("id", fan.id)
    .select("spins_remaining")
    .single();
  if (error || !updated) return { error: "db_error" };
  return { spinsRemaining: updated.spins_remaining };
}

/**
 * The creator's persistent fan accounts (+ their links). Loaded by the Fans
 * tab on mount so accounts survive a page refresh.
 */
export async function listFans(): Promise<FanAccountSummary[]> {
  if (!isSupabaseConfigured()) return mockListFans();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("fans")
    .select(
      `id, display_name, handle, spins_remaining, spins_granted_total, tags, created_at,
       fan_passes(token, created_at),
       spins(prize_label, prize_rarity, created_at),
       grants(amount_cents, campaign_id, campaign:campaigns(name))`
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as unknown as {
    id: string;
    display_name: string | null;
    handle: string | null;
    spins_remaining: number;
    spins_granted_total: number;
    tags: string[] | null;
    fan_passes: { token: string; created_at: string }[] | null;
    spins: { prize_label: string; prize_rarity: Rarity; created_at: string }[] | null;
    grants:
      | { amount_cents: number; campaign_id: string | null; campaign: { name: string } | null }[]
      | null;
  }[];

  return rows.map((r) => {
    const wins = (r.spins ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    const grants = r.grants ?? [];
    const totalSpent = grants.reduce((s, g) => s + g.amount_cents, 0);
    const campaignNames: string[] = [];
    const seen = new Set<string>();
    for (const g of grants) {
      if (!g.campaign_id || !g.campaign?.name) continue;
      if (seen.has(g.campaign_id)) continue;
      seen.add(g.campaign_id);
      campaignNames.push(g.campaign.name);
    }
    const links = (r.fan_passes ?? [])
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      fanId: r.id,
      name: r.display_name ?? r.handle ?? "Fan",
      spinsRemaining: r.spins_remaining,
      grantedTotal: r.spins_granted_total,
      primaryToken: links[0]?.token ?? null,
      totalSpent,
      campaignNames,
      tags: r.tags ?? [],
      links: links.map((p) => ({ token: p.token })),
      lastWin: wins[0]
        ? { label: wins[0].prize_label, rarity: wins[0].prize_rarity, at: wins[0].created_at }
        : null,
    };
  });
}

// --- Creator CRM: whales (top LTV) + dormant fans to win back ----------------

export interface CrmFan {
  fanId: string;
  name: string;
  totalSpent: number; // cents (lifetime = LTV)
  spinsRemaining: number;
  lastActiveAt: string | null;
  daysSince: number | null;
  primaryToken: string | null;
}
export interface CreatorCrm {
  totalLtv: number; // cents across all fans
  avgLtv: number; // cents per fan with spend
  whales: CrmFan[]; // top spenders, desc
  dormant: CrmFan[]; // spent before, quiet 14+ days
}

/**
 * Whale detection + win-back, derived from existing fan data (no new tables):
 *   • LTV per fan = sum of their grant amounts (real money tied to their spins).
 *   • Whales = fans ranked by LTV desc (your highest-value relationships).
 *   • Dormant = fans who HAVE spent (LTV > 0) but whose last win/activity is
 *     14+ days ago — the cheapest revenue is a fan you already converted.
 */
export async function getCreatorCrm(): Promise<CreatorCrm> {
  const fans = await listFans();
  const now = Date.now();
  const DAY = 86_400_000;

  const enrich = (f: FanAccountSummary): CrmFan => {
    const lastActiveAt = f.lastWin?.at ?? null;
    const daysSince = lastActiveAt
      ? Math.floor((now - new Date(lastActiveAt).getTime()) / DAY)
      : null;
    return {
      fanId: f.fanId,
      name: f.name,
      totalSpent: f.totalSpent,
      spinsRemaining: f.spinsRemaining,
      lastActiveAt,
      daysSince,
      primaryToken: f.primaryToken,
    };
  };

  const all = fans.map(enrich);
  const spenders = all.filter((f) => f.totalSpent > 0);
  const totalLtv = spenders.reduce((s, f) => s + f.totalSpent, 0);
  const avgLtv = spenders.length ? Math.round(totalLtv / spenders.length) : 0;

  const whales = [...spenders].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 10);
  const dormant = spenders
    .filter((f) => f.daysSince !== null && f.daysSince >= 14)
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 20);

  return { totalLtv, avgLtv, whales, dormant };
}

/**
 * A single fan account's full detail, for the creator's fan drill-in. RLS keeps
 * this scoped to the owning creator, so we use the auth-scoped client.
 */
export async function getFanDetail(fanId: string): Promise<FanDetail | null> {
  if (!isSupabaseConfigured()) return mockGetFanDetail(fanId);

  const sb = await createClient();

  const { data: fan } = await sb
    .from("fans")
    .select("id, display_name, handle, spins_remaining, spins_granted_total, notes, tags")
    .eq("id", fanId)
    .maybeSingle();
  if (!fan) return null;

  const { data: spinRows } = await sb
    .from("spins")
    .select("prize_label, prize_rarity, campaign_id, created_at")
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false });

  const spins = (spinRows ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
    campaign_id: string | null;
    created_at: string;
  }[];
  const totalSpins = spins.length;
  const lastActive = spins[0]?.created_at ?? null;

  const rarityCounts = new Map<Rarity, number>();
  for (const s of spins) {
    rarityCounts.set(s.prize_rarity, (rarityCounts.get(s.prize_rarity) ?? 0) + 1);
  }
  const winsByRarity = [...rarityCounts.entries()].map(([rarity, count]) => ({
    rarity,
    count,
  }));

  // Pending prizes: this fan's pending redemptions, joined back to the spin for
  // the prize label/rarity. Emoji isn't stored on spins, so it's omitted.
  const { data: pendingRows } = await sb
    .from("redemptions")
    .select("created_at, spin:spins!inner(prize_label, prize_rarity, fan_id)")
    .eq("status", "pending")
    .eq("spin.fan_id", fanId)
    .order("created_at", { ascending: false });

  const pending = (pendingRows ?? []) as unknown as {
    created_at: string;
    spin: { prize_label: string; prize_rarity: Rarity; fan_id: string } | null;
  }[];
  const pendingPrizes = pending
    .filter((r) => r.spin)
    .map((r) => ({
      label: r.spin!.prize_label,
      rarity: r.spin!.prize_rarity,
      at: r.created_at,
    }));

  const { data: passRows } = await sb
    .from("fan_passes")
    .select("token, created_at")
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false });

  const links = ((passRows ?? []) as { token: string; created_at: string }[]).map(
    (p) => ({ token: p.token, createdAt: p.created_at })
  );

  // This fan's grants, newest first, with campaign name resolved via a join.
  const { data: grantRows } = await sb
    .from("grants")
    .select("id, spins, amount_cents, bonus_spins, campaign_id, created_at, campaign:campaigns(name)")
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false });

  const grantData = (grantRows ?? []) as unknown as {
    id: string;
    spins: number;
    amount_cents: number;
    bonus_spins: number;
    campaign_id: string | null;
    created_at: string;
    campaign: { name: string } | null;
  }[];

  const grants: Grant[] = grantData.map((g) => ({
    id: g.id,
    spins: g.spins,
    amountCents: g.amount_cents,
    bonusSpins: g.bonus_spins,
    campaignId: g.campaign_id,
    campaignName: g.campaign?.name ?? null,
    at: g.created_at,
  }));

  const totalSpent = grantData.reduce((s, g) => s + g.amount_cents, 0);

  // Per-campaign breakdown: grant rollups merged with FIFO-attributed spins.
  // Bucket key is the campaignId, or "" for null-campaign grants/spins.
  interface Bucket {
    campaignId: string;
    name: string;
    spinsBought: number;
    spinsPlayed: number;
    spentCents: number;
    prizeCounts: Map<string, { label: string; rarity: Rarity; count: number }>;
  }
  const buckets = new Map<string, Bucket>();
  const nameById = new Map<string, string>();
  for (const g of grantData) {
    if (g.campaign_id && g.campaign?.name) nameById.set(g.campaign_id, g.campaign.name);
  }
  const bucketFor = (campaignId: string | null): Bucket => {
    const key = campaignId ?? "";
    let b = buckets.get(key);
    if (!b) {
      b = {
        campaignId: key,
        name: campaignId ? nameById.get(campaignId) ?? "Uncategorized" : "Uncategorized",
        spinsBought: 0,
        spinsPlayed: 0,
        spentCents: 0,
        prizeCounts: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const g of grantData) {
    const b = bucketFor(g.campaign_id);
    b.spinsBought += g.spins;
    b.spentCents += g.amount_cents;
  }
  for (const s of spins) {
    const b = bucketFor(s.campaign_id);
    b.spinsPlayed += 1;
    const cur = b.prizeCounts.get(s.prize_label);
    if (cur) cur.count += 1;
    else b.prizeCounts.set(s.prize_label, { label: s.prize_label, rarity: s.prize_rarity, count: 1 });
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
    name: fan.display_name ?? fan.handle ?? "Fan",
    notes: fan.notes ?? null,
    tags: fan.tags ?? [],
    spinsRemaining: fan.spins_remaining,
    grantedTotal: fan.spins_granted_total,
    totalSpins,
    totalSpent,
    lastActive,
    winsByRarity,
    pendingPrizes,
    links,
    grants,
    byCampaign,
  };
}

/**
 * Permanently delete a fan account. Schema FKs cascade the fan's links + grants
 * and anonymize their spins, so a plain delete is safe. RLS keeps a creator
 * scoped to their own fans.
 */
export async function deleteFan(
  fanId: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockDeleteFan(fanId) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.from("fans").delete().eq("id", fanId);
  return error ? { error: "db_error" } : { ok: true };
}

/** Block or unblock a fan — blocked fans' links stop working (enforced in claim_spin). */
export async function setFanBlocked(
  fanId: string,
  blocked: boolean
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb
    .from("fans")
    .update({ blocked_at: blocked ? new Date().toISOString() : null })
    .eq("id", fanId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/** A fan reports the creator behind their token (service-role; fans aren't authed). */
export async function reportCreator(
  token: string,
  reason: string,
  detail?: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  if (!reason.trim()) return { error: "empty" };
  const sb = createServiceClient();
  const { data } = await sb
    .from("fan_passes")
    .select("creator_id, fan_id")
    .eq("token", token)
    .maybeSingle();
  const pass = data as { creator_id: string; fan_id: string } | null;
  if (!pass) return { error: "not_found" };
  const { error } = await sb.from("creator_reports").insert({
    creator_id: pass.creator_id,
    fan_id: pass.fan_id,
    token,
    reason: reason.slice(0, 120),
    detail: detail?.slice(0, 2000) ?? null,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/** A fan pauses (self-excludes) their own link from the spin page. */
export async function selfExclude(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = createServiceClient();
  const { error } = await sb
    .from("fan_passes")
    .update({ self_excluded_at: new Date().toISOString(), is_active: false })
    .eq("token", token);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Patch a fan's creator-applied metadata (free-form notes and/or tags). RLS
 * scopes the update to the owning creator, so we use the auth-scoped client.
 */
export async function updateFanMeta(
  fanId: string,
  patch: { notes?: string | null; tags?: string[] }
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockUpdateFanMeta(fanId, patch);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if ("notes" in patch) upd.notes = patch.notes ?? null;
  if (patch.tags) upd.tags = patch.tags;
  if (Object.keys(upd).length === 0) return { ok: true };

  const { error } = await sb.from("fans").update(upd).eq("id", fanId);
  return error ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// DM templates: a creator's saved, reusable direct-message snippets. `{link}`
// is a placeholder the UI swaps for a fan's full spin URL. Creator-scoped (RLS).
// ---------------------------------------------------------------------------

export async function listDmTemplates(): Promise<DmTemplate[]> {
  if (!isSupabaseConfigured()) return mockListDmTemplates();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("dm_templates")
    .select("id, title, body, created_at")
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as {
    id: string;
    title: string;
    body: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function createDmTemplate(
  title: string,
  body: string
): Promise<{ template: DmTemplate } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return { template: mockCreateDmTemplate(title, body) };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data, error } = await sb
    .from("dm_templates")
    .insert({ creator_id: user.id, title, body })
    .select("id, title, body, created_at")
    .single();
  if (error || !data) return { error: "db_error" };

  return {
    template: {
      id: data.id,
      title: data.title,
      body: data.body,
      createdAt: data.created_at,
    },
  };
}

export async function deleteDmTemplate(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockDeleteDmTemplate(id) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.from("dm_templates").delete().eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Wheel configuration (the editor reads + writes this)
// ---------------------------------------------------------------------------

// Returns the signed-in creator's wheel id, creating a default one (seeded from
// the sample) on first use so a creator always has something to edit.
async function ensureWheelId(
  sb: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data: existing } = await sb
    .from("wheels")
    .select("id")
    .eq("creator_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const { data: wheel, error } = await sb
    .from("wheels")
    .insert({
      creator_id: userId,
      title: SAMPLE_WHEEL.title,
      subtitle: SAMPLE_WHEEL.subtitle ?? null,
      brand_color: SAMPLE_WHEEL.brandColor ?? "#ec4899",
    })
    .select("id")
    .single();
  if (error || !wheel) return null;

  await sb.from("prizes").insert(
    SAMPLE_WHEEL.prizes.map((p, i) => prizeRow(wheel.id, p, i))
  );
  return wheel.id;
}

export async function getWheel(): Promise<WheelConfig | null> {
  if (!isSupabaseConfigured()) return mockGetWheel();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  // Bootstrap a first wheel if the creator has none, then resolve their
  // currently-live wheel (schedule → is_active → oldest) and load its config.
  await ensureWheelId(sb, user.id);
  const wheelId = await resolveActiveWheelId(sb, user.id, new Date());
  if (!wheelId) return null;

  const { data } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .single();

  return toWheelConfig(data as unknown as DbWheelRow);
}

export async function saveWheel(
  config: WheelConfig
): Promise<{ wheel: WheelConfig } | { error: string }> {
  if (!isSupabaseConfigured()) return { wheel: mockSaveWheel(config) };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // Save the wheel identified by `config.id`. ensureWheelId is only a bootstrap
  // so a brand-new creator always has at least one wheel to edit.
  await ensureWheelId(sb, user.id);
  const wheelId = config.id;
  if (!wheelId) return { error: "no_wheel" };

  const upd: Record<string, unknown> = {
    title: config.title.slice(0, 120),
    subtitle: config.subtitle?.slice(0, 200) ?? null,
    brand_color: config.brandColor ?? "#ec4899",
    updated_at: new Date().toISOString(),
  };
  // Persist lifecycle/schedule fields only when present on the incoming config.
  if (typeof config.isActive === "boolean") upd.is_active = config.isActive;
  if (config.activeFrom !== undefined) upd.active_from = config.activeFrom;
  if (config.activeUntil !== undefined) upd.active_until = config.activeUntil;

  // The RLS-scoped client only sees the creator's own wheels, so this verifies
  // ownership: a foreign/unknown id matches no row.
  const { data: updated, error: wErr } = await sb
    .from("wheels")
    .update(upd)
    .eq("id", wheelId)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (wErr) return { error: "db_error" };
  if (!updated) return { error: "not_found" };

  // Replace prizes wholesale. Spin history is safe because spins snapshot the
  // prize label/rarity and prizes.prize_id is ON DELETE SET NULL.
  await sb.from("prizes").delete().eq("wheel_id", wheelId);
  const rows = config.prizes
    .slice(0, 24)
    .map((p, i) => prizeRow(wheelId, p, i));
  if (rows.length > 0) {
    const { error: pErr } = await sb.from("prizes").insert(rows);
    if (pErr) return { error: "db_error" };
  }

  const saved = await getWheelById(wheelId);
  return saved ? { wheel: saved } : { error: "db_error" };
}

function prizeRow(wheelId: string, p: Prize, sortOrder: number) {
  return {
    wheel_id: wheelId,
    label: p.label.slice(0, 80) || "Prize",
    description: p.description?.slice(0, 280) ?? null,
    rarity: p.rarity,
    weight: Math.max(0, Math.floor(p.weight) || 0),
    color: p.color ?? null,
    emoji: p.emoji ?? null,
    image_url: p.imageUrl ?? null,
    cost_cents: p.cost ?? null,
    stock: p.stock ?? null,
    sort_order: sortOrder,
  };
}

// ---------------------------------------------------------------------------
// Multi-wheel management (Phase 2): list/get/create/duplicate/archive,
// activation, and scheduling. All creator-scoped via the RLS client.
// ---------------------------------------------------------------------------

/** Load one wheel's full config by id (creator-scoped via RLS). */
export async function getWheelById(id: string): Promise<WheelConfig | null> {
  if (!isSupabaseConfigured()) return mockGetWheelById(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const { data } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return toWheelConfig(data as unknown as DbWheelRow);
}

/** All the creator's wheels (newest first), with a prize count each. */
export async function listWheels(
  includeArchived = false
): Promise<WheelSummary[]> {
  if (!isSupabaseConfigured()) return mockListWheels(includeArchived);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  let query = sb
    .from("wheels")
    .select(
      `id, title, subtitle, brand_color, is_active, archived_at,
       active_from, active_until, updated_at, prizes(id)`
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });
  if (!includeArchived) query = query.is("archived_at", null);

  const { data } = await query;
  const rows = (data ?? []) as unknown as {
    id: string;
    title: string;
    subtitle: string | null;
    brand_color: string | null;
    is_active: boolean;
    archived_at: string | null;
    active_from: string | null;
    active_until: string | null;
    updated_at: string;
    prizes: { id: string }[] | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle ?? null,
    brandColor: r.brand_color ?? "#ec4899",
    isActive: r.is_active,
    archivedAt: r.archived_at,
    activeFrom: r.active_from,
    activeUntil: r.active_until,
    prizeCount: (r.prizes ?? []).length,
    updatedAt: r.updated_at,
  }));
}

/**
 * Create a new wheel, seeding prizes from a wheel template (if given) or from
 * the sample wheel. It becomes is_active only if it's the creator's first wheel.
 */
export async function createWheel(opts?: {
  fromTemplateId?: string;
  name?: string;
}): Promise<{ wheel: WheelConfig }> {
  if (!isSupabaseConfigured()) return mockCreateWheel(opts);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  // First wheel? It should be the active one.
  const { count: existing } = await sb
    .from("wheels")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", user.id);
  const isFirst = (existing ?? 0) === 0;

  // Seed: a template snapshot, else the sample wheel.
  let title = SAMPLE_WHEEL.title;
  let subtitle: string | null = SAMPLE_WHEEL.subtitle ?? null;
  let brandColor = SAMPLE_WHEEL.brandColor ?? "#ec4899";
  let seedPrizes: Omit<Prize, "id">[] = SAMPLE_WHEEL.prizes.map(
    ({ id: _id, ...rest }) => rest
  );

  if (opts?.fromTemplateId) {
    const { data: tpl } = await sb
      .from("wheel_templates")
      .select("title, subtitle, brand_color, prizes")
      .eq("id", opts.fromTemplateId)
      .eq("creator_id", user.id)
      .maybeSingle();
    const t = tpl as {
      title: string;
      subtitle: string | null;
      brand_color: string | null;
      prizes: Omit<Prize, "id">[] | null;
    } | null;
    if (t) {
      title = t.title;
      subtitle = t.subtitle;
      brandColor = t.brand_color ?? "#ec4899";
      seedPrizes = t.prizes ?? [];
    }
  }

  if (opts?.name) title = opts.name;

  const { data: wheel, error } = await sb
    .from("wheels")
    .insert({
      creator_id: user.id,
      title: title.slice(0, 120),
      subtitle: subtitle?.slice(0, 200) ?? null,
      brand_color: brandColor,
      is_active: isFirst,
    })
    .select("id")
    .single();
  if (error || !wheel) throw new Error("db_error");

  if (seedPrizes.length > 0) {
    await sb.from("prizes").insert(
      seedPrizes
        .slice(0, 24)
        .map((p, i) => prizeRow(wheel.id, p as Prize, i))
    );
  }

  const saved = await getWheelById(wheel.id);
  if (!saved) throw new Error("db_error");
  return { wheel: saved };
}

/** Deep-copy a wheel + its prizes into a new inactive, unscheduled wheel. */
export async function duplicateWheel(
  id: string
): Promise<{ wheel: WheelConfig }> {
  if (!isSupabaseConfigured()) return mockDuplicateWheel(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const source = await getWheelById(id);
  if (!source) throw new Error("not_found");

  const { data: wheel, error } = await sb
    .from("wheels")
    .insert({
      creator_id: user.id,
      title: `${source.title} copy`.slice(0, 120),
      subtitle: source.subtitle?.slice(0, 200) ?? null,
      brand_color: source.brandColor ?? "#ec4899",
      is_active: false,
      active_from: null,
      active_until: null,
    })
    .select("id")
    .single();
  if (error || !wheel) throw new Error("db_error");

  if (source.prizes.length > 0) {
    await sb.from("prizes").insert(
      source.prizes.slice(0, 24).map((p, i) => prizeRow(wheel.id, p, i))
    );
  }

  const saved = await getWheelById(wheel.id);
  if (!saved) throw new Error("db_error");
  return { wheel: saved };
}

/**
 * Archive a wheel. If it was the active one, promote the oldest remaining
 * non-archived wheel to active so the creator always has a live wheel.
 */
export async function archiveWheel(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockArchiveWheel(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: target } = await sb
    .from("wheels")
    .select("id, is_active")
    .eq("id", id)
    .eq("creator_id", user.id)
    .maybeSingle();
  const row = target as { id: string; is_active: boolean } | null;
  if (!row) return { error: "not_found" };

  const { error } = await sb
    .from("wheels")
    .update({ archived_at: new Date().toISOString(), is_active: false })
    .eq("id", id);
  if (error) return { error: "db_error" };

  // If we just archived the active wheel, promote the oldest survivor.
  if (row.is_active) {
    const { data: next } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (next?.id) {
      await sb.from("wheels").update({ is_active: true }).eq("id", next.id);
    }
  }

  return { ok: true };
}

/** Restore an archived wheel (clears archived_at). It returns as inactive; the
 *  creator can then Set active if they want it serving fans. */
export async function unarchiveWheel(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockUnarchiveWheel(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("wheels")
    .update({ archived_at: null })
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Permanently delete a wheel. Guarded: only allowed when the wheel has NO spins
 * (deleting one with history would cascade-wipe spins/redemptions = revenue and
 * analytics records). Callers should archive instead when there's history.
 */
export async function deleteWheel(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteWheel(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: target } = await sb
    .from("wheels")
    .select("id, is_active")
    .eq("id", id)
    .eq("creator_id", user.id)
    .maybeSingle();
  const row = target as { id: string; is_active: boolean } | null;
  if (!row) return { error: "not_found" };

  // Block deleting a wheel that has spin history — protects revenue/analytics.
  const { count } = await sb
    .from("spins")
    .select("id", { count: "exact", head: true })
    .eq("wheel_id", id);
  if ((count ?? 0) > 0) return { error: "has_history" };

  const { error } = await sb
    .from("wheels")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  if (error) return { error: "db_error" };

  // If the deleted wheel was active, promote the oldest survivor.
  if (row.is_active) {
    const { data: next } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (next?.id) {
      await sb.from("wheels").update({ is_active: true }).eq("id", next.id);
    }
  }

  return { ok: true };
}

/** Make exactly one wheel the creator's active wheel. */
export async function setActiveWheel(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetActiveWheel(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: target } = await sb
    .from("wheels")
    .select("id")
    .eq("id", id)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!target) return { error: "not_found" };

  // Clear every flag for this creator, then set the chosen wheel.
  const { error: clearErr } = await sb
    .from("wheels")
    .update({ is_active: false })
    .eq("creator_id", user.id);
  if (clearErr) return { error: "db_error" };

  const { error } = await sb
    .from("wheels")
    .update({ is_active: true })
    .eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

/** Set (or clear) a wheel's scheduled active window. */
export async function setWheelSchedule(
  id: string,
  { activeFrom, activeUntil }: { activeFrom: string | null; activeUntil: string | null }
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured())
    return mockSetWheelSchedule(id, { activeFrom, activeUntil });

  if (
    activeFrom &&
    activeUntil &&
    new Date(activeUntil).getTime() <= new Date(activeFrom).getTime()
  ) {
    return { error: "invalid_window" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: updated, error } = await sb
    .from("wheels")
    .update({ active_from: activeFrom, active_until: activeUntil })
    .eq("id", id)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Campaign packs (Phase 2): purchasable spin bundles, optionally scoped to a
// campaign. Authoritative pricing lives here (see createPass).
// ---------------------------------------------------------------------------

function toCampaignPack(r: {
  id: string;
  campaign_id: string | null;
  label: string;
  spins: number;
  amount_cents: number;
  bonus_spins: number;
  sort_order: number;
  created_at: string;
}): CampaignPack {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    label: r.label,
    spins: r.spins,
    amountCents: r.amount_cents,
    bonusSpins: r.bonus_spins,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
  };
}

const PACK_SELECT =
  "id, campaign_id, label, spins, amount_cents, bonus_spins, sort_order, created_at";

/**
 * The creator's packs. With a campaignId, returns that campaign's packs plus any
 * global (null-campaign) packs. Ordered by sort_order.
 */
export async function listCampaignPacks(
  campaignId?: string
): Promise<CampaignPack[]> {
  if (!isSupabaseConfigured()) return mockListCampaignPacks(campaignId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  let query = sb
    .from("campaign_packs")
    .select(PACK_SELECT)
    .eq("creator_id", user.id)
    .order("sort_order", { ascending: true });
  if (campaignId) {
    query = query.or(`campaign_id.eq.${campaignId},campaign_id.is.null`);
  }

  const { data } = await query;
  const rows = (data ?? []) as Parameters<typeof toCampaignPack>[0][];
  return rows.map(toCampaignPack);
}

export async function createCampaignPack(input: {
  campaignId: string | null;
  label: string;
  spins: number;
  amountCents: number;
  bonusSpins?: number;
  sortOrder?: number;
}): Promise<CampaignPack> {
  if (!isSupabaseConfigured()) return mockCreateCampaignPack(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const { data, error } = await sb
    .from("campaign_packs")
    .insert({
      creator_id: user.id,
      campaign_id: input.campaignId,
      label: input.label,
      spins: Math.max(0, Math.floor(input.spins) || 0),
      amount_cents: Math.max(0, Math.floor(input.amountCents) || 0),
      bonus_spins: Math.max(0, Math.floor(input.bonusSpins ?? 0) || 0),
      sort_order: Math.floor(input.sortOrder ?? 0) || 0,
    })
    .select(PACK_SELECT)
    .single();
  if (error || !data) throw new Error("db_error");
  return toCampaignPack(data as Parameters<typeof toCampaignPack>[0]);
}

export async function updateCampaignPack(
  id: string,
  patch: Partial<{
    campaignId: string | null;
    label: string;
    spins: number;
    amountCents: number;
    bonusSpins: number;
    sortOrder: number;
  }>
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockUpdateCampaignPack(id, patch);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if ("campaignId" in patch) upd.campaign_id = patch.campaignId ?? null;
  if (patch.label !== undefined) upd.label = patch.label;
  if (patch.spins !== undefined) upd.spins = Math.max(0, Math.floor(patch.spins) || 0);
  if (patch.amountCents !== undefined)
    upd.amount_cents = Math.max(0, Math.floor(patch.amountCents) || 0);
  if (patch.bonusSpins !== undefined)
    upd.bonus_spins = Math.max(0, Math.floor(patch.bonusSpins) || 0);
  if (patch.sortOrder !== undefined) upd.sort_order = Math.floor(patch.sortOrder) || 0;
  if (Object.keys(upd).length === 0) return { ok: true };

  const { error } = await sb
    .from("campaign_packs")
    .update(upd)
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

export async function deleteCampaignPack(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteCampaignPack(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("campaign_packs")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/** Pin (or unpin) a campaign's default wheel. */
export async function setCampaignPinnedWheel(
  campaignId: string,
  wheelId: string | null
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured())
    return mockSetCampaignPinnedWheel(campaignId, wheelId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: updated, error } = await sb
    .from("campaigns")
    .update({ pinned_wheel_id: wheelId })
    .eq("id", campaignId)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}

/**
 * Wipe ALL of the signed-in creator's data — wheels, prizes, fans, links, spins,
 * grants, redemptions, campaigns, packs, templates, happy hours — leaving a
 * fresh account. Destructive and irreversible. Child rows cascade from the
 * parents below; we delete the creator-owned parents explicitly.
 */
export async function clearMyData(): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockClearMyData();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // fans → cascades fan_passes, spins, grants, messages, wishlists, referrals.
  // wheels → cascades prizes, (wheel-scoped) passes, happy_hours.
  // Then standalone creator-owned tables.
  const tables = [
    "fans",
    "wheels",
    "campaigns",
    "campaign_packs",
    "dm_templates",
    "prize_templates",
    "wheel_templates",
    "happy_hours",
    "autopilot_dismissals",
  ];
  for (const t of tables) {
    const { error } = await sb.from(t).delete().eq("creator_id", user.id);
    if (error) return { error: `db_error:${t}` };
  }
  return { ok: true };
}

/** Rename a campaign. */
export async function renameCampaign(
  campaignId: string,
  name: string
): Promise<{ ok: true } | { error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "bad_request" };
  if (!isSupabaseConfigured()) return mockRenameCampaign(campaignId, trimmed);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data: updated, error } = await sb
    .from("campaigns")
    .update({ name: trimmed })
    .eq("id", campaignId)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}

/** Delete a campaign. Grants keep their history (campaign_id → null on delete). */
export async function deleteCampaign(
  campaignId: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteCampaign(campaignId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb
    .from("campaigns")
    .delete()
    .eq("id", campaignId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Reusable templates (Phase 2): saved prizes + saved wheel presets.
// ---------------------------------------------------------------------------

const PRIZE_TEMPLATE_SELECT =
  "id, label, description, rarity, weight, color, emoji, created_at";

function toPrizeTemplate(r: {
  id: string;
  label: string;
  description: string | null;
  rarity: Rarity;
  weight: number;
  color: string | null;
  emoji: string | null;
  created_at: string;
}): PrizeTemplate {
  return {
    id: r.id,
    label: r.label,
    description: r.description ?? undefined,
    rarity: r.rarity,
    weight: r.weight,
    color: r.color ?? undefined,
    emoji: r.emoji ?? undefined,
    createdAt: r.created_at,
  };
}

export async function listPrizeTemplates(): Promise<PrizeTemplate[]> {
  if (!isSupabaseConfigured()) return mockListPrizeTemplates();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("prize_templates")
    .select(PRIZE_TEMPLATE_SELECT)
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as Parameters<typeof toPrizeTemplate>[0][];
  return rows.map(toPrizeTemplate);
}

export async function createPrizeTemplate(input: {
  label: string;
  description?: string;
  rarity: Rarity;
  weight: number;
  color?: string;
  emoji?: string;
}): Promise<PrizeTemplate> {
  if (!isSupabaseConfigured()) return mockCreatePrizeTemplate(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const { data, error } = await sb
    .from("prize_templates")
    .insert({
      creator_id: user.id,
      label: input.label.slice(0, 80) || "Prize",
      description: input.description?.slice(0, 280) ?? null,
      rarity: input.rarity,
      weight: Math.max(0, Math.floor(input.weight) || 0),
      color: input.color ?? null,
      emoji: input.emoji ?? null,
    })
    .select(PRIZE_TEMPLATE_SELECT)
    .single();
  if (error || !data) throw new Error("db_error");
  return toPrizeTemplate(data as Parameters<typeof toPrizeTemplate>[0]);
}

export async function deletePrizeTemplate(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeletePrizeTemplate(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("prize_templates")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

function toWheelTemplate(r: {
  id: string;
  name: string;
  title: string;
  subtitle: string | null;
  brand_color: string | null;
  prizes: Omit<Prize, "id">[] | null;
  created_at: string;
}): WheelTemplate {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    subtitle: r.subtitle ?? undefined,
    brandColor: r.brand_color ?? "#ec4899",
    prizes: r.prizes ?? [],
    createdAt: r.created_at,
  };
}

const WHEEL_TEMPLATE_SELECT =
  "id, name, title, subtitle, brand_color, prizes, created_at";

export async function listWheelTemplates(): Promise<WheelTemplate[]> {
  if (!isSupabaseConfigured()) return mockListWheelTemplates();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("wheel_templates")
    .select(WHEEL_TEMPLATE_SELECT)
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as unknown as Parameters<typeof toWheelTemplate>[0][];
  return rows.map(toWheelTemplate);
}

/**
 * Save a wheel preset. Snapshots the prize set as id-less jsonb, sourced from an
 * existing wheel (fromWheelId) or a provided config.
 */
export async function createWheelTemplate(input: {
  name: string;
  fromWheelId?: string;
  config?: WheelConfig;
}): Promise<WheelTemplate> {
  if (!isSupabaseConfigured()) return mockCreateWheelTemplate(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  let source: WheelConfig | null = input.config ?? null;
  if (!source && input.fromWheelId) {
    source = await getWheelById(input.fromWheelId);
  }
  if (!source) throw new Error("no_source");

  // Strip ids off the prize snapshot.
  const prizes: Omit<Prize, "id">[] = source.prizes
    .slice(0, 24)
    .map(({ id: _id, ...rest }) => rest);

  const { data, error } = await sb
    .from("wheel_templates")
    .insert({
      creator_id: user.id,
      name: input.name.slice(0, 120) || "Template",
      title: source.title.slice(0, 120),
      subtitle: source.subtitle?.slice(0, 200) ?? null,
      brand_color: source.brandColor ?? "#ec4899",
      prizes,
    })
    .select(WHEEL_TEMPLATE_SELECT)
    .single();
  if (error || !data) throw new Error("db_error");
  return toWheelTemplate(data as unknown as Parameters<typeof toWheelTemplate>[0]);
}

export async function deleteWheelTemplate(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteWheelTemplate(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("wheel_templates")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

// Creator dashboard: metrics + the prize fulfilment queue.
export async function getOverview(): Promise<CreatorOverview> {
  const empty: CreatorOverview = {
    metrics: { fans: 0, spinsPlayed: 0, pending: 0, fulfilled: 0, revenue: 0 },
    redemptions: [],
  };
  if (!isSupabaseConfigured()) return mockGetOverview();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return empty;

  const { data: reds } = await sb
    .from("redemptions")
    .select(
      `id, status, created_at, notes, due_at,
       spin:spins(prize_label, prize_rarity, fan:fans(display_name, handle))`
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (reds ?? []) as unknown as {
    id: string;
    status: RedemptionStatus;
    created_at: string;
    notes: string | null;
    due_at: string | null;
    spin: {
      prize_label: string;
      prize_rarity: RedemptionItem["rarity"];
      fan: { display_name: string | null; handle: string | null } | null;
    } | null;
  }[];

  const redemptions: RedemptionItem[] = rows.map((r) => ({
    id: r.id,
    fanName: r.spin?.fan?.display_name ?? r.spin?.fan?.handle ?? "Fan",
    prizeLabel: r.spin?.prize_label ?? "Prize",
    rarity: r.spin?.prize_rarity ?? "common",
    status: r.status,
    at: r.created_at,
    notes: r.notes,
    dueAt: r.due_at,
  }));

  const head = { count: "exact" as const, head: true };
  const { count: fans } = await sb
    .from("fans")
    .select("id", head)
    .eq("creator_id", user.id);
  const { count: spinsPlayed } = await sb
    .from("spins")
    .select("id", head)
    .eq("creator_id", user.id);

  const { data: grantRows } = await sb
    .from("grants")
    .select("amount_cents")
    .eq("creator_id", user.id);
  const revenue = ((grantRows ?? []) as { amount_cents: number }[]).reduce(
    (s, g) => s + g.amount_cents,
    0
  );

  const { count: unreadMessages } = await sb
    .from("messages")
    .select("id", head)
    .eq("creator_id", user.id)
    .eq("sender", "fan")
    .is("read_at", null);

  const { data: prof } = await sb
    .from("profiles")
    .select("leaderboard_enabled")
    .eq("id", user.id)
    .maybeSingle();

  return {
    metrics: {
      fans: fans ?? 0,
      spinsPlayed: spinsPlayed ?? 0,
      pending: redemptions.filter((r) => r.status === "pending").length,
      fulfilled: redemptions.filter((r) => r.status === "fulfilled").length,
      revenue,
      unreadMessages: unreadMessages ?? 0,
      leaderboardEnabled: (prof as { leaderboard_enabled: boolean } | null)?.leaderboard_enabled ?? false,
    },
    redemptions,
  };
}

// Extra metrics for the dashboard: a daily spin trend + a conversion funnel.
// NOTE: "Opened" is NOT tracked anywhere, so the funnel runs links → spun →
// fulfilled rather than the classic link → open → spin → fulfilled.
export async function getMetricsExtra(
  days: number = 30
): Promise<CreatorMetricsExtra> {
  const n = clampDays(days);
  if (!isSupabaseConfigured()) return mockGetMetricsExtra(days);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return {
      trend: bucketByDay([], n),
      funnel: { fans: 0, spun: 0, fulfilled: 0 },
      revenueTrend: bucketCentsByDay([], n),
    };
  }

  const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const { data: spinRows } = await sb
    .from("spins")
    .select("created_at")
    .eq("creator_id", user.id)
    .gte("created_at", since);

  const timestamps = ((spinRows ?? []) as { created_at: string }[]).map(
    (r) => r.created_at
  );
  const trend = bucketByDay(timestamps, n);

  const { data: grantRows } = await sb
    .from("grants")
    .select("created_at, amount_cents")
    .eq("creator_id", user.id)
    .gte("created_at", since);
  const revenueTrend = bucketCentsByDay(
    ((grantRows ?? []) as { created_at: string; amount_cents: number }[]).map((r) => ({
      at: r.created_at,
      cents: r.amount_cents,
    })),
    n
  );

  // Per-fan funnel: fans created → fans with ≥1 spin → fans with a fulfilled
  // prize. Counts distinct FANS (not links/spins), so it reflects how the
  // audience converts under the one-permanent-link model.
  const head = { count: "exact" as const, head: true };
  const { count: fans } = await sb
    .from("fans")
    .select("id", head)
    .eq("creator_id", user.id);

  const { data: spunRows } = await sb
    .from("spins")
    .select("fan_id")
    .eq("creator_id", user.id)
    .not("fan_id", "is", null);
  const spun = new Set(
    ((spunRows ?? []) as { fan_id: string | null }[])
      .map((r) => r.fan_id)
      .filter((id): id is string => id !== null)
  ).size;

  // Fulfilled redemptions → distinct fans, joined through the spin.
  const { data: fulfilledRows } = await sb
    .from("redemptions")
    .select("spin:spins(fan_id)")
    .eq("creator_id", user.id)
    .eq("status", "fulfilled");
  const fulfilled = new Set(
    ((fulfilledRows ?? []) as unknown as { spin: { fan_id: string | null } | null }[])
      .map((r) => r.spin?.fan_id)
      .filter((id): id is string => !!id)
  ).size;

  return {
    trend,
    funnel: { fans: fans ?? 0, spun, fulfilled },
    revenueTrend,
  };
}

// --- Phase 4 (deeper analytics) --------------------------------------------

// #17 Best-time heatmap: bucket spin timestamps into a 7×24 (weekday×hour, UTC)
// grid. Returns all 168 cells, zero-filled, plus the max count.
export async function getEngagementHeatmap(
  days: number = 90
): Promise<EngagementHeatmap> {
  const n = clampDays(days);
  if (!isSupabaseConfigured()) return mockGetEngagementHeatmap(days);

  const empty: EngagementHeatmap = (() => {
    const cells: EngagementHeatmap["cells"] = [];
    for (let weekday = 0; weekday < 7; weekday++)
      for (let hour = 0; hour < 24; hour++)
        cells.push({ weekday, hour, count: 0 });
    return { cells, max: 0 };
  })();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return empty;

  const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const { data: spinRows } = await sb
    .from("spins")
    .select("created_at")
    .eq("creator_id", user.id)
    .gte("created_at", since);

  const counts = new Array<number>(7 * 24).fill(0);
  for (const r of (spinRows ?? []) as { created_at: string }[]) {
    const d = new Date(r.created_at);
    if (Number.isNaN(d.getTime())) continue;
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

// #18 Prize ROI: count wins per prize label and join the creator's cost.
export async function getPrizeRoi(days: number = 90): Promise<PrizeRoiRow[]> {
  const n = clampDays(days);
  if (!isSupabaseConfigured()) return mockGetPrizeRoi(days);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  // Costs + rarity come from the creator's prize set (last write wins by label).
  const { data: prizeRows } = await sb
    .from("prizes")
    .select("label, rarity, cost_cents, wheel:wheels!inner(creator_id)")
    .eq("wheel.creator_id", user.id);
  const meta = new Map<string, { rarity: Rarity; costCents: number | null }>();
  for (const p of (prizeRows ?? []) as unknown as {
    label: string;
    rarity: Rarity;
    cost_cents: number | null;
  }[]) {
    meta.set(p.label, { rarity: p.rarity, costCents: p.cost_cents ?? null });
  }

  // Counts come from spins (one row per spin) inside the window.
  const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const { data: spinRows } = await sb
    .from("spins")
    .select("prize_label, prize_rarity")
    .eq("creator_id", user.id)
    .gte("created_at", since);

  const counts = new Map<string, { rarity: Rarity; timesWon: number }>();
  for (const s of (spinRows ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
  }[]) {
    const cur = counts.get(s.prize_label);
    if (cur) cur.timesWon += 1;
    else counts.set(s.prize_label, { rarity: s.prize_rarity, timesWon: 1 });
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

export interface ProfitSummary {
  revenueCents: number; // what fans paid (grants) in the window
  costCents: number; // prize fulfilment cost (won prizes × their set cost)
  profitCents: number; // revenue − cost
  marginPct: number; // profit ÷ revenue (0 if no revenue)
  costsComplete: boolean; // false if some won prizes have no cost set (cost understated)
}

/**
 * The real bottom line over a window: revenue (what fans paid) minus prize cost
 * (won prizes × their set cost) = profit. This is the honest "ROI" the per-prize
 * cost table can't give, because revenue isn't attributable to a single prize.
 */
export async function getProfitSummary(days: number = 90): Promise<ProfitSummary> {
  const n = clampDays(days);
  const empty: ProfitSummary = {
    revenueCents: 0,
    costCents: 0,
    profitCents: 0,
    marginPct: 0,
    costsComplete: true,
  };
  if (!isSupabaseConfigured()) return mockGetProfitSummary(days);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return empty;

  const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  // Revenue: grants in the window.
  const { data: grantRows } = await sb
    .from("grants")
    .select("amount_cents")
    .eq("creator_id", user.id)
    .gte("created_at", since);
  const revenueCents = ((grantRows ?? []) as { amount_cents: number }[]).reduce(
    (s, g) => s + (g.amount_cents ?? 0),
    0
  );

  // Cost: each won prize (in window) × its set cost, by label.
  const { data: prizeRows } = await sb
    .from("prizes")
    .select("label, cost_cents, wheel:wheels!inner(creator_id)")
    .eq("wheel.creator_id", user.id);
  const costByLabel = new Map<string, number | null>();
  for (const p of (prizeRows ?? []) as unknown as {
    label: string;
    cost_cents: number | null;
  }[]) {
    costByLabel.set(p.label, p.cost_cents ?? null);
  }
  const { data: spinRows } = await sb
    .from("spins")
    .select("prize_label")
    .eq("creator_id", user.id)
    .gte("created_at", since);

  let costCents = 0;
  let costsComplete = true;
  for (const s of (spinRows ?? []) as { prize_label: string }[]) {
    const c = costByLabel.get(s.prize_label);
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

// #19 Cohort retention: cohort each fan by their first grant's campaign.
export async function getCohortRetention(): Promise<CohortRow[]> {
  if (!isSupabaseConfigured()) return mockGetCohortRetention();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data: grantRows } = await sb
    .from("grants")
    .select("fan_id, campaign_id, created_at")
    .eq("creator_id", user.id);
  const { data: campaignRows } = await sb
    .from("campaigns")
    .select("id, name")
    .eq("creator_id", user.id);

  const campaignName = new Map<string, string>();
  for (const c of (campaignRows ?? []) as { id: string; name: string }[])
    campaignName.set(c.id, c.name);

  // First grant (earliest created_at) per fan determines the cohort; also track
  // grant counts per fan for the "returning" definition (≥2 grants).
  const firstCampaign = new Map<string, string | null>();
  const firstAt = new Map<string, number>();
  const grantCount = new Map<string, number>();
  for (const g of (grantRows ?? []) as {
    fan_id: string;
    campaign_id: string | null;
    created_at: string;
  }[]) {
    grantCount.set(g.fan_id, (grantCount.get(g.fan_id) ?? 0) + 1);
    const t = new Date(g.created_at).getTime();
    const prev = firstAt.get(g.fan_id);
    if (prev === undefined || t < prev) {
      firstAt.set(g.fan_id, Number.isNaN(t) ? Infinity : t);
      firstCampaign.set(g.fan_id, g.campaign_id);
    }
  }

  const cohorts = new Map<
    string | null,
    { fans: number; returningFans: number }
  >();
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

// --- Autopilot: a ranked, prescriptive "do this next" feed -------------------

export type AutopilotAction =
  | { kind: "dm_fan"; fanId: string; token: string | null }
  | { kind: "open_inbox" }
  | { kind: "open_fulfilment" }
  | { kind: "schedule_happy_hour"; weekday: number; hour: number }
  | { kind: "edit_wheel" }
  | { kind: "copy_link"; token: string | null }
  | { kind: "none" };

export interface AutopilotCard {
  key: string; // stable dedupe key
  icon: string;
  title: string;
  body: string;
  cta: string;
  action: AutopilotAction;
  score: number; // ranking
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Generate a ranked action feed from the analytics we already compute. Pure
 * read + rank; one-tap execution happens client-side via the existing flows.
 * Dismissed/snoozed cards (autopilot_dismissals) are filtered out.
 */
export async function getAutopilot(): Promise<AutopilotCard[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const [crm, overview, heatmap, demand, extra, roi, cohorts] = await Promise.all([
    getCreatorCrm(),
    getOverview(),
    getEngagementHeatmap(30),
    getWishlistDemand(),
    getMetricsExtra(30),
    getPrizeRoi(90),
    getCohortRetention(),
  ]);

  // Low-stock prizes (real scarcity) — a light direct read; stock lives on prizes.
  const { data: stockRows } = await sb
    .from("prizes")
    .select("label, stock, wheel:wheels!inner(creator_id)")
    .eq("wheel.creator_id", user.id)
    .not("stock", "is", null);
  const lowStock = ((stockRows ?? []) as unknown as {
    label: string;
    stock: number | null;
  }[]).filter((p) => typeof p.stock === "number" && p.stock > 0 && p.stock <= 3);

  const cards: AutopilotCard[] = [];
  const push = (c: Omit<AutopilotCard, "score"> & { score: number }) => cards.push(c);

  // 1. DM your top whales.
  if (crm.whales.length > 0) {
    const top = crm.whales.slice(0, 3);
    push({
      key: "dm_whales",
      icon: "🐳",
      title: `Check in with your top ${top.length === 1 ? "spender" : "spenders"}`,
      body: `${top.map((w) => w.name).join(", ")} — your highest LTV fans. A quick personal message keeps whales loyal.`,
      cta: "Message them",
      action: { kind: "dm_fan", fanId: top[0].fanId, token: top[0].primaryToken },
      score: 95,
    });
  }

  // 2. Win back dormant spenders.
  if (crm.dormant.length > 0) {
    const d = crm.dormant[0];
    push({
      key: "winback",
      icon: "💤",
      title: `${crm.dormant.length} paying ${crm.dormant.length === 1 ? "fan has" : "fans have"} gone quiet`,
      body: `${d.name} last played ${d.daysSince}d ago. The cheapest revenue is a fan you already won — send a fresh link.`,
      cta: "Win them back",
      action: { kind: "copy_link", token: d.primaryToken },
      score: 88,
    });
  }

  // 3. Overdue fulfilment.
  const pending = overview.metrics.pending ?? 0;
  if (pending > 0) {
    push({
      key: "fulfil",
      icon: "🎁",
      title: `${pending} ${pending === 1 ? "prize is" : "prizes are"} waiting to be fulfilled`,
      body: "Fans remember slow delivery. Clear the queue to keep your reputation high.",
      cta: "Open fulfilment",
      action: { kind: "open_fulfilment" },
      score: 90,
    });
  }

  // 4. Unread fan messages.
  const unread = overview.metrics.unreadMessages ?? 0;
  if (unread > 0) {
    push({
      key: "answer_fans",
      icon: "💬",
      title: `${unread} unread ${unread === 1 ? "message" : "messages"}`,
      body: "A fast reply while they're spinning turns chat into spend.",
      cta: "Open inbox",
      action: { kind: "open_inbox" },
      score: 92,
    });
  }

  // 5. Schedule a drop in your hottest slot.
  const hot = [...heatmap.cells].sort((a, b) => b.count - a.count)[0];
  if (hot && hot.count > 0) {
    push({
      key: `hot_slot_${hot.weekday}_${hot.hour}`,
      icon: "🔥",
      title: `Your fans spin most on ${WEEKDAY_NAMES[hot.weekday]} ~${hot.hour}:00 UTC`,
      body: "Schedule a happy-hour rare boost in that window to turn peak attention into spend.",
      cta: "Schedule a drop",
      action: { kind: "schedule_happy_hour", weekday: hot.weekday, hour: hot.hour },
      score: 70,
    });
  }

  // 6. Wishlist demand spike for a prize not heavily stocked / not present.
  if (demand.length > 0 && demand[0].count >= 2) {
    const d = demand[0];
    push({
      key: `wishlist_${d.prizeLabel}`,
      icon: "⭐",
      title: `${d.count} fans are chasing "${d.prizeLabel}"`,
      body: "Demand is real. Feature it on the wheel (or DM the wishers) while interest is hot.",
      cta: "Open wheel editor",
      action: { kind: "edit_wheel" },
      score: 65,
    });
  }

  // 7. Set costs on won prizes that have none (ROI is blind without them).
  const blind = roi.filter((r) => r.costCents === null && r.timesWon > 0);
  if (blind.length > 0) {
    push({
      key: "set_costs",
      icon: "🧮",
      title: `Set a cost on ${blind.length} ${blind.length === 1 ? "prize" : "prizes"}`,
      body: "Prizes are being won with no cost set, so your ROI is blind. Add costs to see what's draining you.",
      cta: "Open wheel editor",
      action: { kind: "edit_wheel" },
      score: 40,
    });
  }

  // 8. Funnel leak: spun ≫ fulfilled.
  if (extra.funnel.spun > 0 && extra.funnel.fulfilled < extra.funnel.spun / 2 && pending > 0) {
    push({
      key: "funnel_leak",
      icon: "🚰",
      title: "Wins aren't getting fulfilled",
      body: `${extra.funnel.spun} fans have won but only ${extra.funnel.fulfilled} were fulfilled. Close the gap.`,
      cta: "Open fulfilment",
      action: { kind: "open_fulfilment" },
      score: 60,
    });
  }

  // 9. Engaged whale who's out of spins — top them up before they cool off.
  const drySpender = crm.whales.find((w) => w.spinsRemaining === 0);
  if (drySpender) {
    push({
      key: `out_of_spins_${drySpender.fanId}`,
      icon: "🪫",
      title: `${drySpender.name} is out of spins`,
      body: "One of your top spenders has nothing left to play. Nudge them to grab more before the momentum fades.",
      cta: "Send their link",
      action: { kind: "copy_link", token: drySpender.primaryToken },
      score: 80,
    });
  }

  // 10. Over-given rarity — a top-tier prize is landing far too often (margin leak).
  const totalWins = roi.reduce((s, r) => s + r.timesWon, 0);
  const overGiven = roi.find(
    (r) =>
      (r.rarity === "legendary" || r.rarity === "epic") &&
      totalWins >= 20 &&
      r.timesWon / totalWins > 0.15
  );
  if (overGiven) {
    push({
      key: `over_given_${overGiven.label}`,
      icon: "📉",
      title: `"${overGiven.label}" is being won too often`,
      body: `Your ${overGiven.rarity} "${overGiven.label}" is ${Math.round((overGiven.timesWon / totalWins) * 100)}% of all wins. Lower its odds to protect the magic (and your margin).`,
      cta: "Open wheel editor",
      action: { kind: "edit_wheel" },
      score: 55,
    });
  }

  // 11. Restock — a limited prize is almost gone.
  if (lowStock.length > 0) {
    const p = lowStock.sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0))[0];
    push({
      key: `restock_${p.label}`,
      icon: "📦",
      title: `"${p.label}" is almost gone (${p.stock} left)`,
      body: "Decide now: restock to keep it on the wheel, or let it sell out as a scarcity moment.",
      cta: "Open wheel editor",
      action: { kind: "edit_wheel" },
      score: 58,
    });
  }

  // 12. Campaign fuel — your best-retaining campaign deserves more spend.
  const fuel = [...cohorts]
    .filter((c) => c.fans >= 3)
    .sort((a, b) => b.repeatRate - a.repeatRate)[0];
  if (fuel && fuel.repeatRate >= 0.4 && fuel.campaignId) {
    push({
      key: `campaign_fuel_${fuel.campaignId}`,
      icon: "⛽",
      title: `"${fuel.campaignName}" fans keep coming back`,
      body: `${Math.round(fuel.repeatRate * 100)}% of that cohort spent again. Pour more traffic into your highest-retention campaign.`,
      cta: "Open campaigns",
      action: { kind: "none" },
      score: 50,
    });
  }

  // Filter out dismissed / still-snoozed cards.
  const { data: dis } = await sb
    .from("autopilot_dismissals")
    .select("dedupe_key, snooze_until")
    .eq("creator_id", user.id);
  const now = Date.now();
  const hidden = new Set(
    ((dis ?? []) as { dedupe_key: string; snooze_until: string | null }[])
      .filter((d) => d.snooze_until === null || new Date(d.snooze_until).getTime() > now)
      .map((d) => d.dedupe_key)
  );

  return cards.filter((c) => !hidden.has(c.key)).sort((a, b) => b.score - a.score);
}

/** Dismiss (permanent) or snooze (until a time) an autopilot card. */
export async function dismissAutopilotCard(
  key: string,
  snoozeUntil?: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.from("autopilot_dismissals").upsert(
    {
      creator_id: user.id,
      dedupe_key: key,
      snooze_until: snoozeUntil ?? null,
    },
    { onConflict: "creator_id,dedupe_key" }
  );
  return error ? { error: "db_error" } : { ok: true };
}

export async function setRedemptionStatus(
  id: string,
  status: RedemptionStatus
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockSetRedemptionStatus(id, status)
      ? { ok: true }
      : { error: "not_found" };
  }

  const sb = await createClient();
  const { error } = await sb
    .from("redemptions")
    .update({
      status,
      fulfilled_at: status === "fulfilled" ? new Date().toISOString() : null,
    })
    .eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

// Update a redemption's notes and/or due date, leaving its status untouched.
export async function setRedemptionMeta(
  id: string,
  patch: { notes?: string | null; dueAt?: string | null }
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockSetRedemptionMeta(id, patch)
      ? { ok: true }
      : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const update: { notes?: string | null; due_at?: string | null } = {};
  if ("notes" in patch) update.notes = patch.notes ?? null;
  if ("dueAt" in patch) update.due_at = patch.dueAt ?? null;
  if (Object.keys(update).length === 0) return { ok: true };

  const { error } = await sb
    .from("redemptions")
    .update(update)
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Admin (cross-account)
// ---------------------------------------------------------------------------

async function requireAdmin(
  sb: Awaited<ReturnType<typeof createClient>>
): Promise<boolean> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return false;
  const { data } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  return data?.role === "admin";
}

/**
 * One-time admin bootstrap: promote the signed-in user to admin IF their email
 * is in the ADMIN_EMAILS env allowlist. Lets the owner claim admin without
 * touching the database. No-op (and safe) when the allowlist is unset/empty.
 */
export async function claimAdmin(): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const allow = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0) return { error: "not_configured" };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const email = (user.email ?? "").toLowerCase();
  if (!allow.includes(email)) return { error: "not_allowed" };

  // Service-role write: promote + approve this profile (RLS profiles_update is
  // admin-only, and the user isn't admin yet — that's the bootstrap chicken/egg).
  const svc = createServiceClient();

  // Lock: this bootstrap can ONLY ever create the FIRST admin. Once any admin
  // exists, it's permanently inert (further admin management goes through the
  // proper roles system / an existing admin).
  const { count: adminCount } = await svc
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
  if ((adminCount ?? 0) > 0) return { error: "already_bootstrapped" };

  const { error } = await svc
    .from("profiles")
    .update({ role: "admin", approval_status: "approved", is_active: true })
    .eq("id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

export async function getAdminOverview(): Promise<AdminOverview | null> {
  if (!isSupabaseConfigured()) return mockGetAdminOverview();

  const sb = await createClient();
  const { data, error } = await sb.rpc("admin_account_stats");
  // The function returns rows only to admins; empty ⇒ not authorized.
  if (error || !data || data.length === 0) return null;

  const rows = data as {
    id: string;
    email: string | null;
    display_name: string | null;
    role: AppRole;
    is_active: boolean;
    features: Record<string, boolean> | null;
    wheels: number;
    fans: number;
    spins: number;
    pending: number;
  }[];

  const accounts: AdminAccount[] = rows.map((r) => ({
    id: r.id,
    email: r.email ?? "",
    displayName: r.display_name ?? r.email ?? "Creator",
    role: r.role,
    isActive: r.is_active,
    features: r.features ?? {},
    wheels: Number(r.wheels),
    fans: Number(r.fans),
    spins: Number(r.spins),
    pending: Number(r.pending),
  }));

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

// --- Agency console (orgs + scoped seats) -----------------------------------

export type OrgRole = "owner" | "manager" | "chatter" | "fulfiller" | "analyst";

export interface OrgCreatorStat {
  id: string;
  displayName: string;
  email: string;
  wheels: number;
  fans: number;
  spins: number;
  pending: number;
  revenue: number; // cents
}
export interface OrgMember {
  id: string;
  profileId: string;
  email: string;
  displayName: string;
  role: OrgRole;
}
export interface PendingInvite {
  id: string;
  email: string;
}
export interface AgencyOverview {
  org: { id: string; name: string } | null;
  isOwner: boolean;
  totals: { creators: number; fans: number; spins: number; pending: number; revenue: number };
  creators: OrgCreatorStat[];
  members: OrgMember[];
  invites: PendingInvite[];
}

/** The agency roll-up for the org the signed-in user owns or belongs to. */
export async function getAgencyOverview(): Promise<AgencyOverview | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  // Resolve the user's org: one they own, else one they're a member of.
  const { data: ownedOrg } = await sb
    .from("orgs")
    .select("id, name")
    .eq("owner_id", user.id)
    .maybeSingle();
  let org = ownedOrg as { id: string; name: string } | null;
  let isOwner = !!org;
  if (!org) {
    const { data: mem } = await sb
      .from("org_members")
      .select("org:orgs(id, name)")
      .eq("profile_id", user.id)
      .maybeSingle();
    org = (mem as unknown as { org: { id: string; name: string } | null } | null)?.org ?? null;
  }
  if (!org) return null;

  const { data: statRows } = await sb.rpc("org_account_stats", { p_org: org.id });
  const creators: OrgCreatorStat[] = ((statRows ?? []) as {
    id: string;
    email: string | null;
    display_name: string | null;
    wheels: number;
    fans: number;
    spins: number;
    pending: number;
    revenue: number;
  }[]).map((r) => ({
    id: r.id,
    displayName: r.display_name ?? r.email ?? "Creator",
    email: r.email ?? "",
    wheels: Number(r.wheels),
    fans: Number(r.fans),
    spins: Number(r.spins),
    pending: Number(r.pending),
    revenue: Number(r.revenue),
  }));

  // Pending outgoing invites (owner-only view; RLS returns none to staff).
  const { data: inviteRows } = await sb
    .from("org_invites")
    .select("id, email")
    .eq("org_id", org.id)
    .eq("status", "pending");
  const invites: PendingInvite[] = ((inviteRows ?? []) as { id: string; email: string }[]).map(
    (r) => ({ id: r.id, email: r.email })
  );

  const { data: memberRows } = await sb
    .from("org_members")
    .select("id, role, profile:profiles(id, email, display_name)")
    .eq("org_id", org.id);
  const members: OrgMember[] = ((memberRows ?? []) as unknown as {
    id: string;
    role: OrgRole;
    profile: { id: string; email: string | null; display_name: string | null } | null;
  }[]).map((m) => ({
    id: m.id,
    profileId: m.profile?.id ?? "",
    email: m.profile?.email ?? "",
    displayName: m.profile?.display_name ?? m.profile?.email ?? "Member",
    role: m.role,
  }));

  return {
    org,
    isOwner,
    totals: {
      creators: creators.length,
      fans: creators.reduce((s, c) => s + c.fans, 0),
      spins: creators.reduce((s, c) => s + c.spins, 0),
      pending: creators.reduce((s, c) => s + c.pending, 0),
      revenue: creators.reduce((s, c) => s + c.revenue, 0),
    },
    creators,
    members,
    invites,
  };
}

/** Create the caller's agency org (or return their existing one). */
export async function createOrg(name: string): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const { error } = await sb.rpc("org_create", { p_name: name });
  return error ? { error: "db_error" } : { ok: true };
}

type OrgRpc =
  | { fn: "org_invite_creator"; args: { p_org: string; p_email: string } }
  | { fn: "org_invite_revoke"; args: { p_invite: string } }
  | { fn: "org_invite_respond"; args: { p_invite: string; p_accept: boolean } }
  | { fn: "org_remove_creator"; args: { p_org: string; p_creator: string } }
  | { fn: "org_add_member"; args: { p_org: string; p_email: string; p_role: OrgRole } }
  | { fn: "org_remove_member"; args: { p_member: string } }
  | { fn: "org_scope_creator"; args: { p_member: string; p_creator: string; p_on: boolean } };

/** Run an owner-guarded agency RPC; the RPC returns a status string. */
async function agencyRpc(call: OrgRpc): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const { data, error } = await sb.rpc(call.fn, call.args);
  if (error) return { error: "db_error" };
  return data === "ok" ? { ok: true } : { error: String(data) };
}

// Creators join via consent: the owner sends an invite, the creator accepts.
export const inviteOrgCreator = (orgId: string, email: string) =>
  agencyRpc({ fn: "org_invite_creator", args: { p_org: orgId, p_email: email } });
export const revokeOrgInvite = (inviteId: string) =>
  agencyRpc({ fn: "org_invite_revoke", args: { p_invite: inviteId } });
export const respondToOrgInvite = (inviteId: string, accept: boolean) =>
  agencyRpc({ fn: "org_invite_respond", args: { p_invite: inviteId, p_accept: accept } });
export const removeOrgCreator = (orgId: string, creatorId: string) =>
  agencyRpc({ fn: "org_remove_creator", args: { p_org: orgId, p_creator: creatorId } });
export const addOrgMember = (orgId: string, email: string, role: OrgRole) =>
  agencyRpc({ fn: "org_add_member", args: { p_org: orgId, p_email: email, p_role: role } });
export const removeOrgMember = (memberId: string) =>
  agencyRpc({ fn: "org_remove_member", args: { p_member: memberId } });
export const scopeOrgCreator = (memberId: string, creatorId: string, on: boolean) =>
  agencyRpc({ fn: "org_scope_creator", args: { p_member: memberId, p_creator: creatorId, p_on: on } });

export interface MyInvite {
  id: string;
  orgId: string;
  orgName: string;
}

/** Pending agency invites addressed to the signed-in user (for their dashboard). */
export async function getMyInvites(): Promise<MyInvite[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  const { data } = await sb
    .from("org_invites")
    .select("id, org_id, status, org:orgs(name)")
    .eq("status", "pending");
  return ((data ?? []) as unknown as {
    id: string;
    org_id: string;
    org: { name: string } | null;
  }[]).map((r) => ({ id: r.id, orgId: r.org_id, orgName: r.org?.name ?? "An agency" }));
}

export async function updateAccount(
  id: string,
  patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockUpdateAccount(id, patch) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  if (!(await requireAdmin(sb))) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if (patch.role) upd.role = patch.role;
  if (typeof patch.isActive === "boolean") upd.is_active = patch.isActive;
  if (patch.features) upd.features = patch.features;
  if (Object.keys(upd).length === 0) return { ok: true };

  const { error } = await sb.from("profiles").update(upd).eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

export async function createCreatorAccount(
  email: string,
  password: string,
  displayName: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    mockCreateAccount(email, displayName);
    return { ok: true };
  }

  const sb = await createClient();
  if (!(await requireAdmin(sb))) return { error: "unauthorized" };

  // Service role is required to create a user without a sign-up flow.
  const svc = createServiceClient();
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName || email },
  });
  if (error || !data.user) return { error: error?.message ?? "create_failed" };

  await svc
    .from("profiles")
    .update({ display_name: displayName || email, approval_status: "approved" })
    .eq("id", data.user.id);
  return { ok: true };
}

// --- Gated signups: request → admin approval queue ---------------------------

export type ApprovalStatus = "pending" | "approved" | "rejected" | "none";

/** The signed-in user's approval status (drives the dashboard gate). */
export async function getMyApprovalStatus(): Promise<ApprovalStatus> {
  if (!isSupabaseConfigured()) return "approved"; // demo: always in
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return "none";
  const { data } = await sb
    .from("profiles")
    .select("approval_status, role")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as { approval_status: ApprovalStatus; role: AppRole } | null;
  if (!row) return "none";
  if (row.role === "admin") return "approved";
  return row.approval_status;
}

/** A signed-in pending user submits their creator details for vetting. */
export async function submitCreatorApplication(input: {
  displayName?: string;
  socials?: string;
  audienceSize?: string;
  note?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.from("creator_applications").upsert(
    {
      profile_id: user.id,
      email: user.email ?? null,
      display_name: input.displayName?.slice(0, 120) ?? null,
      socials: input.socials?.slice(0, 600) ?? null,
      audience_size: input.audienceSize?.slice(0, 120) ?? null,
      note: input.note?.slice(0, 1000) ?? null,
      status: "pending",
    },
    { onConflict: "profile_id" }
  );
  return error ? { error: "db_error" } : { ok: true };
}

export interface CreatorApplication {
  id: string;
  profileId: string;
  email: string | null;
  displayName: string | null;
  socials: string | null;
  audienceSize: string | null;
  note: string | null;
  status: ApprovalStatus;
  createdAt: string;
}

/** Admin: the pending (and recently-decided) creator applications. */
export async function listCreatorApplications(): Promise<CreatorApplication[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  if (!(await requireAdmin(sb))) return [];

  const { data } = await sb
    .from("creator_applications")
    .select(
      "id, profile_id, email, display_name, socials, audience_size, note, status, created_at"
    )
    .order("created_at", { ascending: false });

  return ((data ?? []) as {
    id: string;
    profile_id: string;
    email: string | null;
    display_name: string | null;
    socials: string | null;
    audience_size: string | null;
    note: string | null;
    status: ApprovalStatus;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    email: r.email,
    displayName: r.display_name,
    socials: r.socials,
    audienceSize: r.audience_size,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** Admin: approve or reject a creator application (flips the profile gate too). */
export async function decideCreatorApplication(
  profileId: string,
  decision: "approved" | "rejected"
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  if (!(await requireAdmin(sb))) return { error: "unauthorized" };

  const now = new Date().toISOString();
  const { error: aErr } = await sb
    .from("creator_applications")
    .update({ status: decision, decided_at: now })
    .eq("profile_id", profileId);
  if (aErr) return { error: "db_error" };

  const { error: pErr } = await sb
    .from("profiles")
    .update({ approval_status: decision })
    .eq("id", profileId);
  return pErr ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Phase 3: happy hours, share cards, wishlist, leaderboard, referrals, chat,
// and the public teaser. Creator paths use the RLS client; fan/public paths use
// the service-role client keyed by token (fans never authenticate).
// ---------------------------------------------------------------------------

function toHappyHour(r: {
  id: string;
  wheel_id: string;
  multiplier: number;
  starts_at: string;
  ends_at: string;
}): HappyHour {
  return {
    id: r.id,
    wheelId: r.wheel_id,
    multiplier: r.multiplier,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  };
}

const HAPPY_HOUR_SELECT = "id, wheel_id, multiplier, starts_at, ends_at";

/** All the creator's happy-hour windows (optionally for one wheel), newest first. */
export async function listHappyHours(wheelId?: string): Promise<HappyHour[]> {
  if (!isSupabaseConfigured()) return mockListHappyHours(wheelId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  let query = sb
    .from("happy_hours")
    .select(HAPPY_HOUR_SELECT)
    .eq("creator_id", user.id)
    .order("starts_at", { ascending: false });
  if (wheelId) query = query.eq("wheel_id", wheelId);

  const { data } = await query;
  const rows = (data ?? []) as Parameters<typeof toHappyHour>[0][];
  return rows.map(toHappyHour);
}

export async function createHappyHour(input: {
  wheelId: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
}): Promise<HappyHour | { error: string }> {
  if (!isSupabaseConfigured()) return mockCreateHappyHour(input);

  if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime())
    return { error: "invalid_window" };
  const multiplier = Number(input.multiplier);
  if (!(multiplier >= 1 && multiplier <= 10))
    return { error: "invalid_multiplier" };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // Ownership: the wheel must belong to this creator.
  const { data: wheel } = await sb
    .from("wheels")
    .select("id")
    .eq("id", input.wheelId)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!wheel) return { error: "not_found" };

  const { data, error } = await sb
    .from("happy_hours")
    .insert({
      creator_id: user.id,
      wheel_id: input.wheelId,
      multiplier,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
    })
    .select(HAPPY_HOUR_SELECT)
    .single();
  if (error || !data) return { error: "db_error" };
  return toHappyHour(data as Parameters<typeof toHappyHour>[0]);
}

export async function deleteHappyHour(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteHappyHour(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("happy_hours")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * A render-ready public share card for a single spin, keyed by its non-secret
 * share_id. Service-role read (fans aren't authenticated). Returns ONLY display
 * fields — never the pass token or any fan identity.
 */
export async function getShareCard(
  shareId: string
): Promise<ShareCardData | null> {
  if (!isSupabaseConfigured()) return mockGetShareCard(shareId);

  const sb = createServiceClient();
  const { data } = await sb
    .from("spins")
    .select(
      "prize_label, prize_rarity, prize_image_url, created_at, creator:profiles(display_name)"
    )
    .eq("share_id", shareId)
    .maybeSingle();

  const row = data as unknown as {
    prize_label: string;
    prize_rarity: Rarity;
    prize_image_url: string | null;
    created_at: string;
    creator: { display_name: string | null } | null;
  } | null;
  if (!row) return null;

  return {
    creatorTitle: row.creator?.display_name ?? "Creator",
    prizeLabel: row.prize_label,
    rarity: row.prize_rarity,
    color: RARITY_COLORS[row.prize_rarity],
    imageUrl: row.prize_image_url ?? null,
    at: row.created_at,
  };
}

// --- Provably-fair verification (#23) ---------------------------------------

/**
 * The fairness data for a single spin, keyed by its non-secret share_id. Reveals
 * the committed server seed + hash so a public verify page can recompute the
 * hash and confirm the commitment held. Service-role read (fans aren't authed).
 * Returns null when the spin isn't found or has no committed seed (older spins).
 */
export async function getSpinVerification(
  shareId: string
): Promise<SpinVerification | null> {
  if (!isSupabaseConfigured()) return mockGetSpinVerification(shareId);

  const sb = createServiceClient();
  const { data } = await sb
    .from("spins")
    .select(
      "prize_label, prize_rarity, server_seed, server_seed_hash, nonce, created_at"
    )
    .eq("share_id", shareId)
    .maybeSingle();

  const row = data as {
    prize_label: string;
    prize_rarity: Rarity;
    server_seed: string | null;
    server_seed_hash: string | null;
    nonce: number | null;
    created_at: string;
  } | null;
  if (!row || !row.server_seed || !row.server_seed_hash) return null;

  const hashOk = (await sha256Hex(row.server_seed)) === row.server_seed_hash;
  return {
    prizeLabel: row.prize_label,
    rarity: row.prize_rarity,
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    nonce: row.nonce ?? 0,
    hashOk,
    at: row.created_at,
  };
}

// --- Webhooks (#24) ---------------------------------------------------------

/** The creator's registered outbound webhooks (newest first, RLS-scoped). */
export async function listWebhooks(): Promise<Webhook[]> {
  if (!isSupabaseConfigured()) return mockListWebhooks();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("webhooks")
    .select("id, url, event, created_at")
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as {
    id: string;
    url: string;
    event: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    event: r.event,
    createdAt: r.created_at,
  }));
}

export async function createWebhook(
  url: string,
  event = "prize_pending"
): Promise<Webhook | { error: string }> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return { error: "invalid_url" };
  if (!isSupabaseConfigured()) return mockCreateWebhook(trimmed, event);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data, error } = await sb
    .from("webhooks")
    .insert({ creator_id: user.id, url: trimmed, event })
    .select("id, url, event, created_at")
    .single();
  if (error || !data) return { error: "db_error" };
  return {
    id: data.id,
    url: data.url,
    event: data.event,
    createdAt: data.created_at,
  };
}

export async function deleteWebhook(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteWebhook(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.from("webhooks").delete().eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Best-effort fan-out: POST `payload` as JSON to each of the creator's webhooks,
 * swallowing every error so a slow/failing endpoint can't break a spin. No-op in
 * demo mode.
 */
export async function fireWebhooks(
  creatorId: string,
  payload: object
): Promise<void> {
  if (!isSupabaseConfigured()) return mockFireWebhooks(creatorId, payload);

  try {
    const sb = createServiceClient();
    const { data } = await sb
      .from("webhooks")
      .select("url")
      .eq("creator_id", creatorId);
    const hooks = (data ?? []) as { url: string }[];
    const body = JSON.stringify(payload);
    await Promise.allSettled(
      hooks.map((h) =>
        fetch(h.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      )
    );
  } catch {
    /* never throws */
  }
}

// --- Age-gate / ToS (#24) ---------------------------------------------------

/** Stamp the age-gate / ToS acknowledgement on the fan behind a token. */
export async function ackFan(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockAckFan(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const { error } = await sb
    .from("fans")
    .update({ acked_at: new Date().toISOString() })
    .eq("id", resolved.fanId);
  return error ? { error: "db_error" } : { ok: true };
}

// --- Wishlist ---------------------------------------------------------------

/** Resolve the fan + creator + active wheel behind a token (service role). */
async function resolveFanByToken(
  sb: ReturnType<typeof createServiceClient>,
  token: string
): Promise<{
  fanId: string;
  creatorId: string;
  campaignId: string | null;
  wheelId: string;
} | null> {
  const { data } = await sb
    .from("fan_passes")
    .select("creator_id, campaign_id, wheel_id, fan_id")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = data as {
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    fan_id: string;
  } | null;
  if (!pass) return null;
  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return null;
  return {
    fanId: pass.fan_id,
    creatorId: pass.creator_id,
    campaignId: pass.campaign_id,
    wheelId,
  };
}

export async function addWishlist(
  token: string,
  prizeLabel: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockAddWishlist(token, prizeLabel);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  // The label must exist on the fan's resolved wheel; snapshot its rarity.
  const { data: prize } = await sb
    .from("prizes")
    .select("id, rarity")
    .eq("wheel_id", resolved.wheelId)
    .eq("label", prizeLabel)
    .maybeSingle();
  const p = prize as { id: string; rarity: Rarity } | null;
  if (!p) return { error: "invalid_prize" };

  const { error } = await sb
    .from("wishlists")
    .upsert(
      {
        creator_id: resolved.creatorId,
        fan_id: resolved.fanId,
        prize_id: p.id,
        prize_label: prizeLabel,
        prize_rarity: p.rarity,
      },
      { onConflict: "fan_id,prize_label" }
    );
  return error ? { error: "db_error" } : { ok: true };
}

export async function removeWishlist(
  token: string,
  prizeLabel: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockRemoveWishlist(token, prizeLabel);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const { error } = await sb
    .from("wishlists")
    .delete()
    .eq("fan_id", resolved.fanId)
    .eq("prize_label", prizeLabel);
  return error ? { error: "db_error" } : { ok: true };
}

/** Aggregated wishlist demand across the creator's fans (authed, RLS-scoped). */
export async function getWishlistDemand(): Promise<WishlistDemand[]> {
  if (!isSupabaseConfigured()) return mockGetWishlistDemand();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("wishlists")
    .select(
      "prize_label, prize_rarity, fan:fans(display_name, handle)"
    )
    .eq("creator_id", user.id);

  const rows = (data ?? []) as unknown as {
    prize_label: string;
    prize_rarity: Rarity;
    fan: { display_name: string | null; handle: string | null } | null;
  }[];

  const byLabel = new Map<
    string,
    { prizeLabel: string; rarity: Rarity; count: number; fanNames: string[] }
  >();
  for (const r of rows) {
    let entry = byLabel.get(r.prize_label);
    if (!entry) {
      entry = {
        prizeLabel: r.prize_label,
        rarity: r.prize_rarity,
        count: 0,
        fanNames: [],
      };
      byLabel.set(r.prize_label, entry);
    }
    entry.count += 1;
    const name = r.fan?.display_name ?? r.fan?.handle;
    if (name) entry.fanNames.push(name);
  }
  return [...byLabel.values()].sort((a, b) => b.count - a.count);
}

// --- Leaderboard ------------------------------------------------------------

export async function setLeaderboardEnabled(
  enabled: boolean
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetLeaderboardEnabled(enabled);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.rpc("set_leaderboard_enabled", {
    p_enabled: enabled,
  });
  return error ? { error: "db_error" } : { ok: true };
}

export async function setFanLeaderboardOptIn(
  token: string,
  optIn: boolean,
  handle?: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured())
    return mockSetFanLeaderboardOptIn(token, optIn, handle);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const upd: Record<string, unknown> = { leaderboard_opt_in: optIn };
  if (handle !== undefined) upd.handle = handle;
  const { error } = await sb.from("fans").update(upd).eq("id", resolved.fanId);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * The public leaderboard for a creator (service role; fans aren't authed). When
 * the creator hasn't enabled it, returns enabled:false with no entries. Only
 * opted-in fans appear, and only their handle (never email/token/fan_id).
 */
export async function getLeaderboard(
  creatorIdOrSlug: string
): Promise<LeaderboardView> {
  if (!isSupabaseConfigured()) return mockGetLeaderboard(creatorIdOrSlug);

  const sb = createServiceClient();
  // Accept either a UUID id or a public_slug, so the shareable URL can be
  // /leaderboard/<slug> (pretty) or /leaderboard/<uuid> (internal).
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      creatorIdOrSlug
    );
  const { data: profile } = await sb
    .from("profiles")
    .select("id, display_name, leaderboard_enabled")
    .eq(isUuid ? "id" : "public_slug", creatorIdOrSlug)
    .maybeSingle();
  const creatorId = (profile as { id: string } | null)?.id ?? creatorIdOrSlug;
  const prof = profile as {
    display_name: string | null;
    leaderboard_enabled: boolean;
  } | null;
  const creatorTitle = prof?.display_name ?? "Creator";

  if (!prof || !prof.leaderboard_enabled) {
    return { enabled: false, creatorTitle, entries: [] };
  }

  const { data: fanRows } = await sb
    .from("fans")
    .select("id, handle, display_name")
    .eq("creator_id", creatorId)
    .eq("leaderboard_opt_in", true);
  const fans = (fanRows ?? []) as {
    id: string;
    handle: string | null;
    display_name: string | null;
  }[];
  if (fans.length === 0) return { enabled: true, creatorTitle, entries: [] };

  const fanIds = fans.map((f) => f.id);

  const { data: spinRows } = await sb
    .from("spins")
    .select("fan_id, prize_rarity")
    .in("fan_id", fanIds);
  const spins = (spinRows ?? []) as { fan_id: string; prize_rarity: Rarity }[];

  const { data: grantRows } = await sb
    .from("grants")
    .select("fan_id, amount_cents")
    .in("fan_id", fanIds);
  const grants = (grantRows ?? []) as {
    fan_id: string;
    amount_cents: number;
  }[];

  const spinCount = new Map<string, number>();
  const rareCount = new Map<string, number>();
  for (const s of spins) {
    spinCount.set(s.fan_id, (spinCount.get(s.fan_id) ?? 0) + 1);
    if (s.prize_rarity === "rare" || s.prize_rarity === "epic" || s.prize_rarity === "legendary") {
      rareCount.set(s.fan_id, (rareCount.get(s.fan_id) ?? 0) + 1);
    }
  }
  const spentCount = new Map<string, number>();
  for (const g of grants) {
    spentCount.set(g.fan_id, (spentCount.get(g.fan_id) ?? 0) + g.amount_cents);
  }

  const firstName = (name: string | null): string =>
    (name ?? "").trim().split(/\s+/)[0] || "Fan";

  const entries: LeaderboardEntry[] = fans
    .map((f) => ({
      handle: f.handle ?? firstName(f.display_name),
      spins: spinCount.get(f.id) ?? 0,
      spentCents: spentCount.get(f.id) ?? 0,
      rareWins: rareCount.get(f.id) ?? 0,
    }))
    .sort((a, b) => b.spins - a.spins)
    .slice(0, 100) // sane upper bound for the public board
    .map((e, i) => ({ rank: i + 1, ...e }));

  return { enabled: true, creatorTitle, entries };
}

export interface RecentWin {
  handle: string;
  prizeLabel: string;
  rarity: Rarity;
  at: string;
}

/**
 * Recent notable wins (rare+), handle-only, from fans who opted into the
 * leaderboard. Honest social proof for the ticker — gated by the same opt-in,
 * so no fan is ever surfaced without consent. Returns [] when the board is off.
 */
export async function getRecentWins(creatorIdOrSlug: string): Promise<RecentWin[]> {
  if (!isSupabaseConfigured()) return mockGetRecentWins();
  const sb = createServiceClient();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creatorIdOrSlug);
  const { data: profile } = await sb
    .from("profiles")
    .select("id, leaderboard_enabled")
    .eq(isUuid ? "id" : "public_slug", creatorIdOrSlug)
    .maybeSingle();
  const prof = profile as { id: string; leaderboard_enabled: boolean } | null;
  if (!prof || !prof.leaderboard_enabled) return [];

  const { data: fanRows } = await sb
    .from("fans")
    .select("id, handle, display_name")
    .eq("creator_id", prof.id)
    .eq("leaderboard_opt_in", true);
  const fans = (fanRows ?? []) as {
    id: string;
    handle: string | null;
    display_name: string | null;
  }[];
  if (fans.length === 0) return [];
  const byId = new Map(fans.map((f) => [f.id, f]));

  const { data: spinRows } = await sb
    .from("spins")
    .select("fan_id, prize_label, prize_rarity, created_at")
    .in("fan_id", Array.from(byId.keys()))
    .in("prize_rarity", ["rare", "epic", "legendary"])
    .order("created_at", { ascending: false })
    .limit(20);

  const firstName = (name: string | null): string =>
    (name ?? "").trim().split(/\s+/)[0] || "Fan";

  return ((spinRows ?? []) as {
    fan_id: string;
    prize_label: string;
    prize_rarity: Rarity;
    created_at: string;
  }[]).map((s) => {
    const f = byId.get(s.fan_id);
    return {
      handle: f?.handle ?? firstName(f?.display_name ?? null),
      prizeLabel: s.prize_label,
      rarity: s.prize_rarity,
      at: s.created_at,
    };
  });
}

// --- Referral ---------------------------------------------------------------

export async function getReferralOverview(
  token: string
): Promise<ReferralOverview> {
  if (!isSupabaseConfigured())
    return (
      mockGetReferralOverview(token) ?? {
        code: "",
        referredCount: 0,
        creditedCount: 0,
        cap: REFERRAL_CAP,
        bonusPerReferral: REFERRAL_BONUS,
      }
    );

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("fan:fans(id, referral_code)")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const fan = (passData as unknown as {
    fan: { id: string; referral_code: string | null } | null;
  } | null)?.fan;

  const base = {
    code: fan?.referral_code ?? "",
    referredCount: 0,
    creditedCount: 0,
    cap: REFERRAL_CAP,
    bonusPerReferral: REFERRAL_BONUS,
  };
  if (!fan) return base;

  const { count: referredCount } = await sb
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_fan_id", fan.id);
  const { count: creditedCount } = await sb
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_fan_id", fan.id)
    .not("credited_at", "is", null);

  return {
    ...base,
    referredCount: referredCount ?? 0,
    creditedCount: creditedCount ?? 0,
  };
}

export async function getReferralStats(): Promise<{
  referredCount: number;
  creditedCount: number;
  bonusAwarded: number;
}> {
  if (!isSupabaseConfigured()) return mockGetReferralStats();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { referredCount: 0, creditedCount: 0, bonusAwarded: 0 };

  const { data } = await sb
    .from("referrals")
    .select("credited_at, bonus_spins")
    .eq("creator_id", user.id);
  const rows = (data ?? []) as {
    credited_at: string | null;
    bonus_spins: number;
  }[];

  const referredCount = rows.length;
  const credited = rows.filter((r) => r.credited_at !== null);
  const creditedCount = credited.length;
  // Both parties receive bonus_spins per credited referral.
  const bonusAwarded = credited.reduce((s, r) => s + r.bonus_spins * 2, 0);
  return { referredCount, creditedCount, bonusAwarded };
}

// --- Chat (spin-gated; messages are FREE) -----------------------------------

function toChatMessage(r: {
  id: string;
  sender: "fan" | "creator";
  body: string;
  created_at: string;
  read_at: string | null;
}): ChatMessage {
  return {
    id: r.id,
    sender: r.sender,
    body: r.body,
    at: r.created_at,
    readAt: r.read_at,
  };
}

const MESSAGE_SELECT = "id, sender, body, created_at, read_at";

export async function sendFanMessage(
  token: string,
  body: string
): Promise<{ ok: true } | { error: "not_found" | "locked" | "empty" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    const res = mockSendFanMessage(token, body);
    if ("ok" in res) return res;
    // The mock may use its own validation code ("invalid_body"); normalize any
    // unknown error to the contract's "empty".
    const known = ["not_found", "locked", "empty", "db_error"] as const;
    type Known = (typeof known)[number];
    const code = (known as readonly string[]).includes(res.error)
      ? (res.error as Known)
      : "empty";
    return { error: code };
  }

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("creator_id, fan:fans(id, spins_remaining, spins_granted_total)")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = passData as unknown as {
    creator_id: string;
    fan: {
      id: string;
      spins_remaining: number;
      spins_granted_total: number;
    } | null;
  } | null;
  if (!pass || !pass.fan) return { error: "not_found" };

  // GATE: chat unlocks while the fan holds spins OR has ever been granted any.
  if (!(pass.fan.spins_remaining > 0 || pass.fan.spins_granted_total > 0))
    return { error: "locked" };

  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) return { error: "empty" };

  const { error } = await sb.from("messages").insert({
    creator_id: pass.creator_id,
    fan_id: pass.fan.id,
    sender: "fan",
    body: trimmed,
  });
  return error ? { error: "db_error" } : { ok: true };
}

export async function getFanMessages(token: string): Promise<ChatMessage[]> {
  if (!isSupabaseConfigured()) return mockGetFanMessages(token);

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("creator_id, fan_id")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = passData as { creator_id: string; fan_id: string } | null;
  if (!pass) return [];

  const { data } = await sb
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("creator_id", pass.creator_id)
    .eq("fan_id", pass.fan_id)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as Parameters<typeof toChatMessage>[0][];

  // Mark creator→fan messages as read by the fan.
  await sb
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("creator_id", pass.creator_id)
    .eq("fan_id", pass.fan_id)
    .eq("sender", "creator")
    .is("read_at", null);

  return rows.map(toChatMessage);
}

/** The creator's inbox: one row per fan, newest activity first (authed/RLS). */
export async function listThreads(): Promise<FanThread[]> {
  if (!isSupabaseConfigured()) return mockListThreads();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("messages")
    .select(
      "fan_id, sender, body, read_at, created_at, fan:fans(display_name, handle)"
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as unknown as {
    fan_id: string;
    sender: "fan" | "creator";
    body: string;
    read_at: string | null;
    created_at: string;
    fan: { display_name: string | null; handle: string | null } | null;
  }[];

  const threads = new Map<string, FanThread>();
  for (const r of rows) {
    // Rows are newest-first, so the FIRST row per fan is the latest message.
    let t = threads.get(r.fan_id);
    if (!t) {
      t = {
        fanId: r.fan_id,
        fanName: r.fan?.display_name ?? r.fan?.handle ?? "Fan",
        lastBody: r.body,
        lastAt: r.created_at,
        unread: 0,
      };
      threads.set(r.fan_id, t);
    }
    if (r.sender === "fan" && r.read_at === null) t.unread += 1;
  }
  return [...threads.values()];
}

export async function getThread(fanId: string): Promise<ChatMessage[]> {
  if (!isSupabaseConfigured()) return mockGetThread(fanId);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("creator_id", user.id)
    .eq("fan_id", fanId)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as Parameters<typeof toChatMessage>[0][];

  // Mark fan→creator messages as read by the creator.
  await sb
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("creator_id", user.id)
    .eq("fan_id", fanId)
    .eq("sender", "fan")
    .is("read_at", null);

  return rows.map(toChatMessage);
}

export async function sendCreatorMessage(
  fanId: string,
  body: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSendCreatorMessage(fanId, body);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) return { error: "empty" };

  const { error } = await sb.from("messages").insert({
    creator_id: user.id,
    fan_id: fanId,
    sender: "creator",
    body: trimmed,
  });
  return error ? { error: "db_error" } : { ok: true };
}

// --- Wave 3: editable auto intro/outro --------------------------------------

/** The creator's editable auto greeting + out-of-spins messages (authed/RLS). */
export async function getChatSettings(): Promise<ChatSettings> {
  if (!isSupabaseConfigured()) return mockGetChatSettings();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { intro: null, outro: null };

  const { data } = await sb
    .from("profiles")
    .select("chat_intro, chat_outro")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as { chat_intro: string | null; chat_outro: string | null } | null;
  return { intro: row?.chat_intro ?? null, outro: row?.chat_outro ?? null };
}

/** Update the creator's auto greeting + out-of-spins messages (authed/RLS). */
export async function setChatSettings(input: {
  intro?: string | null;
  outro?: string | null;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetChatSettings(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if (input.intro !== undefined) {
    const t = (input.intro ?? "").trim();
    upd.chat_intro = t || null;
  }
  if (input.outro !== undefined) {
    const t = (input.outro ?? "").trim();
    upd.chat_outro = t || null;
  }
  if (Object.keys(upd).length === 0) return { ok: true };

  const { error } = await sb.from("profiles").update(upd).eq("id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Auto-send the creator's greeting when a fan first opens chat (service role:
 * fans aren't authed). Inserts the intro as a `creator` message only if the
 * creator has a non-empty chat_intro AND the thread has ZERO messages.
 * Idempotent: a no-op once any message exists.
 */
export async function ensureChatIntro(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockEnsureChatIntro(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const { data: profile } = await sb
    .from("profiles")
    .select("chat_intro")
    .eq("id", resolved.creatorId)
    .maybeSingle();
  const intro = ((profile as { chat_intro: string | null } | null)?.chat_intro ?? "").trim();
  if (!intro) return { ok: true };

  const { count } = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", resolved.creatorId)
    .eq("fan_id", resolved.fanId);
  if ((count ?? 0) > 0) return { ok: true };

  const { error } = await sb.from("messages").insert({
    creator_id: resolved.creatorId,
    fan_id: resolved.fanId,
    sender: "creator",
    body: intro,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Auto-send the creator's out-of-spins nudge (service role). Inserts the outro
 * as a `creator` message only if the creator has a non-empty chat_outro AND the
 * most-recent message isn't already that exact outro (guards against spamming).
 */
export async function sendChatOutro(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSendChatOutro(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const { data: profile } = await sb
    .from("profiles")
    .select("chat_outro")
    .eq("id", resolved.creatorId)
    .maybeSingle();
  const outro = ((profile as { chat_outro: string | null } | null)?.chat_outro ?? "").trim();
  if (!outro) return { ok: true };

  const { data: lastRow } = await sb
    .from("messages")
    .select("sender, body")
    .eq("creator_id", resolved.creatorId)
    .eq("fan_id", resolved.fanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = lastRow as { sender: "fan" | "creator"; body: string } | null;
  if (last && last.sender === "creator" && last.body === outro) return { ok: true };

  const { error } = await sb.from("messages").insert({
    creator_id: resolved.creatorId,
    fan_id: resolved.fanId,
    sender: "creator",
    body: outro,
  });
  return error ? { error: "db_error" } : { ok: true };
}

// --- Public teaser ----------------------------------------------------------

/**
 * A token-free preview of a creator's active wheel + current happy hour, for a
 * public landing page. Service role; no spinning, no fan identity.
 */
export async function getPublicWheelTeaser(
  creatorId: string
): Promise<{ creatorTitle: string; wheel: WheelConfig; happyHour: HappyHourStatus } | null> {
  if (!isSupabaseConfigured()) return mockGetPublicWheelTeaser(creatorId);

  const sb = createServiceClient();
  const wheelId = await resolveActiveWheelId(sb, creatorId, new Date());
  if (!wheelId) return null;

  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return null;

  const { data: profile } = await sb
    .from("profiles")
    .select("display_name")
    .eq("id", creatorId)
    .maybeSingle();
  const creatorTitle =
    (profile as { display_name: string | null } | null)?.display_name ??
    "Creator";

  const happyHour = await getActiveHappyHour(sb, wheelId, new Date());
  return {
    creatorTitle,
    wheel: toWheelConfig(wheelData as unknown as DbWheelRow),
    happyHour,
  };
}

// --- SFW link-in-bio public profile -----------------------------------------

export interface PublicProfile {
  creatorTitle: string;
  tagline: string | null;
  brandColor: string;
  // SFW prize teaser: labels + rarities only (no explicit media), best first.
  prizes: { label: string; rarity: Rarity; emoji?: string }[];
  hasTipUrl: boolean;
}

/** Public, SFW landing data for a creator's link-in-bio page (by slug). */
export async function getPublicProfileBySlug(
  slug: string
): Promise<{ profile: PublicProfile; tipUrl: string | null } | null> {
  if (!isSupabaseConfigured()) {
    return {
      profile: {
        creatorTitle: "Demo Creator",
        tagline: "Spin my wheel — every spin wins 🎡",
        brandColor: "#ec4899",
        prizes: SAMPLE_WHEEL.prizes.slice(0, 6).map((p) => ({
          label: p.label,
          rarity: p.rarity,
          emoji: p.emoji,
        })),
        hasTipUrl: true,
      },
      tipUrl: "#",
    };
  }
  const sb = createServiceClient();
  const { data: prof } = await sb
    .from("profiles")
    .select("id, display_name, public_tagline, tip_url")
    .eq("public_slug", slug)
    .maybeSingle();
  const p = prof as {
    id: string;
    display_name: string | null;
    public_tagline: string | null;
    tip_url: string | null;
  } | null;
  if (!p) return null;

  const wheelId = await resolveActiveWheelId(sb, p.id, new Date());
  let brandColor = "#ec4899";
  let prizes: { label: string; rarity: Rarity; emoji?: string }[] = [];
  if (wheelId) {
    const { data: wheelData } = await sb
      .from("wheels")
      .select(WHEEL_SELECT)
      .eq("id", wheelId)
      .maybeSingle();
    if (wheelData) {
      const cfg = toWheelConfig(wheelData as unknown as DbWheelRow);
      brandColor = cfg.brandColor ?? "#ec4899";
      prizes = cfg.prizes
        .slice()
        .sort(
          (a, b) =>
            RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
        )
        .slice(0, 6)
        .map((pr) => ({ label: pr.label, rarity: pr.rarity, emoji: pr.emoji }));
    }
  }

  return {
    profile: {
      creatorTitle: p.display_name ?? "Creator",
      tagline: p.public_tagline,
      brandColor,
      prizes,
      hasTipUrl: !!p.tip_url,
    },
    tipUrl: p.tip_url,
  };
}

/** The signed-in creator's editable public-profile fields. */
export async function getMyPublicProfile(): Promise<{
  slug: string | null;
  tipUrl: string | null;
  tagline: string | null;
  note: string | null;
  avatarUrl: string | null;
}> {
  if (!isSupabaseConfigured())
    return { slug: "demo-creator", tipUrl: "", tagline: "", note: "", avatarUrl: "" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { slug: null, tipUrl: null, tagline: null, note: null, avatarUrl: null };
  const { data } = await sb
    .from("profiles")
    .select("public_slug, tip_url, public_tagline, creator_note, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as {
    public_slug: string | null;
    tip_url: string | null;
    public_tagline: string | null;
    creator_note: string | null;
    avatar_url: string | null;
  } | null;
  return {
    slug: row?.public_slug ?? null,
    tipUrl: row?.tip_url ?? null,
    tagline: row?.public_tagline ?? null,
    note: row?.creator_note ?? null,
    avatarUrl: row?.avatar_url ?? null,
  };
}

/** Creator updates their SFW link-in-bio fields + fan-page personal note. */
export async function setMyPublicProfile(input: {
  slug: string;
  tipUrl: string;
  tagline: string;
  note?: string;
  avatarUrl?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  // Normalize the slug to URL-safe lowercase.
  const slug = input.slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const { error } = await sb.rpc("set_public_profile", {
    p_slug: slug,
    p_tip_url: externalUrl(input.tipUrl),
    p_tagline: input.tagline,
  });
  if (error) return { error: "db_error" };
  if (input.note !== undefined || input.avatarUrl !== undefined) {
    await sb.rpc("set_creator_note", {
      p_note: input.note ?? "",
      p_avatar: input.avatarUrl ?? "",
    });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
function toWheelConfig(wheel: DbWheelRow): WheelConfig {
  const prizes: Prize[] = (wheel.prizes ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description ?? undefined,
      rarity: p.rarity,
      weight: p.weight,
      color: p.color ?? RARITY_COLORS[p.rarity],
      emoji: p.emoji ?? undefined,
      imageUrl: p.image_url ?? null,
      cost: p.cost_cents ?? null,
      stock: p.stock ?? null,
    }));

  return {
    id: wheel.id,
    title: wheel.title,
    subtitle: wheel.subtitle ?? undefined,
    brandColor: wheel.brand_color ?? "#ec4899",
    prizes,
  };
}
