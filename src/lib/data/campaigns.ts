import { CompleteReadError, readScopedRows } from "./readPages";
import { focusPackTerms, type FocusPackTerms } from "./focusPacks";
// Data layer — campaigns and campaign packs.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { Campaign, CampaignPack, CampaignStats, WheelSummary } from "./types";
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
  mockSetCampaignActive,
  mockDeleteCampaign,
  mockGetUncategorizedStats,
  mockListWheels,
  mockDemoCreatorActive,
} from "./mock";
import { campaignPinError, creatorOwnsCampaign, isUuid } from "./shared";
import { demoActingCreator, resolveActingCreator } from "./seatScope";
import { wheelSummariesFor } from "./wheels";

/** A literal for PostgREST `ilike`: its wildcards and escape are escaped. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Campaigns: named groupings of links a creator can compare against each other.
//
// A28 (agency seats): every campaign reader/writer below takes an optional
// `creatorId` (untrusted input). Without it, or with the caller's own id, it
// acts on the caller's own campaigns exactly as before. With another creator's
// id it needs can_act_for(creatorId, 'manage') on the caller's own session
// (agency owners and managers), checked here before any read or write; the
// campaigns_write RLS checks the same permission again on the row.
// ---------------------------------------------------------------------------

type ActingSession =
  | { sb: Awaited<ReturnType<typeof createClient>>; creatorId: string }
  | { error: "unauthorized" | "bad_request" | "forbidden" };

/** The signed-in session and the creator whose campaigns it acts on. */
// 0069: the database refuses a campaign game that is archived, a draft, has
// fewer than 2 prizes or belongs to another creator (aa_campaign_game), after
// the campaignPinError pre-check; the answer is the same either way.
const pinWriteError = (error: { message?: string } | null | undefined): string =>
  /^(game_needs_prizes|game_not_playable)/.test(error?.message ?? "") || /campaign game belongs to another creator/.test(error?.message ?? "") ? "game_not_playable" : "db_error";

export async function campaignActingSession(creatorId: unknown): Promise<ActingSession> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const acting = await resolveActingCreator(sb, user.id, creatorId, "manage");
  if ("error" in acting) return acting;
  return { sb, creatorId: acting.creatorId };
}

export async function createCampaign(
  name: string,
  pinnedWheelId?: string | null,
  creatorId?: unknown
): Promise<{ campaign: Campaign } | { error: string }> {
  if (!isSupabaseConfigured() && !mockDemoCreatorActive()) return { error: "forbidden" }; // WU-01 parity: a suspended creator cannot write
  if (!isSupabaseConfigured()) {
    const refused = demoActingCreator(creatorId);
    if (refused) return refused;
    const pinError = mockCampaignPinError(pinnedWheelId);
    if (pinError) return { error: pinError };
    if (mockListCampaigns().some((c) => c.name.toLowerCase() === name.toLowerCase())) return { error: "name_taken" };
    return { campaign: mockCreateCampaign(name, pinnedWheelId) };
  }

  const acting = await campaignActingSession(creatorId);
  if ("error" in acting) return acting;
  const { sb } = acting;

  // The chosen game must be this creator's own playable game, so a campaign
  // can't be created pointing at another creator's wheel id (same check as
  // setCampaignPinnedWheel and the PATCH route).
  const pinError = await campaignPinError(sb, acting.creatorId, pinnedWheelId);
  if (pinError) return { error: pinError };

  // RD-13: the Fans tab filters by campaign name, so two campaigns with the
  // same name (any case) would merge there; refuse the second.
  const { data: clash, error: clashError } = await sb
    .from("campaigns")
    .select("id")
    .eq("creator_id", acting.creatorId)
    .ilike("name", escapeLike(name))
    .limit(1);
  if (clashError) return { error: "db_error" };
  if (clash && clash.length > 0) return { error: "name_taken" };

  const { data, error } = await sb
    .from("campaigns")
    .insert({ creator_id: acting.creatorId, name, pinned_wheel_id: pinnedWheelId ?? null })
    .select("id, name, is_active, created_at, pinned_wheel_id")
    .single();
  if (error || !data) return { error: pinWriteError(error) };

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

/**
 * A28: the campaigns of the creator a seat works for (or the caller's own),
 * with that creator's games (archived included) for the game picker. Refused
 * before any read unless the caller may 'manage' that creator.
 */
export async function listActingCampaigns(
  creatorId: unknown
): Promise<{ campaigns: Campaign[]; games: WheelSummary[] } | { error: "unauthorized" | "bad_request" | "forbidden" }> {
  if (!isSupabaseConfigured()) return demoActingCreator(creatorId) ?? { campaigns: mockListCampaigns(), games: mockListWheels(true) };
  const acting = await campaignActingSession(creatorId);
  if ("error" in acting) return acting;
  const [campaigns, games] = await Promise.all([
    listCampaignsFor(acting.sb, acting.creatorId),
    wheelSummariesFor(acting.sb, acting.creatorId, true),
  ]);
  return { campaigns, games };
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
  wheelId: string | null,
  creatorId?: unknown
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured())
    return demoActingCreator(creatorId) ?? mockSetCampaignPinnedWheel(campaignId, wheelId);

  const acting = await campaignActingSession(creatorId);
  if ("error" in acting) return acting;
  const { sb } = acting;

  // The chosen game must be this creator's own playable game.
  const pinError = await campaignPinError(sb, acting.creatorId, wheelId);
  if (pinError) return { error: pinError };

  const { data: updated, error } = await sb
    .from("campaigns")
    .update({ pinned_wheel_id: wheelId })
    .eq("id", campaignId)
    .eq("creator_id", acting.creatorId)
    .select("id")
    .maybeSingle();
  if (error) return { error: pinWriteError(error) };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}

/** Rename a campaign. */
export async function renameCampaign(
  campaignId: string,
  name: string,
  creatorId?: unknown
): Promise<{ ok: true } | { error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "bad_request" };
  if (!isSupabaseConfigured()) return demoActingCreator(creatorId) ?? mockRenameCampaign(campaignId, trimmed);

  const acting = await campaignActingSession(creatorId);
  if ("error" in acting) return acting;
  // RD-13: same uniqueness rule as createCampaign (another campaign, same name).
  const { data: clash, error: clashError } = await acting.sb
    .from("campaigns")
    .select("id")
    .eq("creator_id", acting.creatorId)
    .ilike("name", escapeLike(trimmed))
    .neq("id", campaignId)
    .limit(1);
  if (clashError) return { error: "db_error" };
  if (clash && clash.length > 0) return { error: "name_taken" };
  const { data: updated, error } = await acting.sb
    .from("campaigns")
    .update({ name: trimmed })
    .eq("id", campaignId)
    .eq("creator_id", acting.creatorId)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}

/**
 * A28: archive (false) or reactivate (true) a campaign. Archiving only takes
 * it out of the default for new fan links and marks it Archived; links already
 * in it keep working and keep counting toward its stats.
 */
export async function setCampaignActive(
  campaignId: string,
  isActive: boolean,
  creatorId?: unknown
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return demoActingCreator(creatorId) ?? mockSetCampaignActive(campaignId, isActive);

  const acting = await campaignActingSession(creatorId);
  if ("error" in acting) return acting;
  const { data: updated, error } = await acting.sb
    .from("campaigns")
    .update({ is_active: isActive })
    .eq("id", campaignId)
    .eq("creator_id", acting.creatorId)
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}

/** Delete a campaign. Grants keep their history (campaign_id → null on delete).
 *  delete_campaign (0071) re-checks manage, then locks the campaign's fans and
 *  links before the campaign (a plain DELETE locked the campaign first and
 *  deadlocked against plays on its links); sessions cannot DELETE campaigns.
 *  A campaign that is not the acting creator's deletes nothing (ok, as before). */
export async function deleteCampaign(
  campaignId: string,
  creatorId?: unknown
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return demoActingCreator(creatorId) ?? mockDeleteCampaign(campaignId);

  const acting = await campaignActingSession(creatorId);
  if ("error" in acting) return acting;
  const { data, error } = await acting.sb.rpc("delete_campaign", { p_campaign: campaignId, p_creator: acting.creatorId });
  return error || (data !== "ok" && data !== "not_found") ? { error: "db_error" } : { ok: true };
}
