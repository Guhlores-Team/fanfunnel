import type { createClient } from "@/lib/supabase/server";
import type { Rarity } from "@/lib/games/wheel/types";
import type { Campaign, CampaignStats } from "./types";

// Kept free of runtime server imports so the unit test can drive it with a fake
// client. Callers pass the creator's session client: every read stays under RLS.
type SessionClient = Awaited<ReturnType<typeof createClient>>;

// PostgREST caps every response at `max_rows` (Supabase default 1000), so
// batched reads are paged. The page size must not exceed that cap, or a short
// page would be mistaken for the last one.
export const STATS_PAGE_SIZE = 1000;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

async function selectAllPages<T>(
  page: (from: number, to: number) => PageResult<T>,
  pageSize: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error || !data) return out;
    out.push(...data);
    if (data.length < pageSize) return out;
  }
}

export async function listCampaignsFor(
  sb: SessionClient,
  userId: string,
): Promise<Campaign[]> {
  const { data } = await sb
    .from("campaigns")
    .select("id, name, is_active, created_at, pinned_wheel_id")
    .eq("creator_id", userId)
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

/**
 * Per-campaign comparison stats in a constant number of queries: the campaign
 * list, then grants, spins and fulfilled redemptions for ALL those campaigns
 * at once (one page each per STATS_PAGE_SIZE rows), aggregated here.
 */
export async function campaignStatsFor(
  sb: SessionClient,
  userId: string,
  pageSize: number = STATS_PAGE_SIZE,
): Promise<CampaignStats[]> {
  const campaigns = await listCampaignsFor(sb, userId);
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.id);

  // Redemptions are matched through their spin (same set as "spin_id in this
  // campaign's spins") so no spin-id list has to travel in the URL.
  const [grants, spins, fulfilledRows] = await Promise.all([
    selectAllPages<{ campaign_id: string; fan_id: string; spins: number; amount_cents: number }>(
      (from, to) =>
        sb
          .from("grants")
          .select("campaign_id, fan_id, spins, amount_cents")
          .eq("creator_id", userId)
          .in("campaign_id", ids)
          .order("id")
          .range(from, to),
      pageSize,
    ),
    // Insertion order, so the top-prize tie-break (first label seen wins)
    // matches the old unordered per-campaign read.
    selectAllPages<{ campaign_id: string; prize_label: string; prize_rarity: Rarity }>(
      (from, to) =>
        sb
          .from("spins")
          .select("campaign_id, prize_label, prize_rarity")
          .eq("creator_id", userId)
          .in("campaign_id", ids)
          .order("created_at")
          .order("id")
          .range(from, to),
      pageSize,
    ),
    selectAllPages<{ spin: { campaign_id: string } | null }>(
      (from, to) =>
        sb
          .from("redemptions")
          .select("id, spin:spins!inner(campaign_id, creator_id)")
          .eq("status", "fulfilled")
          .eq("spin.creator_id", userId)
          .in("spin.campaign_id", ids)
          .order("id")
          .range(from, to) as unknown as PageResult<{ spin: { campaign_id: string } | null }>,
      pageSize,
    ),
  ]);

  type Acc = {
    spinsBought: number;
    revenue: number;
    fans: Set<string>;
    spinsPlayed: number;
    fulfilled: number;
    prizes: Map<string, { label: string; rarity: Rarity; count: number }>;
  };
  const acc = new Map<string, Acc>();
  for (const id of ids) {
    acc.set(id, { spinsBought: 0, revenue: 0, fans: new Set(), spinsPlayed: 0, fulfilled: 0, prizes: new Map() });
  }

  for (const g of grants) {
    const a = acc.get(g.campaign_id);
    if (!a) continue;
    a.spinsBought += g.spins;
    a.revenue += g.amount_cents;
    a.fans.add(g.fan_id);
  }
  for (const s of spins) {
    const a = acc.get(s.campaign_id);
    if (!a) continue;
    a.spinsPlayed += 1;
    const cur = a.prizes.get(s.prize_label);
    if (cur) cur.count += 1;
    else a.prizes.set(s.prize_label, { label: s.prize_label, rarity: s.prize_rarity, count: 1 });
  }
  for (const r of fulfilledRows) {
    const a = r.spin ? acc.get(r.spin.campaign_id) : undefined;
    if (a) a.fulfilled += 1;
  }

  return campaigns.map((campaign) => {
    const a = acc.get(campaign.id)!;
    let topPrize: { label: string; rarity: Rarity; count: number } | null = null;
    for (const entry of a.prizes.values()) {
      if (!topPrize || entry.count > topPrize.count) topPrize = entry;
    }
    const uniqueFans = a.fans.size;
    return {
      campaign,
      spinsBought: a.spinsBought,
      spinsPlayed: a.spinsPlayed,
      uniqueFans,
      fulfilled: a.fulfilled,
      pending: Math.max(0, a.spinsPlayed - a.fulfilled),
      playThroughPct: a.spinsBought > 0 ? a.spinsPlayed / a.spinsBought : 0,
      revenue: a.revenue,
      arpu: uniqueFans ? Math.round(a.revenue / uniqueFans) : 0,
      topPrize,
    };
  });
}
