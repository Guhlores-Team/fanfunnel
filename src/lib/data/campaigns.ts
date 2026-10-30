import { CompleteReadError, readScopedRows } from "./readPages";
import { focusPackTerms, type FocusPackTerms } from "./focusPacks";
// Data layer — campaigns and campaign packs.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { Campaign, CampaignPack, CampaignStats } from "./types";
import { campaignStatsFor, listCampaignsFor } from "./campaignStats";
import {
  mockCreateCampaign,
  mockListCampaigns,
  mockGetCampaignStats,
  mockListCampaignPacks,
  mockCreateCampaignPack,
  mockUpdateCampaignPack,
  mockDeleteCampaignPack,
  mockSetCampaignPinnedWheel,
  mockCampaignPinError,
  mockRenameCampaign,
  mockDeleteCampaign,
  mockGetUncategorizedStats,
} from "./mock";
import { campaignPinError, creatorOwnsCampaign, isUuid } from "./shared";

// ---------------------------------------------------------------------------
// Campaigns: named groupings of links a creator can compare against each other.
// ---------------------------------------------------------------------------

export async function createCampaign(
  name: string,
  pinnedWheelId?: string | null
): Promise<{ campaign: Campaign } | { error: string }> {
  if (!isSupabaseConfigured()) {
    const pinError = mockCampaignPinError(pinnedWheelId);
    return pinError ? { error: pinError } : { campaign: mockCreateCampaign(name, pinnedWheelId) };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // The chosen game must be this creator's own playable game, so a campaign
  // can't be created pointing at another creator's wheel id (same check as
  // setCampaignPinnedWheel and the PATCH route).
  const pinError = await campaignPinError(sb, user.id, pinnedWheelId);
  if (pinError) return { error: pinError };

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

  return listCampaignsFor(sb, user.id);
}

export async function getCampaignStats(): Promise<CampaignStats[]> {
  if (!isSupabaseConfigured()) return mockGetCampaignStats();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  // Batched: a fixed number of queries however many campaigns there are.
  return campaignStatsFor(sb, user.id);
}

export interface UncategorizedStats {
  revenue: number; // cents from grants with no campaign
  spinsBought: number;
  spinsPlayed: number;
  fans: number;
}

/** Revenue/spins NOT attributed to any campaign — so nothing sits in "limbo". */
export async function getUncategorizedStats(): Promise<UncategorizedStats> {
  const empty = { revenue: 0, spinsBought: 0, spinsPlayed: 0, fans: 0 };
  if (!isSupabaseConfigured()) return mockGetUncategorizedStats();
  const cutoff = new Date().toISOString();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return empty;

  const grantRows = await readScopedRows<{ fan_id: string; spins: number; amount_cents: number }>(sb, "grants", "fan_id, spins, amount_cents", q => q.eq("creator_id", user.id).is("campaign_id", null), cutoff);
  const grants = (grantRows ?? []) as { fan_id: string; spins: number; amount_cents: number }[];

  const { count: spinsPlayed } = await sb
    .from("spins")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", user.id)
    .eq("kind", "play")
    .lte("created_at", cutoff)
    .is("campaign_id", null);

  if (typeof spinsPlayed !== "number") throw new CompleteReadError();
  return {
    revenue: grants.reduce((s, g) => s + g.amount_cents, 0),
    spinsBought: grants.reduce((s, g) => s + g.spins, 0),
    spinsPlayed: spinsPlayed ?? 0,
    fans: new Set(grants.map((g) => g.fan_id)).size,
  };
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
  pack_kind?: string; focus_multiplier?: number; focus_spins?: number; chase_within?: number;
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
    packKind: (r.pack_kind ?? "spins") as CampaignPack["packKind"],
    focusMultiplier: Number(r.focus_multiplier ?? 3), focusSpins: r.focus_spins ?? 10, chaseWithin: r.chase_within ?? 10,
  };
}

const PACK_SELECT =
  "id, campaign_id, label, spins, amount_cents, bonus_spins, sort_order, created_at, pack_kind, focus_multiplier, focus_spins, chase_within";

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
  // Only interpolate campaignId into the PostgREST .or() filter if it's a real
  // UUID — guards against filter-string injection from a malformed query param.
  if (campaignId && isUuid(campaignId)) {
    query = query.or(`campaign_id.eq.${campaignId},campaign_id.is.null`);
  }

  const { data } = await query;
  const rows = (data ?? []) as Parameters<typeof toCampaignPack>[0][];
  return rows.map(toCampaignPack);
}

export async function createCampaignPack(input: FocusPackTerms & {
  campaignId: string | null;
  label: string;
  spins: number;
  amountCents: number;
  bonusSpins?: number;
  sortOrder?: number;
}): Promise<CampaignPack> {
  const terms = focusPackTerms(input);
  if (!terms) throw new Error("bad_request");
  if (!isSupabaseConfigured()) return mockCreateCampaignPack(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  // Only attach the pack to a campaign this creator actually owns.
  if (!(await creatorOwnsCampaign(sb, user.id, input.campaignId)))
    throw new Error("campaign_not_found");

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
      pack_kind: terms.packKind, focus_multiplier: terms.focusMultiplier, focus_spins: terms.focusSpins, chase_within: terms.chaseWithin,
    })
    .select(PACK_SELECT)
    .single();
  if (error || !data) throw new Error("db_error");
  return toCampaignPack(data as Parameters<typeof toCampaignPack>[0]);
}

export async function updateCampaignPack(
  id: string,
  patch: Partial<FocusPackTerms & {
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

  const { data: current, error: currentError } = await sb.from("campaign_packs").select(PACK_SELECT).eq("id", id).eq("creator_id", user.id).maybeSingle();
  if (currentError || !current) return { error: "not_found" };
  const terms = focusPackTerms({ ...toCampaignPack(current as Parameters<typeof toCampaignPack>[0]), ...patch });
  if (!terms) return { error: "bad_request" };
  const upd: Record<string, unknown> = {
    pack_kind: terms.packKind, focus_multiplier: terms.focusMultiplier, focus_spins: terms.focusSpins, chase_within: terms.chaseWithin,
  };
  if ("campaignId" in patch) {
    // Re-tagging the pack must stay within this creator's own campaigns.
    if (!(await creatorOwnsCampaign(sb, user.id, patch.campaignId)))
      return { error: "campaign_not_found" };
    upd.campaign_id = patch.campaignId ?? null;
  }
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

/** Choose the game a campaign plays (null: follow the creator's live game). */
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

  // The chosen game must be this creator's own playable game.
  const pinError = await campaignPinError(sb, user.id, wheelId);
  if (pinError) return { error: pinError };

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
