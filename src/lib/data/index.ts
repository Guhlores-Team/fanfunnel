import {
  isSupabaseConfigured,
  createServiceClient,
  createClient,
} from "@/lib/supabase/server";
import { pickPrize } from "@/lib/games/wheel/engine";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import type { Prize, Rarity, SpinResult, WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type {
  AdminAccount,
  AdminOverview,
  AppRole,
  CreatorMetricsExtra,
  CreatorOverview,
  FanAccountSummary,
  FanDetail,
  FanPassView,
  RedemptionItem,
  RedemptionStatus,
} from "./types";
import { bucketByDay, clampDays } from "./metrics";
import {
  mockGetFanPass,
  mockSpin,
  mockCreatePass,
  mockGrantSpins,
  mockListFans,
  mockGetFanDetail,
  mockGetOverview,
  mockGetMetricsExtra,
  mockSetRedemptionStatus,
  mockGetWheel,
  mockSaveWheel,
  mockGetAdminOverview,
  mockUpdateAccount,
  mockCreateAccount,
} from "./mock";

function randomToken(): string {
  // URL-safe, unguessable token for a fan link.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type { FanPassView } from "./types";
export type SpinError = { error: "not_found" | "no_spins" | "no_prizes" };

// Shapes of the Supabase rows we read (keeps us off `any`).
interface DbPrizeRow {
  id: string;
  label: string;
  description: string | null;
  rarity: Rarity;
  weight: number;
  color: string | null;
  emoji: string | null;
  stock: number | null;
  sort_order: number | null;
}
interface DbWheelRow {
  id: string;
  title: string;
  subtitle: string | null;
  brand_color: string | null;
  prizes: DbPrizeRow[];
}

// ---------------------------------------------------------------------------
// Public API. Transparently uses the in-memory mock store when Supabase isn't
// configured, so local dev and previews work with zero setup.
// ---------------------------------------------------------------------------

export async function getFanPass(token: string): Promise<FanPassView | null> {
  if (!isSupabaseConfigured()) return mockGetFanPass(token);

  const sb = createServiceClient();
  const { data } = await sb
    .from("fan_passes")
    .select(
      `id, token, is_active,
       fan:fans(id, display_name, handle, spins_remaining),
       creator:profiles(display_name),
       wheel:wheels(id, title, subtitle, brand_color,
         prizes(id, label, description, rarity, weight, color, emoji, stock, sort_order))`
    )
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();

  const pass = data as unknown as {
    fan: { id: string; display_name: string | null; handle: string | null; spins_remaining: number } | null;
    creator: { display_name: string | null } | null;
    wheel: DbWheelRow | null;
  } | null;

  if (!pass || !pass.wheel || !pass.fan) return null;

  // The fan's full win history — scoped to the fan ACCOUNT, so it persists
  // across every link the creator has ever minted for them.
  const { data: wins } = await sb
    .from("spins")
    .select("prize_label, prize_rarity, created_at")
    .eq("fan_id", pass.fan.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const winRows = (wins ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
    created_at: string;
  }[];

  return {
    token,
    fanName: pass.fan.display_name ?? pass.fan.handle ?? null,
    creatorTitle: pass.creator?.display_name ?? "Creator",
    spinsRemaining: pass.fan.spins_remaining,
    wheel: toWheelConfig(pass.wheel),
    recentWins: winRows.map((w) => ({
      label: w.prize_label,
      rarity: w.prize_rarity,
      color: RARITY_COLORS[w.prize_rarity],
      at: w.created_at,
    })),
  };
}

export async function spin(token: string): Promise<SpinResult | SpinError> {
  if (!isSupabaseConfigured()) {
    return mockSpin(token);
  }

  const sb = createServiceClient();

  // 1. Atomically claim one spin from the fan account (can't be forged).
  const { data: remaining, error: claimErr } = await sb.rpc("claim_spin", {
    p_token: token,
  });
  if (claimErr || remaining === null || remaining === undefined) {
    const { data: exists } = await sb
      .from("fan_passes")
      .select("id")
      .eq("token", token)
      .maybeSingle();
    return { error: exists ? "no_spins" : "not_found" };
  }
  const spinsRemaining = remaining as number;

  // 2. Load link context (wheel + current prize stock).
  const { data } = await sb
    .from("fan_passes")
    .select(
      `id, creator_id, wheel_id, fan_id,
       wheel:wheels(id, title, subtitle, brand_color,
         prizes(id, label, description, rarity, weight, color, emoji, stock, sort_order))`
    )
    .eq("token", token)
    .single();

  const pass = data as unknown as {
    id: string;
    creator_id: string;
    wheel_id: string;
    fan_id: string;
    wheel: DbWheelRow;
  };
  const config = toWheelConfig(pass.wheel);

  // 3. Pick a prize in TS (single source of truth). If a limited prize sold
  //    out between our read and write, exclude it and re-pick.
  let chosen: { prize: Prize; index: number } | null = null;
  const excluded = new Set<string>();
  for (let attempt = 0; attempt < config.prizes.length + 1; attempt++) {
    const pool: WheelConfig = {
      ...config,
      prizes: config.prizes.map((p) =>
        excluded.has(p.id) ? { ...p, stock: 0 } : p
      ),
    };
    const pick = pickPrize(pool);
    if (pick.prize.stock === null || pick.prize.stock === undefined) {
      chosen = pick;
      break;
    }
    const { data: updated } = await sb
      .from("prizes")
      .update({ stock: pick.prize.stock - 1 })
      .eq("id", pick.prize.id)
      .gt("stock", 0)
      .select("id")
      .maybeSingle();
    if (updated) {
      chosen = pick;
      break;
    }
    excluded.add(pick.prize.id);
  }

  if (!chosen) return { error: "no_prizes" };

  // 4. Log the spin (against the fan account) + a pending redemption.
  const { data: spinRow } = await sb
    .from("spins")
    .insert({
      fan_pass_id: pass.id,
      creator_id: pass.creator_id,
      wheel_id: pass.wheel_id,
      fan_id: pass.fan_id,
      prize_id: chosen.prize.id,
      prize_label: chosen.prize.label,
      prize_rarity: chosen.prize.rarity,
    })
    .select("id")
    .single();

  if (spinRow) {
    await sb.from("redemptions").insert({
      spin_id: spinRow.id,
      creator_id: pass.creator_id,
      status: "pending",
    });
  }

  return { prize: chosen.prize, prizeIndex: chosen.index, spinsRemaining };
}

/**
 * Create a link. Without `fanId`, creates a NEW fan account. With `fanId`,
 * mints a fresh link for that SAME account (history + balance preserved) and
 * adds the granted spins to the account's balance.
 */
export async function createPass(opts: {
  name: string;
  spins: number;
  fanId?: string;
  wheelId?: string;
}): Promise<{ token: string; fanId: string } | { error: string }> {
  const spins = Math.max(0, Math.floor(opts.spins) || 0);
  if (!isSupabaseConfigured()) {
    return mockCreatePass(opts.name, spins, opts.fanId);
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  let wheelId = opts.wheelId;
  if (!wheelId) {
    const { data: w } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    wheelId = w?.id;
  }
  if (!wheelId) return { error: "no_wheel" };

  // Reuse the existing fan account or create a new one.
  let fanId = opts.fanId;
  if (fanId) {
    const { data: fan } = await sb
      .from("fans")
      .select("spins_remaining, spins_granted_total")
      .eq("id", fanId)
      .maybeSingle();
    if (!fan) return { error: "fan_not_found" };
    await sb
      .from("fans")
      .update({
        spins_remaining: fan.spins_remaining + spins,
        spins_granted_total: fan.spins_granted_total + spins,
      })
      .eq("id", fanId);
  } else {
    const { data: fan, error } = await sb
      .from("fans")
      .insert({
        creator_id: user.id,
        display_name: opts.name || "Fan",
        spins_remaining: spins,
        spins_granted_total: spins,
      })
      .select("id")
      .single();
    if (error || !fan) return { error: "db_error" };
    fanId = fan.id;
  }
  if (!fanId) return { error: "db_error" };

  const token = randomToken();
  const { error } = await sb.from("fan_passes").insert({
    token,
    creator_id: user.id,
    wheel_id: wheelId,
    fan_id: fanId,
  });
  if (error) return { error: "db_error" };
  return { token, fanId };
}

/** Top up spins on the fan account behind a token (e.g. after another tip). */
export async function grantSpins(
  token: string,
  n: number
): Promise<{ spinsRemaining: number } | { error: string }> {
  const add = Math.max(1, Math.floor(n) || 0);
  if (!isSupabaseConfigured()) {
    const remaining = mockGrantSpins(token, add);
    return remaining === null
      ? { error: "not_found" }
      : { spinsRemaining: remaining };
  }

  const sb = await createClient();
  const { data: pass } = await sb
    .from("fan_passes")
    .select("fan:fans(id, spins_remaining, spins_granted_total)")
    .eq("token", token)
    .maybeSingle();

  const fan = (pass as unknown as { fan: { id: string; spins_remaining: number; spins_granted_total: number } | null } | null)
    ?.fan;
  if (!fan) return { error: "not_found" };

  const { data: updated, error } = await sb
    .from("fans")
    .update({
      spins_remaining: fan.spins_remaining + add,
      spins_granted_total: fan.spins_granted_total + add,
    })
    .eq("id", fan.id)
    .select("spins_remaining")
    .single();
  if (error || !updated) return { error: "db_error" };
  return { spinsRemaining: updated.spins_remaining };
}

/**
 * The creator's persistent fan accounts (+ their links). Loaded by the Fans
 * tab on mount so accounts survive a page refresh.
 */
export async function listFans(): Promise<FanAccountSummary[]> {
  if (!isSupabaseConfigured()) return mockListFans();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("fans")
    .select(
      `id, display_name, handle, spins_remaining, spins_granted_total, created_at,
       fan_passes(token, created_at),
       spins(prize_label, prize_rarity, created_at)`
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as unknown as {
    id: string;
    display_name: string | null;
    handle: string | null;
    spins_remaining: number;
    spins_granted_total: number;
    fan_passes: { token: string; created_at: string }[] | null;
    spins: { prize_label: string; prize_rarity: Rarity; created_at: string }[] | null;
  }[];

  return rows.map((r) => {
    const wins = (r.spins ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      fanId: r.id,
      name: r.display_name ?? r.handle ?? "Fan",
      spinsRemaining: r.spins_remaining,
      grantedTotal: r.spins_granted_total,
      links: (r.fan_passes ?? [])
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((p) => ({ token: p.token })),
      lastWin: wins[0]
        ? { label: wins[0].prize_label, rarity: wins[0].prize_rarity, at: wins[0].created_at }
        : null,
    };
  });
}

/**
 * A single fan account's full detail, for the creator's fan drill-in. RLS keeps
 * this scoped to the owning creator, so we use the auth-scoped client.
 */
export async function getFanDetail(fanId: string): Promise<FanDetail | null> {
  if (!isSupabaseConfigured()) return mockGetFanDetail(fanId);

  const sb = await createClient();

  const { data: fan } = await sb
    .from("fans")
    .select("id, display_name, handle, spins_remaining, spins_granted_total")
    .eq("id", fanId)
    .maybeSingle();
  if (!fan) return null;

  const { data: spinRows } = await sb
    .from("spins")
    .select("prize_rarity, created_at")
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false });

  const spins = (spinRows ?? []) as { prize_rarity: Rarity; created_at: string }[];
  const totalSpins = spins.length;
  const lastActive = spins[0]?.created_at ?? null;

  const rarityCounts = new Map<Rarity, number>();
  for (const s of spins) {
    rarityCounts.set(s.prize_rarity, (rarityCounts.get(s.prize_rarity) ?? 0) + 1);
  }
  const winsByRarity = [...rarityCounts.entries()].map(([rarity, count]) => ({
    rarity,
    count,
  }));

  // Pending prizes: this fan's pending redemptions, joined back to the spin for
  // the prize label/rarity. Emoji isn't stored on spins, so it's omitted.
  const { data: pendingRows } = await sb
    .from("redemptions")
    .select("created_at, spin:spins!inner(prize_label, prize_rarity, fan_id)")
    .eq("status", "pending")
    .eq("spin.fan_id", fanId)
    .order("created_at", { ascending: false });

  const pending = (pendingRows ?? []) as unknown as {
    created_at: string;
    spin: { prize_label: string; prize_rarity: Rarity; fan_id: string } | null;
  }[];
  const pendingPrizes = pending
    .filter((r) => r.spin)
    .map((r) => ({
      label: r.spin!.prize_label,
      rarity: r.spin!.prize_rarity,
      at: r.created_at,
    }));

  const { data: passRows } = await sb
    .from("fan_passes")
    .select("token, created_at")
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false });

  const links = ((passRows ?? []) as { token: string; created_at: string }[]).map(
    (p) => ({ token: p.token, createdAt: p.created_at })
  );

  return {
    fanId: fan.id,
    name: fan.display_name ?? fan.handle ?? "Fan",
    spinsRemaining: fan.spins_remaining,
    grantedTotal: fan.spins_granted_total,
    totalSpins,
    lastActive,
    winsByRarity,
    pendingPrizes,
    links,
  };
}

// ---------------------------------------------------------------------------
// Wheel configuration (the editor reads + writes this)
// ---------------------------------------------------------------------------

// Returns the signed-in creator's wheel id, creating a default one (seeded from
// the sample) on first use so a creator always has something to edit.
async function ensureWheelId(
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

  const wheelId = await ensureWheelId(sb, user.id);
  if (!wheelId) return null;

  const { data } = await sb
    .from("wheels")
    .select(
      `id, title, subtitle, brand_color,
       prizes(id, label, description, rarity, weight, color, emoji, stock, sort_order)`
    )
    .eq("id", wheelId)
    .single();

  return toWheelConfig(data as unknown as DbWheelRow);
}

export async function saveWheel(
  config: WheelConfig
): Promise<{ wheel: WheelConfig } | { error: string }> {
  if (!isSupabaseConfigured()) return { wheel: mockSaveWheel(config) };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const wheelId = await ensureWheelId(sb, user.id);
  if (!wheelId) return { error: "no_wheel" };

  const { error: wErr } = await sb
    .from("wheels")
    .update({
      title: config.title.slice(0, 120),
      subtitle: config.subtitle?.slice(0, 200) ?? null,
      brand_color: config.brandColor ?? "#ec4899",
      updated_at: new Date().toISOString(),
    })
    .eq("id", wheelId);
  if (wErr) return { error: "db_error" };

  // Replace prizes wholesale. Spin history is safe because spins snapshot the
  // prize label/rarity and prizes.prize_id is ON DELETE SET NULL.
  await sb.from("prizes").delete().eq("wheel_id", wheelId);
  const rows = config.prizes
    .slice(0, 24)
    .map((p, i) => prizeRow(wheelId, p, i));
  if (rows.length > 0) {
    const { error: pErr } = await sb.from("prizes").insert(rows);
    if (pErr) return { error: "db_error" };
  }

  const saved = await getWheel();
  return saved ? { wheel: saved } : { error: "db_error" };
}

function prizeRow(wheelId: string, p: Prize, sortOrder: number) {
  return {
    wheel_id: wheelId,
    label: p.label.slice(0, 80) || "Prize",
    description: p.description?.slice(0, 280) ?? null,
    rarity: p.rarity,
    weight: Math.max(0, Math.floor(p.weight) || 0),
    color: p.color ?? null,
    emoji: p.emoji ?? null,
    stock: p.stock ?? null,
    sort_order: sortOrder,
  };
}

// Creator dashboard: metrics + the prize fulfilment queue.
export async function getOverview(): Promise<CreatorOverview> {
  const empty: CreatorOverview = {
    metrics: { fans: 0, spinsPlayed: 0, pending: 0, fulfilled: 0 },
    redemptions: [],
  };
  if (!isSupabaseConfigured()) return mockGetOverview();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return empty;

  const { data: reds } = await sb
    .from("redemptions")
    .select(
      `id, status, created_at,
       spin:spins(prize_label, prize_rarity, fan:fans(display_name, handle))`
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (reds ?? []) as unknown as {
    id: string;
    status: RedemptionStatus;
    created_at: string;
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
  }));

  const head = { count: "exact" as const, head: true };
  const { count: fans } = await sb
    .from("fans")
    .select("id", head)
    .eq("creator_id", user.id);
  const { count: spinsPlayed } = await sb
    .from("spins")
    .select("id", head)
    .eq("creator_id", user.id);

  return {
    metrics: {
      fans: fans ?? 0,
      spinsPlayed: spinsPlayed ?? 0,
      pending: redemptions.filter((r) => r.status === "pending").length,
      fulfilled: redemptions.filter((r) => r.status === "fulfilled").length,
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
    return { trend: bucketByDay([], n), funnel: { links: 0, spun: 0, fulfilled: 0 } };
  }

  const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const { data: spinRows } = await sb
    .from("spins")
    .select("created_at")
    .eq("creator_id", user.id)
    .gte("created_at", since);

  const timestamps = ((spinRows ?? []) as { created_at: string }[]).map(
    (r) => r.created_at
  );
  const trend = bucketByDay(timestamps, n);

  const head = { count: "exact" as const, head: true };
  const { count: links } = await sb
    .from("fan_passes")
    .select("id", head)
    .eq("creator_id", user.id);
  const { count: spun } = await sb
    .from("spins")
    .select("id", head)
    .eq("creator_id", user.id);
  const { count: fulfilled } = await sb
    .from("redemptions")
    .select("id", head)
    .eq("creator_id", user.id)
    .eq("status", "fulfilled");

  return {
    trend,
    funnel: {
      links: links ?? 0,
      spun: spun ?? 0,
      fulfilled: fulfilled ?? 0,
    },
  };
}

export async function setRedemptionStatus(
  id: string,
  status: RedemptionStatus
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockSetRedemptionStatus(id, status)
      ? { ok: true }
      : { error: "not_found" };
  }

  const sb = await createClient();
  const { error } = await sb
    .from("redemptions")
    .update({
      status,
      fulfilled_at: status === "fulfilled" ? new Date().toISOString() : null,
    })
    .eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Admin (cross-account)
// ---------------------------------------------------------------------------

async function requireAdmin(
  sb: Awaited<ReturnType<typeof createClient>>
): Promise<boolean> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return false;
  const { data } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  return data?.role === "admin";
}

export async function getAdminOverview(): Promise<AdminOverview | null> {
  if (!isSupabaseConfigured()) return mockGetAdminOverview();

  const sb = await createClient();
  const { data, error } = await sb.rpc("admin_account_stats");
  // The function returns rows only to admins; empty ⇒ not authorized.
  if (error || !data || data.length === 0) return null;

  const rows = data as {
    id: string;
    email: string | null;
    display_name: string | null;
    role: AppRole;
    is_active: boolean;
    features: Record<string, boolean> | null;
    wheels: number;
    fans: number;
    spins: number;
    pending: number;
  }[];

  const accounts: AdminAccount[] = rows.map((r) => ({
    id: r.id,
    email: r.email ?? "",
    displayName: r.display_name ?? r.email ?? "Creator",
    role: r.role,
    isActive: r.is_active,
    features: r.features ?? {},
    wheels: Number(r.wheels),
    fans: Number(r.fans),
    spins: Number(r.spins),
    pending: Number(r.pending),
  }));

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

export async function updateAccount(
  id: string,
  patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockUpdateAccount(id, patch) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  if (!(await requireAdmin(sb))) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if (patch.role) upd.role = patch.role;
  if (typeof patch.isActive === "boolean") upd.is_active = patch.isActive;
  if (patch.features) upd.features = patch.features;
  if (Object.keys(upd).length === 0) return { ok: true };

  const { error } = await sb.from("profiles").update(upd).eq("id", id);
  return error ? { error: "db_error" } : { ok: true };
}

export async function createCreatorAccount(
  email: string,
  password: string,
  displayName: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    mockCreateAccount(email, displayName);
    return { ok: true };
  }

  const sb = await createClient();
  if (!(await requireAdmin(sb))) return { error: "unauthorized" };

  // Service role is required to create a user without a sign-up flow.
  const svc = createServiceClient();
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName || email },
  });
  if (error || !data.user) return { error: error?.message ?? "create_failed" };

  await svc
    .from("profiles")
    .update({ display_name: displayName || email })
    .eq("id", data.user.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
function toWheelConfig(wheel: DbWheelRow): WheelConfig {
  const prizes: Prize[] = (wheel.prizes ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description ?? undefined,
      rarity: p.rarity,
      weight: p.weight,
      color: p.color ?? RARITY_COLORS[p.rarity],
      emoji: p.emoji ?? undefined,
      stock: p.stock ?? null,
    }));

  return {
    id: wheel.id,
    title: wheel.title,
    subtitle: wheel.subtitle ?? undefined,
    brandColor: wheel.brand_color ?? "#ec4899",
    prizes,
  };
}
