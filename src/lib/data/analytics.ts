// Data layer — analytics: creator overview, deeper metrics (heatmap, prize
// ROI, profit, cohorts) and the Autopilot feed.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { Rarity } from "@/lib/games/wheel/types";
import type {
  CohortRow,
  CreatorMetricsExtra,
  CreatorOverview,
  EngagementHeatmap,
  PrizeRoiRow,
  RedemptionItem,
  RedemptionStatus,
} from "./types";
import { activeFans, bucketByDay, bucketCentsByDay, clampDays } from "./metrics";
import {
  mockGetOverview,
  mockGetMetricsExtra,
  mockGetEngagementHeatmap,
  mockGetPrizeRoi,
  mockGetProfitSummary,
  mockGetCohortRetention,
} from "./mock";
import { getCreatorCrm } from "./fans";
import { getWishlistDemand } from "./boosts";

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
