import assert from "node:assert/strict";
import { mock } from "node:test";
import type { AnyClient } from "./shared";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
const OWNER = "10000000-0000-4000-8000-000000000001", OTHER = "20000000-0000-4000-8000-000000000002";
const FAN = "30000000-0000-4000-8000-000000000003", QUIET = "40000000-0000-4000-8000-000000000004";
const NOW = Date.now(), HOUR = 3_600_000, DAY = 24 * HOUR;
const recent = new Date(NOW - HOUR).toISOString(), older = new Date(NOW - 8 * DAY).toISOString();
let signedIn = true, rowCap = 1000, failAfterCursorTable: string | null = null;
let pageHook: ((table: string, after: string | null) => void) | null = null;
const db: Record<string, Row[]> = {
  profiles: [{ id: OWNER, public_slug: "creator", display_name: "Creator", leaderboard_enabled: true }],
  fans: [
    { id: FAN, creator_id: OWNER, display_name: "PRIVATE NAME", handle: "alpha", leaderboard_opt_in: true, spins_remaining: 2, spins_granted_total: 3, tags: [], created_at: recent },
    { id: QUIET, creator_id: OWNER, display_name: "Other fan", handle: "beta", leaderboard_opt_in: true, spins_remaining: 1, spins_granted_total: 2, tags: [], created_at: older },
    { id: "foreign-fan", creator_id: OTHER, handle: "foreign", leaderboard_opt_in: true, created_at: recent },
  ],
  wheels: [{ id: "bingo-game", creator_id: OWNER, title: "Bingo", created_at: older, updated_at: recent, archived_at: null }],
  campaigns: [{ id: "campaign", creator_id: OWNER, name: "Launch", is_active: true, created_at: recent, pinned_wheel_id: null }],
  fan_passes: [{ id: "pass", creator_id: OWNER, fan_id: FAN, token: "PRIVATE TOKEN", created_at: recent, is_active: true, spins_remaining: 2, wheel_id: "bingo-game" }],
  grants: [
    { id: "paid-deposit", creator_id: OWNER, fan_id: FAN, fan_pass_id: "pass", campaign_id: "campaign", spins: 3, bonus_spins: 0, amount_cents: 1000, created_at: recent },
    { id: "old-deposit", creator_id: OWNER, fan_id: QUIET, campaign_id: null, spins: 2, amount_cents: 500, created_at: older },
    { id: "foreign-deposit", creator_id: OTHER, fan_id: "foreign-fan", campaign_id: "campaign", spins: 900, amount_cents: 999999, created_at: recent },
  ],
  spins: [
    { id: "primary", creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "play", game_kind: "bingo", prize_id: "p-sticker", prize_label: "Sticker", prize_rarity: "common", created_at: recent },
    { id: "bonus-0", creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "bonus", game_kind: "bingo", parent_spin_id: "primary", bingo_line: 1, prize_id: "p-bonus", prize_label: "Bonus", prize_rarity: "rare", created_at: recent },
    { id: "bonus-1", creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "bonus", game_kind: "bingo", parent_spin_id: "primary", bingo_line: 4, prize_id: "p-video", prize_label: "Video", prize_rarity: "epic", created_at: recent },
    { id: "bonus-2", creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "bonus", game_kind: "bingo", parent_spin_id: "primary", bingo_line: 6, prize_id: "p-bonus", prize_label: "Bonus", prize_rarity: "rare", created_at: recent },
    { id: "old-play", creator_id: OWNER, fan_id: QUIET, campaign_id: null, kind: "play", game_kind: "scratch", prize_id: "p-sticker", prize_label: "Sticker", prize_rarity: "common", created_at: older },
    { id: "foreign-win", creator_id: OTHER, fan_id: "foreign-fan", campaign_id: "campaign", kind: "bonus", game_kind: "bingo", prize_id: "foreign-prize", prize_label: "Foreign prize", prize_rarity: "legendary", created_at: recent },
  ],
  redemptions: [
    { id: "r-primary", creator_id: OWNER, spin_id: "primary", status: "pending", created_at: recent },
    { id: "r-bonus-0", creator_id: OWNER, spin_id: "bonus-0", status: "fulfilled", created_at: recent },
    { id: "r-bonus-1", creator_id: OWNER, spin_id: "bonus-1", status: "pending", created_at: recent },
    { id: "r-bonus-2", creator_id: OWNER, spin_id: "bonus-2", status: "pending", created_at: recent },
    { id: "r-old", creator_id: OWNER, spin_id: "old-play", status: "fulfilled", created_at: older },
    { id: "r-foreign", creator_id: OTHER, spin_id: "foreign-win", status: "fulfilled", created_at: recent },
  ],
  prizes: [
    { id: "p-sticker", wheel_id: "bingo-game", label: "Sticker", rarity: "common", cost_cents: 100, created_at: older },
    { id: "p-bonus", wheel_id: "bingo-game", label: "Bonus", rarity: "rare", cost_cents: 200, created_at: older },
    { id: "p-video", wheel_id: "bingo-game", label: "Video", rarity: "epic", cost_cents: 300, created_at: older },
  ],
};
const reads: { table: string; filters: string[] }[] = [];
function columns(text: string): string[] {
  const out: string[] = []; let depth = 0, start = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "(") depth++;
    else if (text[at] === ")") depth--;
    else if (text[at] === "," && !depth) { out.push(text.slice(start, at).trim()); start = at + 1; }
  }
  out.push(text.slice(start).trim()); return out.filter(Boolean);
}
function expanded(table: string, row: Row, selection: string): Row {
  const out = { ...row };
  for (const part of columns(selection)) {
    const match = /^(?:(\w+):)?(\w+)(?:!inner)?\((.*)\)$/.exec(part);
    if (!match) continue;
    const [, alias, target, nested] = match, key = alias ?? target;
    const foreignKey = target === "spins" ? "spin_id" : `${target.replace(/s$/, "")}_id`;
    const one = row[foreignKey] !== undefined;
    const matches = (db[target] ?? []).filter(candidate => one ? candidate.id === row[foreignKey] : candidate[`${table.replace(/s$/, "")}_id`] === row.id);
    out[key] = one ? matches[0] ? project(target, matches[0], nested) : null : matches.map(item => project(target, item, nested));
  }
  return out;
}
function project(table: string, row: Row, selection: string): Row {
  const full = expanded(table, row, selection), out: Row = {};
  for (const part of columns(selection)) {
    const key = part.includes("(") ? part.split(/[:(]/)[0] : part;
    if (key === "*") Object.assign(out, full); else out[key] = full[key];
  }
  return out;
}
const value = (row: Row, key: string): unknown => key.split(".").reduce<unknown>((current, field) => current && typeof current === "object" ? (current as Row)[field] : undefined, row);
function from(table: string) {
  const filters: Filter[] = [], descriptions: string[] = [], orders: { field: string; ascending: boolean }[] = [];
  let after: string | null = null;
  let selection = "*", head = false, count = false, mode = "many", limit: number | null = null, range: [number, number] | null = null;
  const query = {
    select(text: string, options?: { head?: boolean; count?: string }) { selection = text; head = !!options?.head; count = options?.count === "exact"; return query; },
    eq(field: string, expected: unknown) { descriptions.push(`${field}=${expected}`); filters.push(row => value(row, field) === expected); return query; },
    is(field: string, expected: unknown) { filters.push(row => (value(row, field) ?? null) === expected); return query; },
    not(field: string, operator: string, expected: unknown) { assert.equal(operator, "is"); filters.push(row => (value(row, field) ?? null) !== expected); return query; },
    in(field: string, expected: unknown[]) { filters.push(row => expected.includes(value(row, field))); return query; },
    gt(field: string, expected: string) { if (field === "id") after = expected; descriptions.push(`${field}>${expected}`); filters.push(row => String(value(row, field)) > expected); return query; },
    lte(field: string, expected: string) { filters.push(row => String(value(row, field)) <= expected); return query; },
    gte(field: string, expected: string) { filters.push(row => String(value(row, field)) >= expected); return query; },
    order(field: string, options?: { ascending?: boolean }) { orders.push({ field, ascending: options?.ascending !== false }); return query; },
    limit(size: number) { limit = size; return query; },
    range(start: number, end: number) { range = [start, end]; return query; },
    maybeSingle() { mode = "single"; return query; },
    then(resolve: (result: { data: unknown; count: number | null; error: unknown }) => unknown, reject?: (error: unknown) => unknown) {
      return Promise.resolve().then(() => {
        reads.push({ table, filters: [...descriptions] });
        pageHook?.(table, after);
        if (after !== null && failAfterCursorTable === table) return { data: null, count: null, error: { message: "PRIVATE DATABASE DIAGNOSTIC" } };
        let rows = (db[table] ?? []).map(row => expanded(table, row, selection)).filter(row => filters.every(filter => filter(row)));
        const total = rows.length;
        rows.sort((a, b) => { for (const order of orders) { const x = String(value(a, order.field)), y = String(value(b, order.field)); if (x !== y) return (x < y ? -1 : 1) * (order.ascending ? 1 : -1); } return 0; });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit !== null) rows = rows.slice(0, limit);
        if (!head) rows = rows.slice(0, rowCap);
        const result = rows.map(row => project(table, row, selection));
        return { data: head ? null : mode === "single" ? result[0] ?? null : result, count: count ? total : null, error: null };
      }).then(resolve, reject);
    },
  };
  return query;
}
const client = { from, auth: { getUser: async () => ({ data: { user: signedIn ? { id: OWNER } : null }, error: null }) }, rpc: () => { throw new Error("Read queries must not issue economic RPCs"); } };
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => client, createServiceClient: () => client } });
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
async function main() {
  const analytics = await import("./analytics"), { getFanDetail } = await import("./fans"), { getUncategorizedStats } = await import("./campaigns");
  const { readPlayCounts } = await import("./playGuard"), { campaignStatsFor } = await import("./campaignStats"), { getLeaderboard, getRecentWins } = await import("./boosts");
  const overview = await analytics.getOverview();
  check("headline and per-game counts include two paid plays, never three extra bonuses", overview.metrics.spinsPlayed === 2 && overview.gamePlays?.bingo === 1 && overview.gamePlays.scratch === 1 && overview.gamePlays.wheel === 0);
  check("all primary and bonus rewards remain in the fulfilment totals", overview.metrics.pending === 3 && overview.metrics.fulfilled === 2 && overview.redemptions.length === 5);
  check("bonus rows never invent deposits or revenue", overview.metrics.revenue === 1500 && db.grants.filter(row => row.creator_id === OWNER).length === 2);
  const extra = await analytics.getMetricsExtra(1);
  check("one-day engagement trend counts the single paid play", extra.trend.reduce((sum, day) => sum + day.spins, 0) === 1);
  check("conversion and weekly activity count distinct paid-play fans", extra.funnel.spun === 2 && extra.funnel.fulfilled === 2 && extra.activeFans.thisWeek === 1 && extra.activeFans.lastWeek === 1);
  const heatmap = await analytics.getEngagementHeatmap(1);
  check("heatmap excludes line bonuses while retaining the date window", heatmap.cells.reduce((sum, cell) => sum + cell.count, 0) === 1 && heatmap.max === 1);
  const play = await readPlayCounts(client as unknown as AnyClient, FAN, NOW);
  check("fan rolling daily/weekly reminders count one paid attempt", play.today === 1 && play.week === 1);
  const roi = await analytics.getPrizeRoi(1), profit = await analytics.getProfitSummary(1);
  check("ROI retains all real bonus prizes and their fulfilment costs", roi.length === 3 && roi.reduce((sum, prize) => sum + prize.timesWon, 0) === 4 && roi.reduce((sum, prize) => sum + prize.totalCostCents, 0) === 800);
  check("profit includes all prize costs with the original deposit exactly once", profit.revenueCents === 1000 && profit.costCents === 800 && profit.profitCents === 200 && profit.costsComplete);
  db.prizes.find(row => row.id === "p-video")!.cost_cents = null;
  const unknown = await analytics.getProfitSummary(1);
  check("unknown bonus cost remains visibly incomplete, never silently zero-complete", unknown.costCents === 500 && unknown.costsComplete === false);
  db.prizes.find(row => row.id === "p-video")!.cost_cents = 300;
  const stats = await campaignStatsFor(client as never, OWNER, 2);
  check("paged mixed campaign rows retain one paid play and four real rewards", stats.length === 1 && stats[0].spinsPlayed === 1 && stats[0].fulfilled === 1 && stats[0].pending === 3);
  check("campaign conversion/revenue use only purchased credits and one paid attempt", stats[0].spinsBought === 3 && stats[0].revenue === 1000 && stats[0].playThroughPct === 1 / 3);
  check("campaign prize distribution still sees bonus awards", stats[0].topPrize?.label === "Bonus" && stats[0].topPrize.count === 2);
  const uncategorized = await getUncategorizedStats();
  check("uncategorized paid count and deposit totals remain independent of bonuses", uncategorized.spinsPlayed === 1 && uncategorized.spinsBought === 2 && uncategorized.revenue === 500);
  const detail = await getFanDetail(FAN); assert.ok(detail);
  check("fan detail counts one paid play and retains all four won prizes", detail.totalSpins === 1 && detail.winsByRarity.reduce((sum, item) => sum + item.count, 0) === 4 && detail.pendingPrizes.length === 3);
  check("fan campaign splits paid activity from its full reward distribution", detail.byCampaign[0].spinsPlayed === 1 && detail.byCampaign[0].prizes.reduce((sum, item) => sum + item.count, 0) === 4 && detail.byCampaign[0].spentCents === 1000);
  check("fan credits and grant totals do not grow with line bonuses", detail.spinsRemaining === 2 && detail.grantedTotal === 3 && detail.grants.length === 1 && detail.totalSpent === 1000);
  const board = await getLeaderboard(OWNER), alpha = board.entries.find(row => row.handle === "alpha");
  check("public activity count excludes bonuses but rare wins include all real awards", alpha?.spins === 1 && alpha.rareWins === 3);
  check("public leaderboard remains opt-in, tenant scoped and without personal or financial fields", board.entries.length === 2 && !/PRIVATE|foreign|token|amount|revenue|fanId/i.test(JSON.stringify(board)));
  const recentWins = await getRecentWins(OWNER);
  check("public recent-win feed retains all consented bonus rewards", recentWins.length === 3 && recentWins.every(win => win.handle === "alpha"));
  const profile = db.profiles[0]; profile.leaderboard_enabled = false;
  check("creator consent switch still suppresses public board and bonus feed", (await getLeaderboard(OWNER)).entries.length === 0 && (await getRecentWins(OWNER)).length === 0);
  profile.leaderboard_enabled = true;
  // One deposit funds each extra primary. Line bonuses add rewards/costs,
  // never another credit or deposit. Every financial source crosses 2,001 rows.
  const bulk = 2101;
  for (let index = 0; index < bulk; index++) {
    const key = String(index).padStart(5, "0");
    db.grants.push({ id: `bulk-g-${key}`, creator_id: OWNER, fan_id: FAN, fan_pass_id: "pass", campaign_id: "campaign", spins: 1, bonus_spins: 0, amount_cents: 100, created_at: recent });
    db.spins.push({ id: `bulk-p-${key}`, creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "play", game_kind: "bingo", prize_id: "p-sticker", prize_label: "Sticker", prize_rarity: "common", created_at: recent });
    db.spins.push({ id: `bulk-b-${key}`, creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "bonus", game_kind: "bingo", parent_spin_id: `bulk-p-${key}`, bingo_line: 1, prize_id: "p-bonus", prize_label: "Bonus", prize_rarity: "rare", created_at: recent });
    db.redemptions.push({ id: `bulk-rp-${key}`, creator_id: OWNER, spin_id: `bulk-p-${key}`, status: "pending", created_at: recent });
    db.redemptions.push({ id: `bulk-rb-${key}`, creator_id: OWNER, spin_id: `bulk-b-${key}`, status: "fulfilled", created_at: recent });
  }
  db.fans.find(row => row.id === FAN)!.spins_granted_total = bulk + 3;
  const largeProfit = await analytics.getProfitSummary(1);
  check(`more than2,001 deposits and mixed awards: revenue=${largeProfit.revenueCents}, cost=${largeProfit.costCents}`, largeProfit.revenueCents === 1000 + bulk * 100 && largeProfit.costCents === 800 + bulk * 300 && largeProfit.profitCents === -420000);
  check("a fully read report explicitly identifies its complete dataset", largeProfit.dataStatus === "complete");
  const largeRoi = await analytics.getPrizeRoi(1);
  check("prize ROI reads every primary and bonus beyond the server cap", largeRoi.reduce((sum, row) => sum + row.timesWon, 0) === 4 + 2 * bulk && largeRoi.reduce((sum, row) => sum + row.totalCostCents, 0) === 800 + bulk * 300);
  const largeDetail = await getFanDetail(FAN); assert.ok(largeDetail);
  check("fan detail keeps full grants and reward history with one balance debit per primary", largeDetail.grants.length === bulk + 1 && largeDetail.totalSpent === 1000 + bulk * 100 && largeDetail.totalSpins === bulk + 1 && largeDetail.pendingPrizes.length === bulk + 3 && largeDetail.spinsRemaining === 2);
  const largeCampaign = await campaignStatsFor(client as never, OWNER);
  check("large campaign pending is all rewards minus fulfilled, never paid plays minus fulfilled", largeCampaign[0].spinsPlayed === bulk + 1 && largeCampaign[0].fulfilled === bulk + 1 && largeCampaign[0].pending === bulk + 3);
  const { listFans } = await import("./fans");
  const allFans = await listFans();
  check("Fans/CRM LTV is aggregated from all grants rather than a capped embed", allFans.find(row => row.fanId === FAN)?.totalSpent === 1000 + bulk * 100);
  const largeOverview = await analytics.getOverview();
  check("overview exact headlines and complete revenue remain independent of its200row display slice", largeOverview.metrics.spinsPlayed === bulk + 2 && largeOverview.metrics.revenue === 1500 + bulk * 100 && largeOverview.metrics.pending === bulk + 3 && largeOverview.redemptions.length === 200);
  // A lower hosted row cap must cause another keyset page, not a false last page.
  rowCap = 137;
  const cappedProfit = await analytics.getProfitSummary(1);
  check("a server cap below the requested page size still returns complete costs and revenue", cappedProfit.revenueCents === largeProfit.revenueCents && cappedProfit.costCents === largeProfit.costCents);
  rowCap = 1000;
  let injected = false;
  pageHook = (table, after) => {
    if (table !== "spins" || after === null || injected) return;
    injected = true;
    const later = new Date(Date.now() + DAY).toISOString();
    db.grants.push({ id: "zz-concurrent-deposit", creator_id: OWNER, fan_id: FAN, spins: 1, amount_cents: 100, created_at: later });
    db.spins.push({ id: "zz-concurrent-primary", creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "play", game_kind: "bingo", prize_id: "p-sticker", prize_label: "Sticker", prize_rarity: "common", created_at: later });
    db.spins.push({ id: "zz-concurrent-future", creator_id: OWNER, fan_id: FAN, campaign_id: "campaign", kind: "bonus", game_kind: "bingo", parent_spin_id: "zz-concurrent-primary", bingo_line: 1, prize_id: "future-prize", prize_label: "Future unknown prize", prize_rarity: "rare", created_at: later });
  };
  const concurrent = await analytics.getProfitSummary(1);
  pageHook = null;
  check("fixed cutoff excludes a concurrent later award without shifting existing pages", injected && concurrent.costCents === largeProfit.costCents && concurrent.costsComplete);
  const edgeStart = new Date(NOW - DAY).toISOString(), edgePast = new Date(NOW - DAY - 1).toISOString(), edgeFuture = new Date(NOW + 1).toISOString();
  for (const [id, at, amount] of [["edge-start", edgeStart, 111], ["edge-past", edgePast, 999999], ["edge-future", edgeFuture, 999999]] as const) {
    db.grants.push({ id, creator_id: OWNER, fan_id: FAN, spins: 1, amount_cents: amount, created_at: at });
    db.spins.push({ id, creator_id: OWNER, fan_id: FAN, kind: "play", game_kind: "bingo", prize_id: "p-sticker", prize_label: "Sticker", prize_rarity: "common", created_at: at });
  }
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const edges = await analytics.getProfitSummary(1);
  mock.timers.reset();
  check("fixed report window includes its exact lower boundary and excludes older/future deposits", edges.revenueCents === largeProfit.revenueCents + 111);
  check("award cost uses the identical inclusive cutoff window", edges.costCents === largeProfit.costCents + 100);
  db.grants = db.grants.filter(row => !String(row.id).startsWith("edge-"));
  db.spins = db.spins.filter(row => !String(row.id).startsWith("edge-"));
  const { GET: profitRoute } = await import("@/app/api/analytics/profit/route"), { GET: roiRoute } = await import("@/app/api/analytics/roi/route"), { GET: fanRoute } = await import("@/app/api/fans/[fanId]/route");
  failAfterCursorTable = "spins";
  let failed = await profitRoute(new Request("http://localhost/api/analytics/profit?days=1")), failure = await failed.json();
  check("mid-page cost failure returns controlled503 without a partial financial summary", failed.status === 503 && failure.dataStatus === "unavailable" && failure.error === "data_unavailable" && !failure.summary && failed.headers.get("cache-control") === "no-store");
  failed = await roiRoute(new Request("http://localhost/api/analytics/roi?days=1")); failure = await failed.json();
  check("mid-page ROI failure never publishes a truncated array as complete", failed.status === 503 && !failure.rows && failure.dataStatus === "unavailable");
  failAfterCursorTable = "grants";
  failed = await profitRoute(new Request("http://localhost/api/analytics/profit?days=1")); failure = await failed.json();
  check("mid-page revenue failure never publishes an understated deposit total", failed.status === 503 && !failure.summary && !JSON.stringify(failure).includes("PRIVATE"));
  failed = await fanRoute(new Request("http://localhost/api/fans/test"), { params: Promise.resolve({ fanId: FAN }) }); failure = await failed.json();
  check("mid-page fan grant failure cannot masquerade as a complete detail or missing fan", failed.status === 503 && !failure.grants && failure.error === "data_unavailable");
  failAfterCursorTable = null;
  // Financial identity is the prize ID, even when labels collide or change.
  const originalFinancialTables = { prizes: db.prizes, wheels: db.wheels, grants: db.grants, spins: db.spins };
  const cheapId = "identity-cheap", costlyId = "identity-costly";
  db.wheels = [{ id: "identity-game", creator_id: OWNER, created_at: older }, { id: "foreign-game", creator_id: OTHER, created_at: older }];
  db.prizes = [{ id: cheapId, wheel_id: "identity-game", label: "Gift", rarity: "common", cost_cents: 1000, created_at: older }, { id: costlyId, wheel_id: "identity-game", label: "Gift", rarity: "rare", cost_cents: 5000, created_at: older }];
  db.grants = [{ id: "identity-deposit", creator_id: OWNER, fan_id: FAN, spins: 2, amount_cents: 20000, created_at: recent }];
  db.spins = [{ id: "identity-primary", creator_id: OWNER, fan_id: FAN, wheel_id: "identity-game", kind: "play", game_kind: "bingo", prize_id: cheapId, prize_label: "Gift", prize_rarity: "common", created_at: recent }, { id: "identity-bonus", creator_id: OWNER, fan_id: FAN, wheel_id: "identity-game", kind: "bonus", game_kind: "bingo", parent_spin_id: "identity-primary", bingo_line: 1, prize_id: costlyId, prize_label: "Gift", prize_rarity: "rare", created_at: recent }];
  let identityProfit = await analytics.getProfitSummary(1), identityRoi = await analytics.getPrizeRoi(1);
  check("same-label prizes retain their distinct1000/5000costs and unchanged deposit", identityProfit.costCents === 6000 && identityProfit.profitCents === 14000 && identityProfit.revenueCents === 20000 && identityProfit.costsComplete);
  check("ROI separates same-label IDs instead of showing an arbitrary shared unit cost", identityRoi.length === 2 && new Set(identityRoi.map(row => row.prizeId)).size === 2 && identityRoi.find(row => row.prizeId === cheapId)?.costCents === 1000 && identityRoi.find(row => row.prizeId === costlyId)?.costCents === 5000 && identityRoi.reduce((sum, row) => sum + row.totalCostCents, 0) === 6000);
  check("complete dataset/current-cost estimate never claims an immutable historical cost snapshot", identityProfit.costBasis === "current_prize_cost" && identityProfit.historicalCostsKnown === false && identityRoi.every(row => row.costBasis === "current_prize_cost" && row.historicalCostsKnown === false));
  db.prizes[0].label = "Renamed gift";
  identityProfit = await analytics.getProfitSummary(1); identityRoi = await analytics.getPrizeRoi(1);
  check("renaming a prize keeps old awarded labels bound to their original ID/cost", identityProfit.costCents === 6000 && identityProfit.costsComplete && identityRoi.find(row => row.prizeId === cheapId)?.label === "Renamed gift");
  db.prizes[0].cost_cents = 1200;
  identityProfit = await analytics.getProfitSummary(1);
  check("editing current cost updates only the explicitly labelled current estimate", identityProfit.costCents === 6200 && identityProfit.costBasis === "current_prize_cost" && identityProfit.historicalCostsKnown === false);
  db.prizes = db.prizes.filter(row => row.id !== cheapId);
  db.spins.find(row => row.id === "identity-primary")!.prize_id = null;
  identityProfit = await analytics.getProfitSummary(1); identityRoi = await analytics.getPrizeRoi(1);
  check("deleted NULL prize reference cannot borrow a surviving same-label cost", identityProfit.costCents === 5000 && identityProfit.costsComplete === false && identityProfit.profitCents === 15000);
  check("deleted ROI award remains counted with unknown cost", identityRoi.find(row => row.prizeId === null)?.timesWon === 1 && identityRoi.find(row => row.prizeId === null)?.costCents === null);
  db.spins.find(row => row.id === "identity-primary")!.prize_id = "unresolved-original-id";
  identityProfit = await analytics.getProfitSummary(1); identityRoi = await analytics.getPrizeRoi(1);
  check("unresolved nonnull ID also stays unknown without label fallback", identityProfit.costCents === 5000 && identityProfit.costsComplete === false && identityRoi.find(row => row.prizeId === "unresolved-original-id")?.costCents === null);
  db.prizes.push({ id: "foreign-prize", wheel_id: "foreign-game", label: "Gift", rarity: "common", cost_cents: 999999, created_at: older });
  db.spins.find(row => row.id === "identity-primary")!.prize_id = "foreign-prize";
  identityProfit = await analytics.getProfitSummary(1);
  check("unmatched award never reads another creator's prize cost by ID or label", identityProfit.costCents === 5000 && identityProfit.costsComplete === false);
  db.prizes.push({ id: cheapId, wheel_id: "identity-game", label: "Gift", rarity: "common", cost_cents: 0, created_at: older });
  db.spins.find(row => row.id === "identity-primary")!.prize_id = cheapId;
  identityProfit = await analytics.getProfitSummary(1); identityRoi = await analytics.getPrizeRoi(1);
  check("a real zero current cost remains known rather than being confused with missing metadata", identityProfit.costCents === 5000 && identityProfit.costsComplete && identityRoi.find(row => row.prizeId === cheapId)?.costCents === 0);
  db.prizes.find(row => row.id === cheapId)!.cost_cents = null;
  identityProfit = await analytics.getProfitSummary(1);
  check("a NULL current cost remains incomplete even when its ID is resolved", identityProfit.costCents === 5000 && identityProfit.costsComplete === false);
  db.prizes.find(row => row.id === cheapId)!.cost_cents = -100;
  identityProfit = await analytics.getProfitSummary(1);
  check("invalid legacy negative cost never creates fictitious profit or completeness", identityProfit.costCents === 5000 && identityProfit.costsComplete === false);
  db.prizes.find(row => row.id === cheapId)!.cost_cents = 1000;
  db.spins.push({ id: "identity-renamed-history", creator_id: OWNER, fan_id: FAN, wheel_id: "identity-game", kind: "play", game_kind: "bingo", prize_id: cheapId, prize_label: "Older historical title", prize_rarity: "common", created_at: recent });
  identityRoi = await analytics.getPrizeRoi(1);
  check("multiple historical labels for one ID aggregate once under that ID", identityRoi.length === 2 && identityRoi.find(row => row.prizeId === cheapId)?.timesWon === 2 && identityRoi.find(row => row.prizeId === cheapId)?.totalCostCents === 2000);
  Object.assign(db, originalFinancialTables);
  signedIn = false; const noAuth = await analytics.getOverview();
  check("signed-out creator overview never leaks aggregate or reward rows", noAuth.metrics.spinsPlayed === 0 && noAuth.redemptions.length === 0);
  check("all observed operations are reads, with exact scoped primary game counts", reads.filter(read => read.table === "spins" && read.filters.includes("kind=play")).length >= 8);
  console.log(`Bingo primary/bonus read queries: ${checks} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
