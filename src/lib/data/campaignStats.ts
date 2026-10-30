import { readScopedRows, READ_PAGE_SIZE } from "./readPages";
import type { createClient } from "@/lib/supabase/server";
import type { Rarity } from "@/lib/games/wheel/types";
import type { Campaign, CampaignStats } from "./types";

// Callers pass the creator's session client; this module never constructs a
// privileged client. Every paged read retains the same RLS and creator scope.
type SessionClient = Awaited<ReturnType<typeof createClient>>;

// Shared keyset paging detects PostgREST caps and refuses incomplete reports.
export const STATS_PAGE_SIZE = READ_PAGE_SIZE;

export async function listCampaignsFor(
  sb: SessionClient,
  userId: string,
  cutoff: string = new Date().toISOString(),
  pageSize: number = STATS_PAGE_SIZE,
): Promise<Campaign[]> {
  const data = await readScopedRows<{ name: string; is_active: boolean; created_at: string; pinned_wheel_id: string | null }>(sb, "campaigns", "name, is_active, created_at, pinned_wheel_id", q => q.eq("creator_id", userId), cutoff, pageSize);
  data.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

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
  const cutoff = new Date().toISOString();
  const campaigns = await listCampaignsFor(sb, userId, cutoff, pageSize);
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.id);

  // Redemptions are matched through their spin (same set as "spin_id in this
  // campaign's spins") so no spin-id list has to travel in the URL.
  const [grants, spins, fulfilledRows] = await Promise.all([
    readScopedRows<{ campaign_id: string; fan_id: string; spins: number; amount_cents: number }>(sb, "grants", "campaign_id, fan_id, spins, amount_cents", q => q.eq("creator_id", userId).in("campaign_id", ids), cutoff, pageSize),
    readScopedRows<{ campaign_id: string; prize_label: string; prize_rarity: Rarity; created_at: string; kind?: "play" | "bonus" }>(sb, "spins", "campaign_id, prize_label, prize_rarity, created_at, kind", q => q.eq("creator_id", userId).in("campaign_id", ids), cutoff, pageSize),
    readScopedRows<{ spin: { campaign_id: string } | null }>(sb, "redemptions", "spin:spins!inner(campaign_id, creator_id)", q => q.eq("creator_id", userId).eq("status", "fulfilled").eq("spin.creator_id", userId).in("spin.campaign_id", ids), cutoff, pageSize),
  ]);
  // Preserve the original first-award tie break after the stable ID traversal.
  spins.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  type Acc = {
    spinsBought: number;
    revenue: number;
    fans: Set<string>;
    spinsPlayed: number;
    rewards: number;
    fulfilled: number;
    prizes: Map<string, { label: string; rarity: Rarity; count: number }>;
  };
  const acc = new Map<string, Acc>();
  for (const id of ids) {
    acc.set(id, { spinsBought: 0, revenue: 0, fans: new Set(), spinsPlayed: 0, rewards: 0, fulfilled: 0, prizes: new Map() });
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
    // One paid play can create several real rewards; neither its conversion
    // rate nor its fulfilment backlog may be derived from the other count.
    if (s.kind !== "bonus") a.spinsPlayed += 1;
    a.rewards += 1;
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
      pending: Math.max(0, a.rewards - a.fulfilled),
      playThroughPct: a.spinsBought > 0 ? a.spinsPlayed / a.spinsBought : 0,
      revenue: a.revenue,
      arpu: uniqueFans ? Math.round(a.revenue / uniqueFans) : 0,
      topPrize,
    };
  });
}
