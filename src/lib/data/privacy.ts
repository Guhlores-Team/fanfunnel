// Data layer — privacy self-service (migration 0054).
//
// Fan side: the fan token is the only credential (fans have no account), so
// these run with the service role, and EVERY read and write is pinned to the
// one (fan_id, creator_id) pair the token resolves to. Nothing another fan
// owns, and none of the creator's private fields, is ever selected.
//
// Creator side: the export runs on the creator's own session client (anon key
// + RLS) AND filters every table to rows the creator owns, so an agency member
// whose RLS view spans other creators still only exports their own account.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import type { Json } from "./db.types";
import {
  CREATOR_EXPORT_ABOUT,
  CREATOR_EXPORT_FORMAT,
  FAN_EXPORT_ABOUT,
  FAN_EXPORT_FORMAT,
  maskToken,
  type CreatorDataExport,
  type FanDataExport,
} from "@/lib/privacy/exportTypes";
import {
  mockDeleteFanData,
  mockExportCreatorData,
  mockExportFanData,
  mockGetFanLinkStatus,
} from "./mock";

type Svc = ReturnType<typeof createServiceClient>;
export type FanLinkStatus = "creator_closed" | "fan_deleted";

/** Tokens are opaque random strings; anything else is refused before any read. */
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(token);
}

/** SHA-256 of a link token: what link_tombstones stores instead of the token. */
export const tokenHash = (token: string) => sha256Hex(token);

/** The fan + creator behind a token, whatever the link's state (a paused or
 *  blocked fan keeps the right to see and delete their data). */
async function resolveAnyToken(
  svc: Svc,
  token: string
): Promise<{ fanId: string; creatorId: string } | null> {
  const { data } = await svc
    .from("fan_passes")
    .select("fan_id, creator_id")
    .eq("token", token)
    .maybeSingle();
  const row = data as { fan_id: string; creator_id: string } | null;
  return row ? { fanId: row.fan_id, creatorId: row.creator_id } : null;
}

const PAGE = 1000;
/** Read every row of a paged query, up to `cap` rows. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  cap = 50_000
): Promise<{ rows: T[]; truncated: boolean; failed: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await page(from, Math.min(from + PAGE, cap) - 1);
    if (error) return { rows, truncated: false, failed: true };
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false, failed: false };
  }
  return { rows, truncated: true, failed: false };
}

// ---------------------------------------------------------------------------
// Fan: why a link stopped working
// ---------------------------------------------------------------------------

/**
 * For a token whose fan page can't load: why it stopped working, when its
 * tombstone says (the creator closed their account, or the fan deleted their
 * data). Anything else (paused, blocked, switched off, unknown) is null and
 * the page 404s as before.
 */
export async function getFanLinkStatus(token: string): Promise<FanLinkStatus | null> {
  if (!isPlausibleToken(token)) return null;
  if (!isSupabaseConfigured()) return mockGetFanLinkStatus(token);
  const { data } = await createServiceClient()
    .from("link_tombstones")
    .select("reason")
    .eq("token_hash", await tokenHash(token))
    .maybeSingle();
  const reason = (data as { reason?: string } | null)?.reason;
  return reason === "creator_closed" || reason === "fan_deleted" ? reason : null;
}

// ---------------------------------------------------------------------------
// Fan: Download my data
// ---------------------------------------------------------------------------

export async function exportFanData(token: string): Promise<FanDataExport | null> {
  if (!isPlausibleToken(token)) return null;
  if (!isSupabaseConfigured()) return mockExportFanData(token);

  const svc = createServiceClient();
  const who = await resolveAnyToken(svc, token);
  if (!who) return null;
  const { fanId, creatorId } = who;

  const [fanRes, creatorRes, passesRes, grantsRes, wishRes, msgRes, refRes] = await Promise.all([
    svc
      .from("fans")
      .select(
        "display_name, handle, created_at, spins_remaining, spins_granted_total, last_spin_at, referral_code, referred_by_fan_id, acked_at, leaderboard_opt_in"
      )
      .eq("id", fanId)
      .eq("creator_id", creatorId)
      .maybeSingle(),
    svc.from("profiles").select("display_name").eq("id", creatorId).maybeSingle(),
    svc
      .from("fan_passes")
      .select(
        "token, created_at, is_active, self_excluded_at, spins_remaining, spins_granted_total, last_spin_at, wheel:wheels(title)"
      )
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: true }),
    svc
      .from("grants")
      .select("created_at, spins, bonus_spins")
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: true }),
    svc
      .from("wishlists")
      .select("prize_label, prize_rarity, created_at")
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: true }),
    svc
      .from("messages")
      .select("body, created_at")
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId)
      .eq("sender", "fan")
      .order("created_at", { ascending: true }),
    svc
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_fan_id", fanId)
      .eq("creator_id", creatorId),
  ]);
  const fan = fanRes.data as {
    display_name: string | null;
    handle: string | null;
    created_at: string | null;
    spins_remaining: number;
    spins_granted_total: number;
    last_spin_at: string | null;
    referral_code: string | null;
    referred_by_fan_id: string | null;
    acked_at: string | null;
    leaderboard_opt_in: boolean | null;
  } | null;
  if (fanRes.error || !fan) return null;

  const spins = await fetchAll<{
    id: string;
    created_at: string;
    prize_label: string;
    prize_rarity: string;
    share_id: string | null;
    server_seed: string | null;
    server_seed_hash: string | null;
    client_seed: string | null;
    nonce: number | null;
    seed_commitment: string | null;
    fair_version: number | null;
    pool_hash: string | null;
    pool_snapshot: Json | null;
    fair_trace: Json | null;
    wheel: { title: string } | null;
  }>((from, to) =>
    svc
      .from("spins")
      .select(
        "id, created_at, prize_label, prize_rarity, share_id, server_seed, server_seed_hash, client_seed, nonce, seed_commitment, fair_version, pool_hash, pool_snapshot, fair_trace, wheel:wheels(title)"
      )
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: false })
      .range(from, to)
  );

  // Prizes: the redemption rows of THIS fan's spins (status only; the
  // creator's notes and internal due date stay out).
  const prizes: FanDataExport["prizes"] = [];
  const labelBySpin = new Map(spins.rows.map((s) => [s.id, s.prize_label]));
  const ids = [...labelBySpin.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await svc
      .from("redemptions")
      .select("spin_id, status, created_at, fulfilled_at")
      .eq("creator_id", creatorId)
      .in("spin_id", ids.slice(i, i + 200));
    for (const r of (data ?? []) as {
      spin_id: string;
      status: string;
      created_at: string;
      fulfilled_at: string | null;
    }[]) {
      prizes.push({
        spinId: r.spin_id,
        prize: labelBySpin.get(r.spin_id) ?? "Prize",
        status: r.status,
        wonAt: r.created_at,
        fulfilledAt: r.fulfilled_at,
      });
    }
  }

  const passes = (passesRes.data ?? []) as unknown as {
    token: string;
    created_at: string | null;
    is_active: boolean;
    self_excluded_at: string | null;
    spins_remaining: number;
    spins_granted_total: number;
    last_spin_at: string | null;
    wheel: { title: string } | null;
  }[];

  return {
    format: FAN_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    about: FAN_EXPORT_ABOUT,
    creator: {
      displayName: (creatorRes.data as { display_name: string | null } | null)?.display_name ?? null,
    },
    profile: {
      displayName: fan.display_name,
      handle: fan.handle,
      joinedAt: fan.created_at,
      spinsRemaining: fan.spins_remaining,
      spinsGrantedTotal: fan.spins_granted_total,
      lastSpinAt: fan.last_spin_at,
      referralCode: fan.referral_code,
      joinedThroughAReferral: fan.referred_by_fan_id !== null,
      friendsReferred: refRes.count ?? 0,
    },
    consents: {
      ageAndTermsAcceptedAt: fan.acked_at,
      leaderboardOptIn: fan.leaderboard_opt_in === true,
    },
    links: passes.map((p) => ({
      linkEndsWith: maskToken(p.token),
      isThisLink: p.token === token,
      wheel: p.wheel?.title ?? null,
      createdAt: p.created_at,
      active: p.is_active,
      pausedByYouAt: p.self_excluded_at,
      spinsRemaining: p.spins_remaining,
      spinsGrantedTotal: p.spins_granted_total,
      lastSpinAt: p.last_spin_at,
    })),
    topUps: ((grantsRes.data ?? []) as { created_at: string; spins: number; bonus_spins: number }[]).map(
      (g) => ({ at: g.created_at, spins: g.spins, bonusSpins: g.bonus_spins })
    ),
    spins: spins.rows.map((s) => ({
      id: s.id,
      at: s.created_at,
      prize: s.prize_label,
      rarity: s.prize_rarity,
      wheel: s.wheel?.title ?? null,
      shareId: s.share_id,
      fairness: {
        version: s.fair_version,
        serverSeed: s.server_seed,
        serverSeedHash: s.server_seed_hash,
        clientSeed: s.client_seed,
        nonce: s.nonce,
        seedCommitment: s.seed_commitment,
        poolHash: s.pool_hash,
        poolSnapshot: s.pool_snapshot,
        trace: s.fair_trace,
      },
    })),
    prizes,
    wishlist: ((wishRes.data ?? []) as { prize_label: string; prize_rarity: string; created_at: string }[]).map(
      (w) => ({ prize: w.prize_label, rarity: w.prize_rarity, addedAt: w.created_at })
    ),
    messagesYouSent: ((msgRes.data ?? []) as { body: string; created_at: string }[]).map((m) => ({
      at: m.created_at,
      body: m.body,
    })),
  };
}

// ---------------------------------------------------------------------------
// Fan: Delete my data
// ---------------------------------------------------------------------------

/**
 * Permanently delete the fan behind `token`, with the creator-side deleteFan
 * semantics: the fans row goes, and the schema's foreign keys remove their
 * links, top-ups, chat, wishlist and referrals and anonymize their spins (0054:
 * spins.fan_id and fan_pass_id → NULL), so the creator's stats, fulfilment
 * queue and fairness history stay valid without pointing at the fan.
 *
 * Afterwards (best effort, the deletion already happened): each of the fan's
 * links gets a tombstone so it can say "deleted at your request", the fan's
 * tokens are scrubbed from any safety reports they filed, and the creator gets
 * an in-app notice that carries no PII (only how many spins stay).
 */
export async function deleteFanData(
  token: string
): Promise<{ ok: true; spinsKept: number } | { error: string }> {
  if (!isPlausibleToken(token)) return { error: "not_found" };
  if (!isSupabaseConfigured()) return mockDeleteFanData(token);

  const svc = createServiceClient();
  const who = await resolveAnyToken(svc, token);
  if (!who) return { error: "not_found" };
  const { fanId, creatorId } = who;

  const [{ data: passRows }, { count }] = await Promise.all([
    svc.from("fan_passes").select("token").eq("fan_id", fanId).eq("creator_id", creatorId),
    svc
      .from("spins")
      .select("id", { count: "exact", head: true })
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId),
  ]);
  const tokens = [...new Set([token, ...((passRows ?? []) as { token: string }[]).map((p) => p.token)])];

  const { error } = await svc.from("fans").delete().eq("id", fanId).eq("creator_id", creatorId);
  if (error) {
    console.error("deleteFanData: delete failed", error.message);
    return { error: "db_error" };
  }
  const spinsKept = count ?? 0;

  const hashes = await Promise.all(tokens.map(tokenHash));
  const after = await Promise.all([
    svc
      .from("link_tombstones")
      .upsert(
        hashes.map((h) => ({ token_hash: h, reason: "fan_deleted" })),
        { onConflict: "token_hash", ignoreDuplicates: true }
      ),
    svc.from("creator_reports").update({ token: null }).in("token", tokens),
    svc.from("creator_notices").insert({
      creator_id: creatorId,
      kind: "fan_deleted_data",
      details: { spins_kept: spinsKept },
    }),
  ]);
  for (const r of after) {
    if (r.error) console.error("deleteFanData: follow-up write failed", r.error.message);
  }
  return { ok: true, spinsKept };
}

// ---------------------------------------------------------------------------
// Creator: Download my data
// ---------------------------------------------------------------------------

/** Tables exported per creator: [section, table, owner column]. */
const CREATOR_TABLES: [string, string, string][] = [
  ["wheels", "wheels", "creator_id"],
  ["campaigns", "campaigns", "creator_id"],
  ["campaign_packs", "campaign_packs", "creator_id"],
  ["prize_templates", "prize_templates", "creator_id"],
  ["wheel_templates", "wheel_templates", "creator_id"],
  ["dm_templates", "dm_templates", "creator_id"],
  ["happy_hours", "happy_hours", "creator_id"],
  ["webhooks", "webhooks", "creator_id"],
  ["fans", "fans", "creator_id"],
  ["grants", "grants", "creator_id"],
  ["spins", "spins", "creator_id"],
  ["redemptions", "redemptions", "creator_id"],
  ["referrals", "referrals", "creator_id"],
  ["messages", "messages", "creator_id"],
  ["wishlists", "wishlists", "creator_id"],
  ["autopilot_dismissals", "autopilot_dismissals", "creator_id"],
  ["creator_notices", "creator_notices", "creator_id"],
  ["access_request", "creator_applications", "profile_id"],
  ["agency_memberships", "org_members", "profile_id"],
  ["agencies_owned", "orgs", "owner_id"],
];

/**
 * Everything the signed-in creator owns, read with THEIR session client (RLS
 * applies) and filtered to their own id. No service role. Fan link tokens are
 * shortened and the pre-committed next-spin seeds are left out.
 */
export async function exportCreatorData(): Promise<CreatorDataExport | null> {
  if (!isSupabaseConfigured()) return mockExportCreatorData();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const uid = user.id;

  const { data: profile } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
  const sections: Record<string, Record<string, unknown>[]> = {};
  const truncated: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    CREATOR_TABLES.map(async ([section, table, owner]) => {
      const res = await fetchAll<Record<string, unknown>>((from, to) =>
        // A dynamic table name: the rows are untyped on purpose.
        (sb.from(table as "wheels") as unknown as {
          select: (c: string) => {
            eq: (k: string, v: string) => {
              range: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
            };
          };
        })
          .select("*")
          .eq(owner, uid)
          .range(from, to)
      );
      sections[section] = res.rows;
      if (res.truncated) truncated.push(section);
      if (res.failed) failed.push(section);
    })
  );

  // Prizes hang off wheels; links carry secrets (token, next-spin seed).
  const wheelIds = (sections.wheels ?? []).map((w) => String(w.id));
  const prizes: Record<string, unknown>[] = [];
  for (let i = 0; i < wheelIds.length; i += 100) {
    const { data } = await sb.from("prizes").select("*").in("wheel_id", wheelIds.slice(i, i + 100));
    prizes.push(...((data ?? []) as Record<string, unknown>[]));
  }
  sections.prizes = prizes;

  const links = await fetchAll<Record<string, unknown>>((from, to) =>
    sb
      .from("fan_passes")
      .select(
        "id, token, fan_id, wheel_id, campaign_id, created_at, is_active, self_excluded_at, spins_remaining, spins_granted_total, last_spin_at, next_server_seed_hash"
      )
      .eq("creator_id", uid)
      .range(from, to)
  );
  sections.fan_links = links.rows.map(({ token, ...rest }) => ({
    ...rest,
    link_ends_with: maskToken(typeof token === "string" ? token : ""),
  }));
  if (links.truncated) truncated.push("fan_links");

  if (failed.length > 0) console.error("exportCreatorData: sections failed", failed);

  return {
    format: CREATOR_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    about: CREATOR_EXPORT_ABOUT,
    account: {
      ...(profile ?? {}),
      id: uid,
      email: user.email ?? null,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at ?? null,
      two_factor: (user.factors ?? []).map((f) => ({
        id: f.id,
        type: f.factor_type,
        name: f.friendly_name ?? null,
        status: f.status,
        created_at: f.created_at,
      })),
    },
    sections,
    truncated,
  };
}
