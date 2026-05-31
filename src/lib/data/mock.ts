import { pickPrize } from "@/lib/games/wheel/engine";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import { RARITY_COLORS, type Rarity, type WheelConfig } from "@/lib/games/wheel/types";
import { defaultFeatures } from "@/lib/features";
import type {
  AdminAccount,
  AdminOverview,
  Campaign,
  CampaignStats,
  CreatorMetricsExtra,
  CreatorOverview,
  FanAccountSummary,
  FanCampaignBreakdown,
  FanDetail,
  FanPassView,
  Grant,
  RedemptionItem,
  RedemptionStatus,
  WonPrize,
} from "./types";
import { bucketByDay, bucketCentsByDay, clampDays } from "./metrics";

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

// A win record carries the FIFO-attributed campaign for the spin that won it.
interface MockWin extends WonPrize {
  campaignId: string | null;
}

interface MockFan {
  id: string;
  name: string;
  spinsRemaining: number;
  spinsGrantedTotal: number; // tracked independently of remaining
  primaryToken: string;
  wins: MockWin[];
}

// A single grant (new fan creation OR a top-up), tagged to a campaign.
interface MockGrant {
  id: string;
  fanId: string;
  campaignId: string | null;
  spins: number;
  amountCents: number;
  at: string;
}

// Redemptions in the mock carry the fan + FIFO campaign so stats can be exact.
interface MockRedemption extends RedemptionItem {
  fanId: string;
  campaignId: string | null;
}

interface Store {
  wheel: WheelConfig; // the creator's editable wheel
  fans: Map<string, MockFan>; // fanId -> fan
  tokens: Map<string, string>; // token -> fanId
  redemptions: MockRedemption[]; // creator-wide fulfilment queue (newest first)
  accounts: AdminAccount[]; // demo creator/admin accounts for the admin panel
  campaigns: Campaign[]; // creator's campaigns (newest first)
  tokenCampaign: Map<string, string>; // token -> campaignId
  grants: MockGrant[]; // every grant ever made (oldest first per fan via push order)
}

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

// Pin to globalThis so the store is shared across every Next.js entry point
// (pages and route handlers are bundled separately).
const g = globalThis as unknown as { __ffStore?: Store };
const store: Store =
  g.__ffStore ??
  (g.__ffStore = {
    wheel: structuredClone(SAMPLE_WHEEL),
    fans: new Map(),
    tokens: new Map(),
    redemptions: [],
    accounts: seedAccounts(),
    campaigns: [],
    tokenCampaign: new Map(),
    grants: [],
  });

// A store pinned by an older dev-server build may predate these fields, so
// backfill them defensively rather than crashing on the new code paths.
store.campaigns ??= [];
store.tokenCampaign ??= new Map();
store.grants ??= [];

if (!store.fans.has("demo-fan")) {
  const demoSpins = 5;
  store.fans.set("demo-fan", {
    id: "demo-fan",
    name: "Demo Fan",
    spinsRemaining: demoSpins,
    spinsGrantedTotal: demoSpins,
    primaryToken: "demo",
    wins: [],
  });
  store.tokens.set("demo", "demo-fan");
  // Seed a grant so revenue/per-campaign data is coherent in demo mode.
  store.grants.push({
    id: "g-demo",
    fanId: "demo-fan",
    campaignId: null,
    spins: demoSpins,
    amountCents: 0,
    at: new Date().toISOString(),
  });
}

function fanForToken(token: string): MockFan | null {
  const fanId = store.tokens.get(token);
  return fanId ? store.fans.get(fanId) ?? null : null;
}

// A fan's grants, oldest→newest (push order is creation order in the mock).
function fanGrants(fanId: string): MockGrant[] {
  return store.grants.filter((g) => g.fanId === fanId);
}

/**
 * FIFO-attribute the spin at 0-based index `playedBefore` to a campaign. Walk
 * the fan's grants oldest→newest, accumulating spins; the grant whose
 * cumulative range covers the index owns the spin. Returns null if the index
 * lies beyond every grant (i.e. an unfunded spin).
 */
function fifoCampaignForSpin(fanId: string, playedBefore: number): string | null {
  let cumulative = 0;
  for (const g of fanGrants(fanId)) {
    cumulative += g.spins;
    if (playedBefore < cumulative) return g.campaignId;
  }
  return null;
}

export function mockGetWheel(): WheelConfig {
  return structuredClone(store.wheel);
}

export function mockSaveWheel(config: WheelConfig): WheelConfig {
  // Preserve the stable wheel id; everything else is editable.
  store.wheel = { ...structuredClone(config), id: store.wheel.id };
  return structuredClone(store.wheel);
}

export function mockGetFanPass(token: string): FanPassView | null {
  const fan = fanForToken(token);
  if (!fan) return null;
  return structuredClone({
    token,
    fanName: fan.name,
    creatorTitle: CREATOR_TITLE,
    wheel: store.wheel,
    spinsRemaining: fan.spinsRemaining,
    recentWins: fan.wins,
  });
}

export function mockSpin(token: string) {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" as const };
  if (fan.spinsRemaining <= 0) return { error: "no_spins" as const };

  const { prize, index } = pickPrize(store.wheel);

  // FIFO-attribute THIS spin to a campaign: the 0-based index of this spin
  // among all the fan has played is the count played before it. Walk the fan's
  // grants oldest→newest, building cumulative spin ranges, and find the grant
  // whose range covers that index (null if beyond every grant).
  const playedBefore = fan.wins.length;
  const campaignId = fifoCampaignForSpin(fan.id, playedBefore);

  fan.spinsRemaining -= 1;

  // Decrement limited stock on the shared wheel so rare prizes can sell out.
  const live = store.wheel.prizes[index];
  if (typeof live.stock === "number") live.stock -= 1;

  // Record the win on the fan account (persists across all their links).
  const at = new Date().toISOString();
  fan.wins = [
    {
      label: prize.label,
      rarity: prize.rarity,
      emoji: prize.emoji,
      color: prize.color ?? RARITY_COLORS[prize.rarity],
      at,
      campaignId,
    },
    ...fan.wins,
  ].slice(0, 50);

  // Add it to the creator's fulfilment queue (with fan + campaign attribution).
  store.redemptions.unshift({
    id: "r-" + Math.random().toString(36).slice(2, 10),
    fanName: fan.name,
    prizeLabel: prize.label,
    rarity: prize.rarity,
    emoji: prize.emoji,
    status: "pending",
    at,
    fanId: fan.id,
    campaignId,
  });

  return {
    prize: structuredClone(prize),
    prizeIndex: index,
    spinsRemaining: fan.spinsRemaining,
  };
}

/**
 * Create a link. With no fanId, creates a NEW fan account. With an existing
 * fanId, mints a fresh link for that SAME account (history + balance kept) and
 * adds the granted spins on top.
 */
export function mockCreatePass(
  name: string,
  spins: number,
  fanId?: string,
  campaignId?: string,
  amountCents?: number
): { token: string; fanId: string } {
  const add = Math.max(0, spins);
  const money = Math.max(0, Math.floor(amountCents ?? 0) || 0);
  const fan = fanId ? store.fans.get(fanId) : undefined;

  const pushGrant = (id: string) => {
    store.grants.push({
      id: "g-" + Math.random().toString(36).slice(2, 10),
      fanId: id,
      campaignId: campaignId ?? null,
      spins: add,
      amountCents: money,
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
    store.fans.set(id, {
      id,
      name: name.trim() || "Fan",
      spinsRemaining: add,
      spinsGrantedTotal: add,
      primaryToken: token,
      wins: [],
    });
    store.tokens.set(token, id);
    if (campaignId) store.tokenCampaign.set(token, campaignId);
    pushGrant(id);
    return { token, fanId: id };
  }

  // Existing fan (top-up): add to balances, DON'T mint a new token, just grant.
  fan.spinsRemaining += add;
  fan.spinsGrantedTotal += add;
  pushGrant(fan.id);
  if (campaignId) store.tokenCampaign.set(fan.primaryToken, campaignId);
  return { token: fan.primaryToken, fanId: fan.id };
}

/** Top up spins on the fan account behind a token. */
export function mockGrantSpins(token: string, n: number) {
  const fan = fanForToken(token);
  if (!fan) return null;
  fan.spinsRemaining += Math.max(0, n);
  return fan.spinsRemaining;
}

export function mockListFans(): FanAccountSummary[] {
  const tokensByFan = new Map<string, string[]>();
  for (const [token, fanId] of store.tokens) {
    (tokensByFan.get(fanId) ?? tokensByFan.set(fanId, []).get(fanId)!).push(token);
  }
  const campaignName = new Map(store.campaigns.map((c) => [c.id, c.name]));

  return Array.from(store.fans.values()).map((f) => {
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
    return {
      fanId: f.id,
      name: f.name,
      spinsRemaining: f.spinsRemaining,
      grantedTotal: f.spinsGrantedTotal,
      primaryToken: f.primaryToken,
      totalSpent,
      campaignNames,
      links: (tokensByFan.get(f.id) ?? []).map((token) => ({ token })),
      lastWin: f.wins[0]
        ? { label: f.wins[0].label, rarity: f.wins[0].rarity, at: f.wins[0].at }
        : null,
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

  // Grants newest-first, with campaign name resolved.
  const grants: Grant[] = myGrants
    .slice()
    .reverse()
    .map((g) => ({
      id: g.id,
      spins: g.spins,
      amountCents: g.amountCents,
      campaignId: g.campaignId,
      campaignName: g.campaignId ? campaignName.get(g.campaignId) ?? null : null,
      at: g.at,
    }));

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
  };
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
  }));
  return {
    metrics: {
      fans: store.fans.size,
      spinsPlayed: redemptions.length,
      pending: redemptions.filter((r) => r.status === "pending").length,
      fulfilled: redemptions.filter((r) => r.status === "fulfilled").length,
      revenue,
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
      // "Opened" isn't tracked — funnel runs links → spun → fulfilled.
      links: store.tokens.size,
      spun: store.redemptions.length,
      fulfilled: store.redemptions.filter((r) => r.status === "fulfilled").length,
    },
    revenueTrend,
  };
}

export function mockSetRedemptionStatus(id: string, status: RedemptionStatus) {
  const r = store.redemptions.find((x) => x.id === id);
  if (!r) return null;
  r.status = status;
  return r;
}

// --- Campaigns --------------------------------------------------------------

export function mockCreateCampaign(name: string): Campaign {
  const campaign: Campaign = {
    id: "camp-" + Math.random().toString(36).slice(2, 9),
    name: name.trim() || "Campaign",
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  store.campaigns.unshift(campaign);
  return structuredClone(campaign);
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
      revenue,
      arpu,
      topPrize,
    };
  });
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
