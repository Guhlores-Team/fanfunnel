import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import { externalUrl } from "@/lib/format";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import type { Rarity, WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_COLORS, RARITY_ORDER } from "@/lib/games/wheel/types";
import type {
  AdminAccount,
  AdminOverview,
  AppRole,
  CohortRow,
  CreatorMetricsExtra,
  CreatorOverview,
  EngagementHeatmap,
  PrizeRoiRow,
  RedemptionItem,
  RedemptionStatus,
  ShareCardData,
  WishlistDemand,
  LeaderboardView,
  LeaderboardEntry,
  HappyHour,
  HappyHourStatus,
  ReferralOverview,
  SpinVerification,
} from "./types";
import { activeFans, bucketByDay, bucketCentsByDay, clampDays } from "./metrics";
import { provisionCreatorUser } from "./creatorAccount";
import {
  mockGetOverview,
  mockGetMetricsExtra,
  mockGetEngagementHeatmap,
  mockGetPrizeRoi,
  mockGetProfitSummary,
  mockGetCohortRetention,
  mockSetRedemptionStatus,
  mockSetRedemptionMeta,
  mockGetAdminOverview,
  mockUpdateAccount,
  mockCreateAccount,
  mockClearMyData,
  mockListHappyHours,
  mockCreateHappyHour,
  mockDeleteHappyHour,
  mockGetShareCard,
  mockAddWishlist,
  mockRemoveWishlist,
  mockGetWishlistDemand,
  mockSetLeaderboardEnabled,
  mockGetOnboardingDismissed,
  mockSetOnboardingDismissed,
  mockGetMyAccount,
  mockSetMyDisplayName,
  mockSetMyNotificationPrefs,
  mockSetActiveWheelBrandColor,
  mockSetFanLeaderboardOptIn,
  mockGetLeaderboard,
  mockGetRecentWins,
  mockGetReferralOverview,
  mockGetReferralStats,
  mockGetPublicWheelTeaser,
  mockGetSpinVerification,
} from "./mock";
import { REFERRAL_BONUS, REFERRAL_CAP, WHEEL_SELECT, toWheelConfig } from "./shared";
import type { DbWheelRow } from "./shared";
import { ensureWheelId, getActiveHappyHour, resolveActiveWheelId } from "./wheels";
import { getCreatorCrm, resolveFanByToken } from "./fans";

export type { FanPassView, SpinError } from "./shared";
export {
  getWheel,
  saveWheel,
  prizeRow,
  getWheelById,
  listWheels,
  createWheel,
  duplicateWheel,
  archiveWheel,
  unarchiveWheel,
  deleteWheel,
  setActiveWheel,
  setWheelSchedule,
} from "./wheels";
export { listWebhooks, createWebhook, deleteWebhook, fireWebhooks } from "./webhooks";
export { getFanPass, spin, completeClaimedSpin, createPass } from "./spins";
export {
  editGrant,
  grantSpins,
  listFans,
  getCreatorCrm,
  getFanDetail,
  deleteFan,
  setFanBlocked,
  reportCreator,
  selfExclude,
  updateFanMeta,
  ackFan,
} from "./fans";
export type { CrmFan, CreatorCrm } from "./fans";
export {
  createCampaign,
  listCampaigns,
  getCampaignStats,
  getUncategorizedStats,
  listCampaignPacks,
  createCampaignPack,
  updateCampaignPack,
  deleteCampaignPack,
  setCampaignPinnedWheel,
  renameCampaign,
  deleteCampaign,
} from "./campaigns";
export type { UncategorizedStats } from "./campaigns";
export {
  listDmTemplates,
  createDmTemplate,
  deleteDmTemplate,
  sendFanMessage,
  getFanMessages,
  listThreads,
  getThread,
  sendCreatorMessage,
  getChatSettings,
  setChatSettings,
  ensureChatIntro,
  sendChatOutro,
} from "./inbox";
export {
  listPrizeTemplates,
  createPrizeTemplate,
  deletePrizeTemplate,
  listWheelTemplates,
  createWheelTemplate,
  deleteWheelTemplate,
} from "./templates";

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
    "webhooks",
    "autopilot_dismissals",
  ];
  for (const t of tables) {
    const { error } = await sb.from(t).delete().eq("creator_id", user.id);
    if (error) return { error: `db_error:${t}` };
  }

  // A true fresh start also resets profile preferences (via the SECURITY
  // DEFINER self-update RPCs — profiles_update RLS is admin-only): the
  // Get-started checklist comes back, and the public leaderboard returns to
  // its off default instead of silently staying live from before the reset.
  // Best-effort: a pref that fails to reset shouldn't fail the whole wipe.
  await Promise.allSettled([
    sb.rpc("set_onboarding_dismissed", { p_dismissed: false }),
    sb.rpc("set_leaderboard_enabled", { p_enabled: false }),
    sb.rpc("set_chat_settings", { p_intro: "", p_outro: "" }),
  ]);
  return { ok: true };
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

  // These reads are all independent — run them concurrently instead of
  // awaiting one after another (this powers the 12s dashboard poll).
  const head = { count: "exact" as const, head: true };
  const [
    { data: reds },
    { count: fans },
    { count: spinsPlayed },
    { data: grantRows },
    { count: unreadMessages },
    { data: prof },
    { data: wheelRows },
    { count: pendingCount },
    { count: fulfilledCount },
    { data: oldestPendingRow },
  ] = await Promise.all([
    sb
      .from("redemptions")
      .select(
        `id, status, created_at, notes, due_at,
       spin:spins(prize_label, prize_rarity, fan:fans(display_name, handle))`
      )
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200),
    sb.from("fans").select("id", head).eq("creator_id", user.id),
    sb.from("spins").select("id", head).eq("creator_id", user.id),
    sb.from("grants").select("amount_cents").eq("creator_id", user.id),
    sb
      .from("messages")
      .select("id", head)
      .eq("creator_id", user.id)
      .eq("sender", "fan")
      .is("read_at", null),
    sb.from("profiles").select("leaderboard_enabled").eq("id", user.id).maybeSingle(),
    sb
      .from("wheels")
      .select("created_at, updated_at, archived_at")
      .eq("creator_id", user.id),
    // Count queries so pending/fulfilled headline totals are exact, not derived
    // from the display-capped (200-row) redemptions slice above.
    sb
      .from("redemptions")
      .select("id", head)
      .eq("creator_id", user.id)
      .eq("status", "pending"),
    sb
      .from("redemptions")
      .select("id", head)
      .eq("creator_id", user.id)
      .eq("status", "fulfilled"),
    // Oldest pending win, read directly: the redemptions slice above is capped
    // at the 200 NEWEST rows, so the oldest wait can fall outside it.
    sb
      .from("redemptions")
      .select("created_at")
      .eq("creator_id", user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

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

  const revenue = ((grantRows ?? []) as { amount_cents: number }[]).reduce(
    (s, g) => s + g.amount_cents,
    0
  );

  // "Built a wheel" = saved an edit (a wheel whose updated_at advanced past its
  // created_at) OR has more than the single bootstrap wheel. Content-agnostic,
  // so it catches every edit — not just the few fields a sample-diff compares.
  const activeWheels = (
    (wheelRows ?? []) as {
      created_at: string;
      updated_at: string;
      archived_at: string | null;
    }[]
  ).filter((w) => !w.archived_at);
  const wheelBuilt =
    activeWheels.length > 1 ||
    activeWheels.some(
      (w) => new Date(w.updated_at).getTime() - new Date(w.created_at).getTime() > 1500
    );

  return {
    metrics: {
      fans: fans ?? 0,
      spinsPlayed: spinsPlayed ?? 0,
      pending: pendingCount ?? 0,
      fulfilled: fulfilledCount ?? 0,
      revenue,
      unreadMessages: unreadMessages ?? 0,
      leaderboardEnabled: (prof as { leaderboard_enabled: boolean } | null)?.leaderboard_enabled ?? false,
      wheelBuilt,
      oldestPendingAt: (oldestPendingRow as { created_at: string } | null)?.created_at ?? null,
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
      activeFans: { thisWeek: 0, lastWeek: 0 },
    };
  }

  const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  // Weekly-active fans needs the last 14 days (this week + last week) of spins
  // with their fan, independent of the trend window.
  const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // All six reads are independent — run them concurrently (12s metrics poll).
  // Per-fan funnel: fans created → fans with ≥1 spin → fans with a fulfilled
  // prize. Counts distinct FANS (not links/spins).
  const head = { count: "exact" as const, head: true };
  const [
    { data: spinRows },
    { data: grantRows },
    { count: fans },
    { data: spunRows },
    { data: fulfilledRows },
    { data: recentSpinRows },
  ] = await Promise.all([
    sb.from("spins").select("created_at").eq("creator_id", user.id).gte("created_at", since),
    sb
      .from("grants")
      .select("created_at, amount_cents")
      .eq("creator_id", user.id)
      .gte("created_at", since),
    sb.from("fans").select("id", head).eq("creator_id", user.id),
    sb.from("spins").select("fan_id").eq("creator_id", user.id).not("fan_id", "is", null),
    sb
      .from("redemptions")
      .select("spin:spins(fan_id)")
      .eq("creator_id", user.id)
      .eq("status", "fulfilled"),
    sb
      .from("spins")
      .select("fan_id, created_at")
      .eq("creator_id", user.id)
      .not("fan_id", "is", null)
      .gte("created_at", since14),
  ]);

  const timestamps = ((spinRows ?? []) as { created_at: string }[]).map(
    (r) => r.created_at
  );
  const trend = bucketByDay(timestamps, n);

  const revenueTrend = bucketCentsByDay(
    ((grantRows ?? []) as { created_at: string; amount_cents: number }[]).map((r) => ({
      at: r.created_at,
      cents: r.amount_cents,
    })),
    n
  );

  const spun = new Set(
    ((spunRows ?? []) as { fan_id: string | null }[])
      .map((r) => r.fan_id)
      .filter((id): id is string => id !== null)
  ).size;

  // Fulfilled redemptions → distinct fans, joined through the spin.
  const fulfilled = new Set(
    ((fulfilledRows ?? []) as unknown as { spin: { fan_id: string | null } | null }[])
      .map((r) => r.spin?.fan_id)
      .filter((id): id is string => !!id)
  ).size;

  return {
    trend,
    funnel: { fans: fans ?? 0, spun, fulfilled },
    revenueTrend,
    activeFans: activeFans(
      ((recentSpinRows ?? []) as { fan_id: string | null; created_at: string }[])
        .filter((r): r is { fan_id: string; created_at: string } => r.fan_id !== null)
        .map((r) => ({ fanId: r.fan_id, at: r.created_at }))
    ),
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
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data, error } = await sb
    .from("redemptions")
    .update({
      status,
      fulfilled_at: status === "fulfilled" ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  return data ? { ok: true } : { error: "not_found" };
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

  const { data, error } = await sb
    .from("redemptions")
    .update(update)
    .eq("id", id)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  return data ? { ok: true } : { error: "not_found" };
}

// ---------------------------------------------------------------------------
// Admin (cross-account)
// ---------------------------------------------------------------------------

// Admin gate = the shared is_admin() predicate (role AND is_active) from
// src/lib/auth/adminCheck.ts. A suspended admin must NOT retain admin power;
// these gates front service-role actions that bypass RLS (create/delete
// accounts), so the check has to live here too — not only in RLS policies.

/** Whether the signed-in user is an admin. Server-only; used to gate admin-only
 *  UI such as the in-app debug console. Returns false in demo mode (no Supabase). */
export async function isCurrentUserAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const sb = await createClient();
  return isActiveAdmin(sb);
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
  const isOwner = !!org;
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
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

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
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

  // Service role is required to create a user without a sign-up flow.
  return provisionCreatorUser(createServiceClient(), email, password, displayName);
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
  if (!(await isActiveAdmin(sb))) return [];

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
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

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
  const SELECT =
    "prize_label, prize_rarity, server_seed, server_seed_hash, nonce, client_seed, created_at";
  let res = await sb
    .from("spins")
    .select(`${SELECT}, seed_commitment`)
    .eq("share_id", shareId)
    .maybeSingle();
  // Pre-0041 DB (no seed_commitment column yet): read the rest; the commitment
  // is then unknown, which the page states rather than claiming more.
  if (res.error) res = await sb.from("spins").select(SELECT).eq("share_id", shareId).maybeSingle();

  const row = res.data as {
    prize_label: string;
    prize_rarity: Rarity;
    server_seed: string | null;
    server_seed_hash: string | null;
    nonce: number | null;
    client_seed: string | null;
    created_at: string;
    seed_commitment?: string | null;
  } | null;
  if (!row || !row.server_seed || !row.server_seed_hash) return null;

  const hashOk = (await sha256Hex(row.server_seed)) === row.server_seed_hash;
  const c = row.seed_commitment;
  return {
    prizeLabel: row.prize_label,
    rarity: row.prize_rarity,
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    nonce: row.nonce ?? 0,
    hashOk,
    at: row.created_at,
    clientSeed: row.client_seed,
    commitment: c === "published" || c === "stored" || c === "fresh" ? c : null,
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

/** Whether the signed-in creator has dismissed the Get-started checklist. */
export async function getOnboardingDismissed(): Promise<boolean> {
  if (!isSupabaseConfigured()) return mockGetOnboardingDismissed();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return false;

  const { data } = await sb
    .from("profiles")
    .select("onboarding_dismissed")
    .eq("id", user.id)
    .maybeSingle();
  return (data as { onboarding_dismissed: boolean } | null)?.onboarding_dismissed ?? false;
}

/** Persist the creator's Get-started checklist dismissal (account, not browser). */
export async function setOnboardingDismissed(
  dismissed: boolean
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetOnboardingDismissed(dismissed);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.rpc("set_onboarding_dismissed", {
    p_dismissed: dismissed,
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
 * fans who EXPLICITLY opted in appear (spinning never opts anyone in), and only
 * their handle plus activity counts — never email/token/fan_id, and never spend.
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
    .select("id, handle")
    .eq("creator_id", creatorId)
    .eq("leaderboard_opt_in", true);
  const fans = (fanRows ?? []) as {
    id: string;
    handle: string | null;
  }[];
  if (fans.length === 0) return { enabled: true, creatorTitle, entries: [] };

  const fanIds = fans.map((f) => f.id);

  const { data: spinRows } = await sb
    .from("spins")
    .select("fan_id, prize_rarity")
    .in("fan_id", fanIds);
  const spins = (spinRows ?? []) as { fan_id: string; prize_rarity: Rarity }[];

  // Deliberately NOT reading `grants` here: per-fan spend must never reach this
  // public payload (see LeaderboardEntry in ./types).

  const spinCount = new Map<string, number>();
  const rareCount = new Map<string, number>();
  for (const s of spins) {
    spinCount.set(s.fan_id, (spinCount.get(s.fan_id) ?? 0) + 1);
    if (s.prize_rarity === "rare" || s.prize_rarity === "epic" || s.prize_rarity === "legendary") {
      rareCount.set(s.fan_id, (rareCount.get(s.fan_id) ?? 0) + 1);
    }
  }

  const entries: LeaderboardEntry[] = fans
    // A fan with no board handle is skipped, never shown under their real
    // name (display_name isn't even selected above).
    .filter((f): f is typeof f & { handle: string } => !!f.handle?.trim())
    .map((f) => ({
      handle: f.handle.trim(),
      spins: spinCount.get(f.id) ?? 0,
      rareWins: rareCount.get(f.id) ?? 0,
    }))
    // Ranked by activity (spins, then rare wins) — never by money spent.
    .sort((a, b) => b.spins - a.spins || b.rareWins - a.rareWins)
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
    .select("id, handle")
    .eq("creator_id", prof.id)
    .eq("leaderboard_opt_in", true);
  // Only fans with a board handle are surfaced; a real name is never read here.
  const fans = ((fanRows ?? []) as { id: string; handle: string | null }[]).filter(
    (f) => !!f.handle?.trim()
  );
  if (fans.length === 0) return [];
  const byId = new Map(fans.map((f) => [f.id, f.handle!.trim()]));

  const { data: spinRows } = await sb
    .from("spins")
    .select("fan_id, prize_label, prize_rarity, created_at")
    .in("fan_id", Array.from(byId.keys()))
    .in("prize_rarity", ["rare", "epic", "legendary"])
    .order("created_at", { ascending: false })
    .limit(20);

  return ((spinRows ?? []) as {
    fan_id: string;
    prize_label: string;
    prize_rarity: Rarity;
    created_at: string;
  }[]).flatMap((s) => {
    const handle = byId.get(s.fan_id);
    if (!handle) return [];
    return [{ handle, prizeLabel: s.prize_label, rarity: s.prize_rarity, at: s.created_at }];
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
  /** The creator's avatar — shown as the page's hero in place of the 🎡. */
  avatarUrl: string | null;
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
        avatarUrl: null,
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
    .select("id, display_name, public_tagline, tip_url, avatar_url")
    .eq("public_slug", slug)
    .maybeSingle();
  const p = prof as {
    id: string;
    display_name: string | null;
    public_tagline: string | null;
    tip_url: string | null;
    avatar_url: string | null;
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
      avatarUrl: p.avatar_url,
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

// Cap stored avatar URLs so a multi-KB string can't be persisted via the note RPC.
const MAX_AVATAR_URL_LEN = 2048;

/** Creator updates their SFW link-in-bio fields + fan-page personal note. */
/** The stored form of a public slug (the `/c/<slug>` path segment). */
export function normalizePublicSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function setMyPublicProfile(input: {
  slug?: string;
  tipUrl?: string;
  tagline?: string;
  note?: string;
  avatarUrl?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  // Atomic partial update: pass NULL for any field omitted from the request so
  // the RPC leaves that column unchanged (migration 0033). This replaces the
  // route's old read-modify-write, which raced concurrent partial updates
  // (TOCTOU) and could wipe an omitted note/avatar.
  if (input.slug !== undefined || input.tipUrl !== undefined || input.tagline !== undefined) {
    const slug = input.slug !== undefined ? normalizePublicSlug(input.slug) : null;
    const { error } = await sb.rpc("set_public_profile", {
      p_slug: slug,
      p_tip_url: input.tipUrl !== undefined ? externalUrl(input.tipUrl) : null,
      p_tagline: input.tagline !== undefined ? input.tagline : null,
    });
    if (error) return { error: "db_error" };
  }
  if (input.note !== undefined || input.avatarUrl !== undefined) {
    // Defense in depth: never persist an avatar URL with a non-http(s) scheme
    // (blocks data:/javascript:) or an oversized value, even if a caller skips
    // the validated upload path. An empty string clears the avatar; an omitted
    // avatar (null) leaves the current one unchanged.
    let avatar: string | null = null;
    if (input.avatarUrl !== undefined) {
      avatar = input.avatarUrl;
      if (avatar !== "") {
        if (avatar.length > MAX_AVATAR_URL_LEN) return { error: "invalid_avatar_url" };
        let protocol: string;
        try {
          protocol = new URL(avatar).protocol;
        } catch {
          return { error: "invalid_avatar_url" };
        }
        if (protocol !== "http:" && protocol !== "https:") {
          return { error: "invalid_avatar_url" };
        }
      }
    }
    const { error: noteError } = await sb.rpc("set_creator_note", {
      p_note: input.note !== undefined ? input.note : null,
      p_avatar: avatar,
    });
    if (noteError) return { error: "db_error" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Account settings (Phase 9 #6): display name, email, notification prefs.
// profiles_update is admin-only, so self-updates go through the narrow
// SECURITY DEFINER RPCs added in migration 0025 (set_display_name,
// set_notification_prefs) — same pattern as set_public_profile / set_creator_note.
// ---------------------------------------------------------------------------

export interface NotificationPrefs {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}

export interface MyAccount {
  email: string | null;
  displayName: string | null;
  notifications: NotificationPrefs;
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  newSpin: true,
  lowBalance: true,
  messages: true,
};

/** The signed-in creator's account settings (display name, email, notify prefs). */
export async function getMyAccount(): Promise<MyAccount> {
  if (!isSupabaseConfigured()) return mockGetMyAccount();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return { email: null, displayName: null, notifications: { ...DEFAULT_NOTIFICATION_PREFS } };
  }
  const { data } = await sb
    .from("profiles")
    .select("display_name, notify_new_spin, notify_low_balance, notify_messages")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as {
    display_name: string | null;
    notify_new_spin: boolean | null;
    notify_low_balance: boolean | null;
    notify_messages: boolean | null;
  } | null;
  return {
    email: user.email ?? null,
    displayName: row?.display_name ?? null,
    notifications: {
      newSpin: row?.notify_new_spin ?? true,
      lowBalance: row?.notify_low_balance ?? true,
      messages: row?.notify_messages ?? true,
    },
  };
}

/** Update only the creator's display name (self-update RPC). Blank is ignored. */
export async function setMyDisplayName(
  name: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetMyDisplayName(name);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.rpc("set_display_name", { p_name: name });
  return error ? { error: "db_error" } : { ok: true };
}

/** Update only the creator's notification preferences (self-update RPC). */
export async function setMyNotificationPrefs(
  prefs: NotificationPrefs
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetMyNotificationPrefs(prefs);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.rpc("set_notification_prefs", {
    p_new_spin: prefs.newSpin,
    p_low_balance: prefs.lowBalance,
    p_messages: prefs.messages,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Set the brand color of the creator's currently-active wheel. The public
 * /c/[slug] page derives its brand color from the active wheel, so this powers
 * the Settings → Public profile brand-color control (with a live preview).
 * wheels has a creator-scoped RW policy, so the auth client may write directly.
 */
export async function setActiveWheelBrandColor(
  color: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetActiveWheelBrandColor(color);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  await ensureWheelId(sb, user.id);
  const wheelId = await resolveActiveWheelId(sb, user.id, new Date());
  if (!wheelId) return { error: "no_wheel" };
  const { error } = await sb
    .from("wheels")
    .update({ brand_color: color, updated_at: new Date().toISOString() })
    .eq("id", wheelId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}
