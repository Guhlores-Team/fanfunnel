// Data layer — boosts: happy hours, share cards, provably-fair verification,
// wishlists, the public leaderboard and the recent-wins ticker.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import type { Rarity } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type {
  ShareCardData,
  WishlistDemand,
  LeaderboardView,
  LeaderboardEntry,
  HappyHour,
  SpinVerification,
} from "./types";
import {
  mockListHappyHours,
  mockCreateHappyHour,
  mockDeleteHappyHour,
  mockGetShareCard,
  mockAddWishlist,
  mockRemoveWishlist,
  mockGetWishlistDemand,
  mockSetLeaderboardEnabled,
  mockSetFanLeaderboardOptIn,
  mockGetLeaderboard,
  mockGetRecentWins,
  mockGetSpinVerification,
} from "./mock";
import { resolveFanByToken } from "./fans";

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
    .select(`${SELECT}, seed_commitment, prize_id, fair_version, pool_snapshot, pool_hash, fair_trace`)
    .eq("share_id", shareId)
    .maybeSingle();
  // Pre-0047 DB (no fairness-v3 columns yet): every spin verifies as v1/v2.
  if (res.error) {
    res = await sb.from("spins").select(`${SELECT}, seed_commitment`).eq("share_id", shareId).maybeSingle();
  }
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
    prize_id?: string | null;
    fair_version?: number | null;
    pool_snapshot?: unknown;
    pool_hash?: string | null;
    fair_trace?: unknown;
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
    fairVersion: row.fair_version ?? null,
    ...(row.fair_version === 3
      ? {
          v3: {
            prizeId: row.prize_id ?? null,
            poolSnapshot: row.pool_snapshot ?? null,
            poolHash: row.pool_hash ?? null,
            fairTrace: row.fair_trace ?? null,
          },
        }
      : {}),
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
