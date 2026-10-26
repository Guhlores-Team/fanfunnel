// Data layer — wheels: which wheel a link resolves to right now, wheel CRUD,
// prize rows, scheduling and archiving.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import type { Prize, WheelConfig } from "@/lib/games/wheel/types";
import { MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { storedWeight } from "@/lib/games/wheel/weights";
import { wheelRulesError } from "@/lib/games/wheel/validate";
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
import { WHEEL_SELECT, clampInt, toWheelConfig } from "./shared";
import type { AnyClient, DbWheelRow } from "./shared";

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
export async function resolveActiveWheelId(
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
export async function resolveWheelId(
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
export async function getActiveHappyHour(
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
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();

  // The row can be absent (e.g. resolved id not readable, or removed between
  // resolve and fetch). getWheel is declared `WheelConfig | null` and the
  // dashboard falls back to a sample wheel, so return null instead of passing
  // null into toWheelConfig (which dereferences `.prizes` and crashes the render).
  if (!data) return null;
  return toWheelConfig(data as unknown as DbWheelRow);
}

export async function saveWheel(
  config: WheelConfig
): Promise<{ wheel: WheelConfig } | { error: string }> {
  // The editor's wheel rules (≥ 2 prizes, every prize named, one prize with
  // tickets > 0), enforced here for both data paths before anything is read or
  // written. This also refuses an empty prize set, which is almost always a
  // failed editor load and would otherwise wipe the wheel's real prizes.
  const rule = wheelRulesError(config.prizes);
  if (rule) return { error: rule };

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
    // #11: persist the per-wheel label color (null clears it → auto-pick).
    label_color: config.labelColor ?? null,
    // Per-wheel label text size; only persist known values (else Auto/null).
    label_size:
      config.labelSize && ["s", "l", "xl"].includes(config.labelSize)
        ? config.labelSize
        : null,
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

  const { data: prevPrizes } = await sb
    .from("prizes")
    .select("*")
    .eq("wheel_id", wheelId);

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

  await sb.from("prizes").delete().eq("wheel_id", wheelId);
  const { error: pErr } = await sb.from("prizes").insert(rows);
  if (pErr) {
    // Roll back to the pre-delete state so the wheel keeps its prizes.
    if (prevPrizes && prevPrizes.length > 0) {
      await sb.from("prizes").insert(prevPrizes);
    }
    return { error: "db_error" };
  }

  const saved = await getWheelById(wheelId);
  return saved ? { wheel: saved } : { error: "db_error" };
}

// Exported for the weight round-trip test (prizeWeights.test.ts).
export function prizeRow(wheelId: string, p: Prize, sortOrder: number) {
  return {
    wheel_id: wheelId,
    label: p.label.slice(0, 80) || "Prize",
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
    .eq("creator_id", user.id)
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
 * Create a new wheel. From a template it snapshots that template's prizes;
 * otherwise (#7) it starts EMPTY — zero prizes — so the editor shows a friendly
 * empty state + "Add your first prize" instead of pre-seeded sample prizes. It
 * becomes is_active only if it's the creator's first wheel.
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

  // Seed: a template snapshot, else a blank wheel with NO prizes (#7).
  let title = "New wheel";
  let subtitle: string | null = null;
  let brandColor = SAMPLE_WHEEL.brandColor ?? "#ec4899";
  let seedPrizes: Omit<Prize, "id">[] = [];

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

  const { data: wheel, error } = await sb
    .from("wheels")
    .insert({
      creator_id: user.id,
      title: source.title.slice(0, 120),
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
      source.prizes.slice(0, MAX_WHEEL_PRIZES).map((p, i) => prizeRow(wheel.id, p, i))
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
    .eq("id", id)
    .eq("creator_id", user.id);
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
    .eq("id", id)
    .eq("creator_id", user.id);
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
