import { issueCreatorActorContext } from "@/lib/auth/creatorActorContext";
import { bingoReadyError } from "./bingo";
import { gameSettings, gameWriteError, requireGameFeature } from "./gameSettings";
// Data layer — wheels: which wheel a link resolves to right now, wheel CRUD,
// prize rows, scheduling and archiving.
import { isSupabaseConfigured, createClient, createServiceClient } from "@/lib/supabase/server";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import type { Prize, WheelConfig } from "@/lib/games/wheel/types";
import { MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { storedWeight } from "@/lib/games/wheel/weights";
import { MAX_PRIZE_LABEL, wheelRulesError } from "@/lib/games/wheel/validate";
import { showsStock } from "@/lib/games/wheel/publicView";
import { isPlayableGame, pickLiveGame } from "@/lib/games/liveGame";
import type { WheelSummary, HappyHourStatus } from "./types";

import {
  mockGetWheel,
  mockSaveWheel,
  mockListWheels,
  mockGetWheelById,
  mockCreateWheel,
  mockDuplicateWheel,
  mockArchiveWheel,
  mockUnarchiveWheel,
  mockDeleteWheel,
  mockSetActiveWheel,
  mockSetWheelSchedule,
} from "./mock";
import { WHEEL_SELECT, clampInt, isUuid, toWheelConfig } from "./shared";
import type { Json } from "./db.types";
import type { AnyClient, DbWheelRow } from "./shared";
import { copyTitle, newGameTitle } from "@/lib/games/copyTitle";

// ---------------------------------------------------------------------------
// Wheel resolution (Model C hybrid). Decides WHICH wheel a fan link points at
// right now, given the creator's wheels, schedules, and the campaign pin.
// ---------------------------------------------------------------------------

/**
 * The creator's currently-live game among their non-archived, ready games
 * (pickLiveGame: open schedule window, else is_active, else oldest, each
 * tie-broken by created_at then id). Mirrors SQL _creator_default_wheel
 * (0061), which issuance and spin time share; the dashboard explains the
 * same decision with the same function.
 */
export async function resolveActiveWheelId(
  sb: AnyClient,
  creatorId: string,
  now: Date
): Promise<string | null> {
  const { data } = await sb
    .from("wheels")
    .select("id, is_active, active_from, active_until, created_at, game_kind, game_ready")
    .eq("creator_id", creatorId)
    .is("archived_at", null);

  const rows = ((data ?? []) as {
    id: string;
    is_active: boolean;
    active_from: string | null;
    active_until: string | null;
    created_at: string;
    archived_at?: string | null;
    game_kind?: "wheel" | "scratch" | "bingo";
    game_ready?: boolean;
  }[]).map((row) => ({
    id: row.id,
    isActive: row.is_active,
    archivedAt: row.archived_at ?? null,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    createdAt: row.created_at,
    gameKind: row.game_kind,
    gameReady: row.game_ready,
  }));
  return pickLiveGame(rows, now)?.game.id ?? null;
}

/**
 * The wheel a specific pass should use right now: the link's own pinned game
 * (0065, if set and playable) wins; then the campaign's pinned game (if set
 * and playable); otherwise the creator's live game; otherwise the pass's own
 * stored wheel_id (if playable). Mirrors SQL _resolved_spin_wheel (0061,
 * 0065); "playable" is isPlayableGame in liveGame.ts.
 */
export async function resolveWheelId(
  sb: AnyClient,
  pass: { creator_id: string; campaign_id: string | null; wheel_id: string; pinned_wheel_id?: string | null },
  now: Date
): Promise<string | null> {
  if (pass.pinned_wheel_id) {
    const { data: pinned } = await sb
      .from("wheels")
      .select("id, archived_at, game_kind, game_ready")
      .eq("id", pass.pinned_wheel_id)
      .eq("creator_id", pass.creator_id)
      .maybeSingle();
    const row = pinned as { id: string; archived_at: string | null; game_kind?: string; game_ready?: boolean } | null;
    if (row && isPlayableGame({ archivedAt: row.archived_at, gameReady: row.game_ready, gameKind: row.game_kind })) return row.id;
  }
  if (pass.campaign_id) {
    const { data: campaign } = await sb
      .from("campaigns")
      .select("pinned_wheel_id")
      .eq("id", pass.campaign_id)
      .eq("creator_id", pass.creator_id)
      .maybeSingle();
    const pinnedId = (campaign as { pinned_wheel_id: string | null } | null)
      ?.pinned_wheel_id;
    if (pinnedId) {
      const { data: pinned } = await sb
        .from("wheels")
        .select("id, archived_at, game_kind, game_ready")
        .eq("id", pinnedId)
        .eq("creator_id", pass.creator_id)
        .maybeSingle();
      const row = pinned as { id: string; archived_at: string | null; game_kind?: string; game_ready?: boolean } | null;
      if (row && isPlayableGame({ archivedAt: row.archived_at, gameReady: row.game_ready, gameKind: row.game_kind })) return row.id;
    }
  }

  const active = await resolveActiveWheelId(sb, pass.creator_id, now);
  if (active) return active;
  const { data: stored } = await sb.from("wheels").select("id,archived_at,game_kind,game_ready").eq("id", pass.wheel_id).eq("creator_id", pass.creator_id).maybeSingle();
  const row = stored as { id: string; archived_at: string | null; game_kind?: string; game_ready?: boolean } | null;
  return row && isPlayableGame({ archivedAt: row.archived_at, gameReady: row.game_ready, gameKind: row.game_kind }) ? row.id : null;
}

/**
 * The currently-running happy hour for a wheel: any window where
 * starts_at <= now < ends_at. When several overlap we take the largest
 * multiplier. Returns an inactive status (multiplier 1) when none apply.
 */
export async function getActiveHappyHour(
  sb: AnyClient,
  wheelId: string,
  now: Date,
  creatorId?: string
): Promise<HappyHourStatus> {
  const iso = now.toISOString();
  // Only the game owner's own happy hours count (same filter as SQL
  // _spin_attempt_context); the policy and trigger refuse cross-tenant rows.
  let query = sb
    .from("happy_hours")
    .select("multiplier, ends_at")
    .eq("wheel_id", wheelId);
  if (creatorId) query = query.eq("creator_id", creatorId);
  const { data } = await query
    .lte("starts_at", iso)
    .gt("ends_at", iso);

  const rows = (data ?? []) as { multiplier: number; ends_at: string }[];
  if (rows.length === 0) return { active: false, multiplier: 1, endsAt: null };

  let best = rows[0];
  for (const r of rows) if (r.multiplier > best.multiplier) best = r;
  return { active: true, multiplier: best.multiplier, endsAt: best.ends_at };
}

// ---------------------------------------------------------------------------
// Wheel configuration (the editor reads + writes this)
// ---------------------------------------------------------------------------

// Returns the signed-in creator's wheel id, creating a default one (seeded from
// the sample) on first use so a creator always has something to edit.
export async function ensureWheelId(
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
    .select(CREATOR_WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();

  // The row can be absent (e.g. resolved id not readable, or removed between
  // resolve and fetch). getWheel is declared `WheelConfig | null` and the
  // dashboard falls back to a sample wheel, so return null instead of passing
  // null into toWheelConfig (which dereferences `.prizes` and crashes the render).
  if (!data) return null;
  const { count, error: historyError } = await sb.from("spins").select("id", { count: "exact", head: true }).eq("wheel_id", (data as unknown as DbWheelRow).id);
  return { ...toWheelConfig(data as unknown as DbWheelRow), ...wheelVersion(data), gameKindLocked: historyError ? true : count == null ? true : count > 0 };
}

/** The creator's own read of a game also carries its version (0073, DB-11). */
const CREATOR_WHEEL_SELECT = `updated_at, ${WHEEL_SELECT}`;
function wheelVersion(row: unknown): { updatedAt?: string } {
  const at = (row as { updated_at?: unknown } | null)?.updated_at;
  return typeof at === "string" ? { updatedAt: at } : {};
}

/** The stock each prize had when the editor loaded it, by prize id (null =
 *  unlimited). SQL applies a stock edit as the creator's delta over the live
 *  value (spins that landed meanwhile are never un-decremented) and refuses a
 *  limited/unlimited switch the creator did not see with `stock_changed`. */
export type ExpectedStock = Record<string, number | null>;
/**
 * `expectedUpdatedAt` (0073, DB-11): the game version the editor loaded. A
 * save over a newer version is refused with `game_changed`, in SQL, so two
 * tabs or a team member can never silently replace each other's game.
 * `draft` (0073, DB-12 / WC-11): an unpublished bingo game that is not
 * complete yet is stored as an inactive draft instead of being refused.
 */
export interface SaveWheelOptions { expectedStock?: ExpectedStock; expectedUpdatedAt?: string | null; draft?: boolean }
export async function saveWheel(
  config: WheelConfig,
  options: SaveWheelOptions = {}
): Promise<{ wheel: WheelConfig } | { error: string }> {
  const expectedStock = options.expectedStock ?? {};
  const expectedMs = options.expectedUpdatedAt ? Date.parse(options.expectedUpdatedAt) : NaN;
  const expectedUpdatedAt = Number.isFinite(expectedMs) ? new Date(expectedMs).toISOString() : null;
  const withExpectedStock = <T extends { id: string | null }>(row: T, prizeId: string) =>
    Object.hasOwn(expectedStock, prizeId) && isUuid(prizeId) ? { ...row, expected_stock: expectedStock[prizeId] } : row;
  // The editor's wheel rules (≥ 2 prizes, every prize named, one prize with
  // tickets > 0), enforced here for both data paths before anything is read or
  // written. This also refuses an empty prize set, which is almost always a
  // failed editor load and would otherwise wipe the wheel's real prizes.
  const rule = wheelRulesError(config.prizes);
  if (rule) return { error: rule };

  if (!isSupabaseConfigured()) {
    try { return { wheel: mockSaveWheel(config, expectedStock, { expectedUpdatedAt, draft: options.draft === true }) }; } catch(error) { return { error: error instanceof Error ? error.message : "db_error" }; }
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: canEdit, error: permissionError } = await sb.rpc("can_act_for", {
    target_creator: user.id, perm: "edit_wheel",
  });
  if (permissionError || canEdit !== true) return { error: "forbidden" };

  // Save the wheel identified by `config.id`. ensureWheelId is only a bootstrap
  // so a brand-new creator always has at least one wheel to edit.
  await ensureWheelId(sb, user.id);
  const wheelId = config.id;
  if (!wheelId) return { error: "no_wheel" };

  const existing = await getWheelById(wheelId);
  if (!existing) return { error: "not_found" };
  // WC-11: only a game that was never published can be saved as a draft.
  const allowDraft = options.draft === true && existing.gameReady === false;
  let settings;
  try {
    settings = gameSettings(config.gameKind ?? existing.gameKind ?? "wheel", config.gameConfig ?? existing.gameConfig, allowDraft);
    const kindChanged=settings.gameKind !== (existing.gameKind ?? "wheel");
    if(kindChanged && existing.gameKindLocked !== false)return {error:"game_kind_locked"};
    if(kindChanged || (settings.gameKind === "bingo" && existing.gameReady === false))await requireGameFeature(sb,user.id,settings.gameKind);
  } catch(error) { return { error: error instanceof Error ? error.message : "invalid_game" }; }

  const upd: Record<string, unknown> = {
    game_kind: settings.gameKind,
    game_config: settings.gameConfig,
    game_ready:true,
    title: config.title.slice(0, 120),
    subtitle: config.subtitle?.slice(0, 200) ?? null,
    brand_color: config.brandColor ?? "#ec4899",
    // #11: persist the per-wheel label color (null clears it → auto-pick).
    label_color: config.labelColor ?? null,
    // Per-wheel label text size; only persist known values (else Auto/null).
    label_size:
      config.labelSize && ["s", "l", "xl"].includes(config.labelSize)
        ? config.labelSize
        : null,
  };
  // Persist lifecycle/schedule fields only when present on the incoming config.
  if (typeof config.isActive === "boolean") upd.is_active = config.isActive;
  // RM-2 "Show stock to fans": only a real boolean changes it (else kept).
  if (typeof config.showStock === "boolean") upd.show_stock = config.showStock;
  if (config.activeFrom !== undefined) upd.active_from = config.activeFrom;
  if (config.activeUntil !== undefined) upd.active_until = config.activeUntil;

  if (settings.gameKind === "bingo") {
    const normalized = { ...config, gameKind: "bingo" as const, gameConfig: settings.gameConfig };
    const invalid = bingoReadyError(normalized);
    if (invalid && !allowDraft) return { error: invalid };
    const ids=new Map(config.prizes.map(prize=>[prize.id,isUuid(prize.id)?prize.id:crypto.randomUUID()]));
    const linePrizeId=(settings.gameConfig as {linePrizeId:string|null}).linePrizeId;
    const gameConfig={size:3,linePrizeId:(linePrizeId?ids.get(linePrizeId):null)??null};
    const payload = config.prizes.map((prize,index) => withExpectedStock({ ...prizeRow(wheelId,prize,index), id:ids.get(prize.id)! }, prize.id));
    // Metadata/readiness and the real prize IDs publish together. Never set
    // game_ready=true on an incomplete draft before the inventory transaction.
    const context = await issueCreatorActorContext(sb, user.id, "edit_wheel");
    if (!context) return { error: "db_error" };
    const { error } = await createServiceClient().rpc("save_game_wheel", {p_wheel:wheelId,p_creator:user.id,p_actor:user.id,p_context:context,p_prizes:payload as unknown as Json,
      p_config:{title:upd.title,subtitle:upd.subtitle,brand_color:upd.brand_color,label_color:upd.label_color,label_size:upd.label_size,show_stock:showsStock(config),game_kind:"bingo",game_config:gameConfig} as unknown as Json,
      // 0073: an incomplete, never-published game is stored as an inactive
      // draft; the version check runs under the wheel lock.
      p_ready:!invalid,p_expected_updated_at:expectedUpdatedAt});
    if(error)return {error:gameWriteError(error)};
    const saved=await getWheelById(wheelId);
    return saved?{wheel:saved}:{error:"db_error"};
  }

  // The RLS-scoped client only sees the creator's own wheels, so this verifies
  // ownership: a foreign/unknown id matches no row.
  // 0073 (DB-11): the version advances only when something other than stock
  // changed (a stock-only save must not invalidate a fan's held play), so the
  // settings stamp it here only when they differ; save_wheel_prizes stamps
  // it for the prizes. With an expected version the update is the
  // compare-and-set: no row means another save got there first.
  if (wheelSettingsChanged(existing, upd)) upd.updated_at = new Date().toISOString();
  let settingsUpdate = sb
    .from("wheels")
    .update(upd)
    .eq("id", wheelId)
    .eq("creator_id", user.id);
  if (expectedUpdatedAt) {
    settingsUpdate = settingsUpdate.gte("updated_at", expectedUpdatedAt).lt("updated_at", new Date(expectedMs + 1).toISOString());
  }
  const { data: updated, error: wErr } = await settingsUpdate.select("id, updated_at").maybeSingle();
  if (wErr) return { error: gameWriteError(wErr) };
  if (!updated) return { error: expectedUpdatedAt ? "game_changed" : "not_found" };
  const versionAfterSettings = expectedUpdatedAt ? ((updated as { updated_at?: string | null }).updated_at ?? null) : null;

  // Replace prizes wholesale. Spin history is safe because spins snapshot the
  // prize label/rarity and prizes.prize_id is ON DELETE SET NULL.
  //
  // Build the replacement rows BEFORE deleting anything. prizeRow caps the
  // integer columns (weight/cost_cents/stock) to Postgres' int4 range so an
  // oversized value can't make the INSERT fail.
  //
  // NEVER silently truncate: reject an over-limit payload so the caller can
  // surface it instead of dropping prizes (the old `.slice(0, 24)` lost any
  // prize past 24 with no warning).
  if (config.prizes.length > MAX_WHEEL_PRIZES) return { error: "too_many_prizes" };
  const rows = config.prizes.map((p, i) => prizeRow(wheelId, p, i));

  const { data: prevPrizes, error: previousError } = await sb
    .from("prizes")
    .select("*")
    .eq("wheel_id", wheelId);
  if (previousError) return { error: "db_error" };

  // Guard the catastrophic case: the editor showed the built-in SAMPLE set
  // (e.g. a failed load fell back to it) and a save would overwrite the
  // creator's real, larger prize list with the 7 defaults. If the incoming
  // labels are EXACTLY the sample set and the wheel currently has more prizes,
  // treat it as a stale editor and refuse rather than destroy data.
  const SEP = "\u0000";
  const sampleLabels = SAMPLE_WHEEL.prizes.map((p) => p.label).join(SEP);
  const incomingLabels = config.prizes.map((p) => p.label).join(SEP);
  if (incomingLabels === sampleLabels && (prevPrizes?.length ?? 0) > rows.length) {
    return { error: "stale_editor" };
  }

  // The session/RLS update above established the caller owns this wheel. The
  // service-only transaction rechecks that owner and retains reward-bearing ids.
  const svc = createServiceClient();
  const payload = config.prizes.map((p, i) => withExpectedStock({ ...rows[i], id: isUuid(p.id) ? p.id : null }, p.id));
  const { error: saveError } = await svc.rpc("save_wheel_prizes", {
    p_wheel: wheelId, p_creator: user.id, p_prizes: payload as unknown as Json,
    p_expected_updated_at: versionAfterSettings,
  });
  if (saveError) return { error: gameWriteError(saveError) };

  const saved = await getWheelById(wheelId);
  return saved ? { wheel: saved } : { error: "db_error" };
}

/**
 * Whether a save changes the game's own settings (not its prizes). Lifecycle
 * fields count as a change whenever they are sent: the loaded config does not
 * carry them. Exported for wheelVersion.test.ts.
 */
export function wheelSettingsChanged(existing: WheelConfig, upd: Record<string, unknown>): boolean {
  return (
    upd.game_kind !== (existing.gameKind ?? "wheel") ||
    JSON.stringify(upd.game_config ?? {}) !== JSON.stringify(existing.gameConfig ?? {}) ||
    existing.gameReady === false ||
    upd.title !== existing.title ||
    (upd.subtitle ?? null) !== (existing.subtitle ?? null) ||
    upd.brand_color !== (existing.brandColor ?? "#ec4899") ||
    (upd.label_color ?? null) !== (existing.labelColor ?? null) ||
    (upd.label_size ?? null) !== (existing.labelSize ?? null) ||
    ("show_stock" in upd && upd.show_stock !== existing.showStock) ||
    "is_active" in upd || "active_from" in upd || "active_until" in upd
  );
}

// Exported for the weight round-trip test (prizeWeights.test.ts).
export function prizeRow(wheelId: string, p: Prize, sortOrder: number) {
  return {
    wheel_id: wheelId,
    label: p.label.slice(0, MAX_PRIZE_LABEL) || "Prize",
    description: p.description?.slice(0, 280) ?? null,
    rarity: p.rarity,
    // Round (not truncate) and keep a positive weight ≥ 1: a stored 0 makes
    // the prize unwinnable.
    weight: storedWeight(p.weight),
    color: p.color ?? null,
    emoji: p.emoji ?? null,
    image_url: p.imageUrl ?? null,
    cost_cents:
      p.cost != null && Number.isFinite(p.cost) ? clampInt(p.cost, 0) : null,
    stock:
      p.stock != null && Number.isFinite(p.stock) ? clampInt(p.stock, 0) : null,
    sort_order: sortOrder,
    boostable: p.boostable === true,
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
    .select(CREATOR_WHEEL_SELECT)
    .eq("id", id)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!data) return null;
  const { count, error: historyError } = await sb.from("spins").select("id", { count: "exact", head: true }).eq("wheel_id", (data as unknown as DbWheelRow).id);
  return { ...toWheelConfig(data as unknown as DbWheelRow), ...wheelVersion(data), gameKindLocked: historyError ? true : count == null ? true : count > 0 };
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

  return wheelSummariesFor(sb, user.id, includeArchived);
}

/**
 * One creator's wheels (newest first), read on the caller's session, so the
 * wheels/prizes RLS applies. Callers resolve `creatorId` first: the caller's
 * own id, or a creator their seat may act for (A28 campaigns).
 */
export async function wheelSummariesFor(
  sb: Awaited<ReturnType<typeof createClient>>,
  creatorId: string,
  includeArchived = false
): Promise<WheelSummary[]> {
  let query = sb
    .from("wheels")
    .select(
      `id, title, subtitle, brand_color, is_active, archived_at,
       active_from, active_until, created_at, updated_at, game_kind, game_ready, prizes(id)`
    )
    .eq("creator_id", creatorId)
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
    created_at?: string;
    updated_at: string;
    game_kind?: "wheel" | "scratch" | "bingo";
    game_ready?: boolean;
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
    ...(r.created_at ? { createdAt: r.created_at } : {}),
    gameKind: r.game_kind ?? "wheel",
    gameReady: r.game_ready !== false,
  }));
}

/**
 * Create a new wheel. From a template it snapshots that template's prizes;
 * otherwise (#7) it starts EMPTY — zero prizes — so the editor shows a friendly
 * empty state + "Add your first prize" instead of pre-seeded sample prizes. It
 * becomes is_active only if it's the creator's first wheel.
 */
export async function createWheel(opts?: {
  fromTemplateId?: string;
  name?: string;
  gameKind?: unknown;
  gameConfig?: unknown;
}): Promise<{ wheel: WheelConfig }> {
  if (!isSupabaseConfigured()) return mockCreateWheel(opts);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  // First wheel? It should be the active one. The titles make the default
  // name unique (WC-10: "New wheel 2", never two "New wheel"s in a picker).
  const { data: existingRows } = await sb
    .from("wheels")
    .select("title")
    .eq("creator_id", user.id)
    .limit(1000);
  const existingTitles = ((existingRows ?? []) as { title: string | null }[]).map((r) => r.title ?? "");
  const isFirst = existingTitles.length === 0;

  // Seed: a template snapshot, else a blank wheel with NO prizes (#7).
  let settings = gameSettings(opts?.gameKind, opts?.gameConfig,true);
  let title = newGameTitle(settings.gameKind, existingTitles);
  let subtitle: string | null = null;
  let brandColor = SAMPLE_WHEEL.brandColor ?? "#ec4899";
  let seedPrizes: Omit<Prize, "id">[] = [];

  if (opts?.fromTemplateId) {
    const { data: tpl } = await sb
      .from("wheel_templates")
      .select("title, subtitle, brand_color, prizes, game_kind, game_config")
      .eq("id", opts.fromTemplateId)
      .eq("creator_id", user.id)
      .maybeSingle();
    const t = tpl as {
      title: string;
      subtitle: string | null;
      brand_color: string | null;
      prizes: Omit<Prize, "id">[] | null;
      game_kind?: unknown;
      game_config?: unknown;
    } | null;
    if (t) {
      title = t.title;
      subtitle = t.subtitle;
      brandColor = t.brand_color ?? "#ec4899";
      seedPrizes = t.prizes ?? [];
      settings = gameSettings(t.game_kind, t.game_config,true);
    }
  }

  if (opts?.name) title = opts.name;
  await requireGameFeature(sb, user.id, settings.gameKind);

  const { data: wheel, error } = await sb
    .from("wheels")
    .insert({
      creator_id: user.id,
      game_kind: settings.gameKind,
      game_config: settings.gameKind === "bingo" ? {size:3,linePrizeId:null} : settings.gameConfig,
      game_ready:settings.gameKind !== "bingo",
      title: title.slice(0, 120),
      subtitle: subtitle?.slice(0, 200) ?? null,
      brand_color: brandColor,
      is_active: isFirst && settings.gameKind !== "bingo",
    })
    .select("id")
    .single();
  if (error || !wheel) throw new Error(gameWriteError(error));

  if(settings.gameKind === "bingo" && seedPrizes.length>0 && settings.gameConfig.linePrizeId) {
    const ids=new Map(seedPrizes.map(prize=>[(prize as Partial<Prize>).id,crypto.randomUUID()]));
    const config:WheelConfig={id:wheel.id,title,subtitle:subtitle??undefined,brandColor,gameKind:"bingo",gameConfig:{size:3,linePrizeId:ids.get(settings.gameConfig.linePrizeId)??""},prizes:seedPrizes.map(prize=>({...prize,id:ids.get((prize as Partial<Prize>).id)!}))};
    const result=await saveWheel(config);if("error" in result)throw new Error(result.error);return result;
  }
  if (seedPrizes.length > 0) {
    await sb.from("prizes").insert(
      seedPrizes
        .slice(0, MAX_WHEEL_PRIZES)
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
  const settings = gameSettings(source.gameKind, source.gameConfig,true);
  await requireGameFeature(sb, user.id, settings.gameKind);
  // A distinct title, so pickers never list two identical games (QA b5 m1).
  const { data: siblings, error: siblingsError } = await sb.from("wheels").select("title").eq("creator_id", user.id);
  if (siblingsError) throw new Error("db_error");

  const { data: wheel, error } = await sb
    .from("wheels")
    .insert({
      creator_id: user.id,
      game_kind: settings.gameKind,
      game_config: settings.gameKind === "bingo" ? {size:3,linePrizeId:null} : settings.gameConfig,
      game_ready:settings.gameKind !== "bingo",
      title: copyTitle(source.title, (siblings ?? []).map((row) => row.title as string)),
      subtitle: source.subtitle?.slice(0, 200) ?? null,
      brand_color: source.brandColor ?? "#ec4899",
      label_color: source.labelColor ?? null,
      label_size: source.labelSize ?? null,
      // RM-2: a copy keeps the creator's "Show stock to fans" choice (as the mock does).
      show_stock: showsStock(source),
      is_active: false,
      active_from: null,
      active_until: null,
    })
    .select("id")
    .single();
  if (error || !wheel) throw new Error(gameWriteError(error));

  if(settings.gameKind === "bingo" && settings.gameConfig.linePrizeId) {
    const ids=new Map(source.prizes.map(prize=>[prize.id,crypto.randomUUID()]));
    const config:WheelConfig={...source,id:wheel.id,gameConfig:{size:3,linePrizeId:ids.get(settings.gameConfig.linePrizeId)??""},prizes:source.prizes.map(prize=>({...prize,id:ids.get(prize.id)!}))};
    const result=await saveWheel(config);if("error" in result)throw new Error(result.error);return result;
  }
  if (source.prizes.length > 0) {
    await sb.from("prizes").insert(
      source.prizes.slice(0, MAX_WHEEL_PRIZES).map((p, i) => prizeRow(wheel.id, p, i))
    );
  }

  const saved = await getWheelById(wheel.id);
  if (!saved) throw new Error("db_error");
  return { wheel: saved };
}

/** A lock wait that gave up (deadlock victim, lock or statement timeout, or
 *  a serialization failure): the archive/delete changed nothing and can simply
 *  be retried. _lock_wheel_lifecycle (0065) only blocks after 20 NOWAIT tries,
 *  so this needs fans playing the game the whole time. */
function lifecycleBusy(error: { code?: string } | null | undefined): boolean {
  return ["40P01", "55P03", "57014", "40001"].includes(error?.code ?? "");
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

  // archive_wheel (0065) takes the game's Focus/Chase fans before the wheel
  // row, the order a credited play uses; a plain UPDATE could deadlock with it.
  const { data: archived, error } = await sb.rpc("archive_wheel", { p_wheel: id });
  if (error) return { error: lifecycleBusy(error) ? "game_busy" : gameWriteError(error) };
  if (archived !== "ok") return { error: "not_found" };

  // If we just archived the active wheel, promote the oldest survivor.
  if (row.is_active) {
    const { data: next } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .is("archived_at", null)
      .eq("game_ready",true)
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

  // The authorization archive_wheel (0065) applies on the way in: the caller
  // must hold edit_wheel for the creator (can_act_for also requires an active
  // profile). The update stays creator-scoped, and matching no row is
  // not_found rather than a silent success.
  const { data: canEdit, error: permissionError } = await sb.rpc("can_act_for", {
    target_creator: user.id, perm: "edit_wheel",
  });
  if (permissionError || canEdit !== true) return { error: "forbidden" };

  const { data: restored, error } = await sb
    .from("wheels")
    .update({ archived_at: null })
    .eq("id", id)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) return { error: gameWriteError(error) };
  return restored ? { ok: true } : { error: "not_found" };
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

  // delete_wheel (0065) refuses a game with spin history (revenue/analytics
  // records) or a fan link stored on it (the cascade would erase that link and
  // its balance) under the wheel lock, taken after its Focus/Chase fans and the
  // fans whose links are set to it, like a play.
  const { data: deleted, error } = await sb.rpc("delete_wheel", { p_wheel: id });
  if (error) return { error: lifecycleBusy(error) ? "game_busy" : gameWriteError(error) };
  if (deleted === "has_history") return { error: "has_history" };
  if (deleted !== "ok") return { error: "not_found" };

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
    .select("id,game_ready")
    .eq("id", id)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!target) return { error: "not_found" };
  if(target.game_ready === false)return {error:"game_not_ready"};

  // CC-06: flag the chosen game first, then clear the others. The old order
  // (clear all, then set) left a moment with no live game, when a fan's page
  // fell back to the oldest game. With this order there is always a live
  // game; for an instant two are flagged and the resolver picks one of them,
  // both of which the creator made live. A failed first step changes nothing.
  const { error } = await sb
    .from("wheels")
    .update({ is_active: true })
    .eq("id", id)
    .eq("creator_id", user.id);
  if (error) return { error: gameWriteError(error) };

  const { error: clearErr } = await sb
    .from("wheels")
    .update({ is_active: false })
    .eq("creator_id", user.id)
    .neq("id", id);
  return clearErr ? { error: "db_error" } : { ok: true };
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
  if (error) return { error: gameWriteError(error) };
  if (!updated) return { error: "not_found" };
  return { ok: true };
}
