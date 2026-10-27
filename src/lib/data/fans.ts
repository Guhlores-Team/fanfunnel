// Data layer — fans and grants: creator CRM, fan detail, grant edits, fan
// moderation, and the token-scoped fan actions (ack, self-exclude, report).
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import type { Rarity } from "@/lib/games/wheel/types";
import type { FanAccountSummary, FanCampaignBreakdown, FanDetail, Grant } from "./types";
import {
  mockGrantSpins,
  mockListFans,
  mockGetFanDetail,
  mockDeleteFan,
  mockUpdateFanMeta,
  mockEditGrant,
  mockAckFan,
  mockSelfExclude,
  mockSetFanBlocked,
  mockReportCreator,
} from "./mock";
import { clampInt, creatorOwnsCampaign } from "./shared";
import { resolveWheelId } from "./wheels";
import { pickGrantPass } from "./grantPass";
import { readFansOnBreak } from "./playGuard";
import { fanEngagementAllowed, isOnBreak } from "@/lib/play/playGuard";
import { fanVisitsLast7, visitsByFan } from "./checkins";

/** Edit an existing grant's spins / amount / campaign after the fact. Adjusts
 *  the fan's balance by the spin delta (floored at 0) so totals stay consistent. */
export async function editGrant(
  grantId: string,
  patch: { spins?: number; amountCents?: number; campaignId?: string | null }
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockEditGrant(grantId, patch);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { data: gRow } = await sb
    .from("grants")
    .select("id, fan_id, fan_pass_id, spins, amount_cents, campaign_id")
    .eq("id", grantId)
    .eq("creator_id", user.id)
    .maybeSingle();
  const grant = gRow as
    | {
        id: string;
        fan_id: string;
        fan_pass_id: string | null;
        spins: number;
        amount_cents: number;
        campaign_id: string | null;
      }
    | null;
  if (!grant) return { error: "not_found" };

  // The grant update and the two aggregate updates below are separate
  // statements; wire a best-effort compensation so a later failure can't leave
  // the grant changed while the fan/pass balances stay stale.
  const rollbacks: Array<() => Promise<void>> = [];
  const fail = async (error: string): Promise<{ error: string }> => {
    for (const undo of rollbacks.reverse()) {
      try {
        await undo();
      } catch {
        /* best-effort */
      }
    }
    return { error };
  };

  // Validate finite, int4-bounded integers up front so a non-finite patch or an
  // overflowing balance can't be silently written and desync the aggregates.
  const update: Record<string, unknown> = {};
  if (patch.amountCents != null) {
    if (!Number.isFinite(patch.amountCents)) return { error: "invalid" };
    update.amount_cents = clampInt(Math.round(patch.amountCents), 0);
  }
  if (patch.campaignId !== undefined) {
    // Re-tagging to another campaign must stay within this creator's tenant.
    if (!(await creatorOwnsCampaign(sb, user.id, patch.campaignId)))
      return { error: "campaign_not_found" };
    update.campaign_id = patch.campaignId;
  }

  let delta = 0;
  if (patch.spins != null) {
    if (!Number.isFinite(patch.spins)) return { error: "invalid" };
    const newSpins = clampInt(Math.floor(patch.spins), 0);
    delta = newSpins - grant.spins;
    update.spins = newSpins;
  }

  // The pass this grant's spins landed on. When that row is gone (fan_pass_id
  // is ON DELETE SET NULL) or no longer active, fall back to the fan's oldest
  // active pass — the 0020 attribution convention — so the spins stay
  // spendable. The choice is pickGrantPass, which getFanDetail also uses for
  // the drawer's preview. Scoped to this creator like every other pass read.
  type PassBal = { id: string; is_active: boolean; spins_remaining: number; spins_granted_total: number };
  const PASS_COLS = "id, is_active, spins_remaining, spins_granted_total";
  // A lookup error is not "pass missing": falling back on one would move the
  // delta onto another wheel while the grant keeps its fan_pass_id.
  const readPass = async (): Promise<PassBal | null | "db_error"> => {
    const { data: rows, error: pErr } = await sb
      .from("fan_passes")
      .select(PASS_COLS)
      .eq("fan_id", grant.fan_id)
      .eq("creator_id", user.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (pErr) return "db_error";
    const oldestFirst = ((rows ?? []) as PassBal[]).map((p) => ({ ...p, isActive: p.is_active }));
    return pickGrantPass(oldestFirst, grant.fan_pass_id);
  };

  // Balance first, grant row second: a refused or failed balance change must
  // leave the grant untouched, and the fan-level aggregate is the 0035
  // trigger's alone (it fires on the pass write below), so editGrant never
  // writes fans.spins_remaining.
  if (delta !== 0) {
    // Compare-and-swap on the balance just read: a spin landing between the
    // read and the write (claim_spin runs concurrently) makes the update match
    // zero rows, and we re-read and re-check instead of overwriting it. The
    // over-cut check runs on every attempt, so spins the fan has already spun
    // are never un-granted — a cut deeper than the pass's unspent balance is
    // refused (insufficient_spins), never clamped. Clamping silently dropped
    // the deficit and re-growing the grant then minted already-spent spins.
    let applied: PassBal | null = null;
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      const pass = await readPass();
      if (pass === "db_error") return { error: "db_error" };
      if (!pass) return { error: "no_active_pass" };
      if (pass.spins_remaining + delta < 0) return { error: "insufficient_spins" };
      const { data: updated, error: pErr } = await sb
        .from("fan_passes")
        .update({
          spins_remaining: pass.spins_remaining + delta,
          spins_granted_total: clampInt(pass.spins_granted_total + delta, 0),
        })
        .eq("id", pass.id)
        .eq("spins_remaining", pass.spins_remaining)
        .eq("spins_granted_total", pass.spins_granted_total)
        .select("id")
        .maybeSingle();
      if (pErr) return { error: "db_error" };
      if (updated) applied = pass;
    }
    if (!applied) return { error: "db_error" }; // balance kept moving under us
    // Undo the balance change if the grant update below fails: same
    // compare-and-swap on the balance as it is THEN (a spin may have landed
    // since), up to three attempts. Skipped when it would take the pass
    // negative (the fan already spent the spins); a skip or a miss is logged.
    const passId = applied.id;
    rollbacks.push(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: cur } = await sb
          .from("fan_passes")
          .select(PASS_COLS)
          .eq("id", passId)
          .maybeSingle();
        const c = cur as PassBal | null;
        if (!c || c.spins_remaining - delta < 0) break;
        const { data: undone } = await sb
          .from("fan_passes")
          .update({
            spins_remaining: c.spins_remaining - delta,
            spins_granted_total: clampInt(c.spins_granted_total - delta, 0),
          })
          .eq("id", passId)
          .eq("spins_remaining", c.spins_remaining)
          .eq("spins_granted_total", c.spins_granted_total)
          .select("id")
          .maybeSingle();
        if (undone) return;
      }
      console.error("editGrant: balance rollback could not be applied", { grantId, passId, delta });
    });
  }

  const { error: grantErr } = await sb.from("grants").update(update).eq("id", grantId);
  if (grantErr) return fail("db_error");

  return { ok: true };
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
  type PassBal = { id: string; spins_remaining: number; spins_granted_total: number };

  // Top up THIS pass (per-wheel). The fan-level aggregate is the 0035 trigger's
  // alone: it fires on this write, so no fans update here (a value read before
  // the write overwrote any spin that landed in between). The pass write is a
  // compare-and-swap on the balance just read for the same reason: claim_spin
  // runs concurrently, and a spin landing between our read and our write makes
  // the update match zero rows, so we re-read and retry instead of losing it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: pass } = await sb
      .from("fan_passes")
      .select("id, spins_remaining, spins_granted_total")
      .eq("token", token)
      .maybeSingle();
    const p = pass as PassBal | null;
    if (!p) return { error: "not_found" };

    const { data: updated, error } = await sb
      .from("fan_passes")
      .update({
        spins_remaining: p.spins_remaining + add,
        spins_granted_total: p.spins_granted_total + add,
      })
      .eq("id", p.id)
      .eq("spins_remaining", p.spins_remaining)
      .eq("spins_granted_total", p.spins_granted_total)
      .select("spins_remaining")
      .maybeSingle();
    if (error) return { error: "db_error" };
    if (updated) return { spinsRemaining: (updated as { spins_remaining: number }).spins_remaining };
  }
  return { error: "db_error" }; // balance kept moving under us
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

  // RM-6: who is on a break (read on its own, so a DB without 0049 still lists).
  const onBreakP = readFansOnBreak(sb, user.id);
  const TAIL = `spins(prize_label, prize_rarity, created_at),
       grants(amount_cents, campaign_id, campaign:campaigns(name))`;
  // Per-wheel pass columns come from migration 0020. If they're not present yet,
  // fall back to the legacy pass select so the Fans tab still loads (without the
  // per-wheel breakdown) instead of returning nothing.
  const primary = await sb
    .from("fans")
    .select(
      `id, display_name, handle, spins_remaining, spins_granted_total, tags, created_at, blocked_at,
       fan_passes(token, created_at, spins_remaining, wheel_id, is_active, self_excluded_at, wheel:wheels(title), campaign:campaigns(name)),
       ${TAIL}`
    )
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });
  let data: unknown = primary.data;
  if (primary.error) {
    const legacy = await sb
      .from("fans")
      .select(
        `id, display_name, handle, spins_remaining, spins_granted_total, tags, created_at,
         fan_passes(token, created_at),
         ${TAIL}`
      )
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false });
    data = legacy.data;
  }

  const visits = await visitsByFan(sb, user.id);
  const rows = (data ?? []) as unknown as {
    id: string;
    display_name: string | null;
    handle: string | null;
    spins_remaining: number;
    spins_granted_total: number;
    tags: string[] | null;
    blocked_at?: string | null; // absent on the legacy select
    fan_passes:
      | {
          token: string;
          created_at: string;
          spins_remaining?: number; // per-wheel fields are absent pre-0020
          wheel_id?: string;
          is_active?: boolean; // absent on the legacy select
          self_excluded_at?: string | null;
          wheel?: { title: string } | null;
          campaign?: { name: string } | null;
        }[]
      | null;
    spins: { prize_label: string; prize_rarity: Rarity; created_at: string }[] | null;
    grants:
      | { amount_cents: number; campaign_id: string | null; campaign: { name: string } | null }[]
      | null;
  }[];
  const onBreak = await onBreakP;

  return rows.map((r) => {
    const wins = (r.spins ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    const grants = r.grants ?? [];
    const totalSpent = grants.reduce((s, g) => s + g.amount_cents, 0);
    const campaignNames: string[] = [];
    const seen = new Set<string>();
    for (const g of grants) {
      if (!g.campaign_id || !g.campaign?.name) continue;
      if (seen.has(g.campaign_id)) continue;
      seen.add(g.campaign_id);
      campaignNames.push(g.campaign.name);
    }
    const links = (r.fan_passes ?? [])
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    // Only build per-wheel passes when the 0020 columns are present; pre-0020
    // (legacy fallback) we leave passes empty and the card shows the single link.
    const passes = links
      .filter((p): p is typeof p & { wheel_id: string } => typeof p.wheel_id === "string")
      .map((p) => ({
        token: p.token,
        wheelId: p.wheel_id,
        wheelTitle: p.wheel?.title ?? "Wheel",
        campaignName: p.campaign?.name ?? null,
        spinsRemaining: p.spins_remaining ?? 0,
      }));
    return {
      fanId: r.id,
      name: r.display_name ?? r.handle ?? "Fan",
      spinsRemaining: r.spins_remaining,
      grantedTotal: r.spins_granted_total,
      primaryToken: links[0]?.token ?? null,
      totalSpent,
      campaignNames,
      tags: r.tags ?? [],
      links: links.map((p) => ({ token: p.token })),
      passes,
      lastWin: wins[0]
        ? { label: wins[0].prize_label, rarity: wins[0].prize_rarity, at: wins[0].created_at }
        : null,
      blocked: !!r.blocked_at,
      selfExcluded: links.some((p) => !!p.self_excluded_at),
      // The legacy select can't tell a paused link from a live one, so it
      // offers none (is_active is undefined there).
      activeToken: links.find((p) => p.is_active === true && !p.self_excluded_at)?.token ?? null,
      // RM-6: only the break state, never the fan's reminder or counts.
      breakUntil: onBreak.get(r.id) ?? null,
      visits7: visits.get(r.id) ?? 0,
    };
  });
}

// --- Creator CRM: whales (top LTV) + dormant fans to win back ----------------

export interface CrmFan {
  fanId: string;
  name: string;
  totalSpent: number; // cents (lifetime = LTV)
  spinsRemaining: number;
  lastActiveAt: string | null;
  daysSince: number | null;
  primaryToken: string | null;
}
export interface CreatorCrm {
  totalLtv: number; // cents across all fans
  avgLtv: number; // cents per fan with spend
  whales: CrmFan[]; // top spenders, desc
  dormant: CrmFan[]; // spent before, quiet 14+ days
}

/**
 * Whale detection + win-back, derived from existing fan data (no new tables):
 *   • LTV per fan = sum of their grant amounts (real money tied to their spins).
 *   • Whales = fans ranked by LTV desc (your highest-value relationships).
 *   • Dormant = fans who HAVE spent (LTV > 0) but whose last win/activity is
 *     14+ days ago — the cheapest revenue is a fan you already converted.
 *     Spend safety: a fan the creator blocked, a fan who paused (self-excluded)
 *     a link, and a fan with no active link are never suggested.
 * The link offered on any row is the fan's newest ACTIVE link (never a paused
 * one), and none at all for a blocked or self-excluded fan.
 */
export async function getCreatorCrm(): Promise<CreatorCrm> {
  const fans = await listFans();
  const now = Date.now();
  const DAY = 86_400_000;
  // F6 engagement gate: never suggest a fan who is blocked, paused or on a break.
  const contactable = (f: FanAccountSummary) => fanEngagementAllowed(f) && f.activeToken !== null;

  const enrich = (f: FanAccountSummary): CrmFan => {
    const lastActiveAt = f.lastWin?.at ?? null;
    const daysSince = lastActiveAt
      ? Math.floor((now - new Date(lastActiveAt).getTime()) / DAY)
      : null;
    return {
      fanId: f.fanId,
      name: f.name,
      totalSpent: f.totalSpent,
      spinsRemaining: f.spinsRemaining,
      lastActiveAt,
      daysSince,
      primaryToken: contactable(f) ? f.activeToken : null,
    };
  };

  const all = fans.map(enrich);
  const spenders = all.filter((f) => f.totalSpent > 0);
  const totalLtv = spenders.reduce((s, f) => s + f.totalSpent, 0);
  const avgLtv = spenders.length ? Math.round(totalLtv / spenders.length) : 0;

  const whales = [...spenders].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 10);
  const dormant = spenders
    // primaryToken is null exactly when the fan isn't contactable (see enrich).
    .filter((f) => f.primaryToken !== null && f.daysSince !== null && f.daysSince >= 14)
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 20);

  return { totalLtv, avgLtv, whales, dormant };
}

/**
 * A single fan account's full detail, for the creator's fan drill-in. RLS keeps
 * this scoped to the owning creator, so we use the auth-scoped client.
 */
export async function getFanDetail(fanId: string): Promise<FanDetail | null> {
  if (!isSupabaseConfigured()) return mockGetFanDetail(fanId);

  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;

  const { data: fan } = await sb
    .from("fans")
    .select("id, display_name, handle, spins_remaining, spins_granted_total, notes, tags, blocked_at")
    .eq("id", fanId)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!fan) return null;

  const [{ data: spinRows }, breakRes] = await Promise.all([
    sb
      .from("spins")
      .select("prize_label, prize_rarity, campaign_id, created_at")
      .eq("fan_id", fanId)
      .order("created_at", { ascending: false }),
    // RM-6: read on its own so a DB without 0049 still opens the drawer.
    Promise.resolve(sb.from("fans").select("break_until").eq("id", fanId).maybeSingle()).catch(() => null),
  ]);
  const breakUntil = (breakRes?.data as { break_until?: string | null } | null)?.break_until ?? null;

  const spins = (spinRows ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
    campaign_id: string | null;
    created_at: string;
  }[];
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

  // Every pass, oldest first in editGrant's order: the links list (newest
  // first) and each grant's preview balance come from this one read.
  const { data: passRows } = await sb
    .from("fan_passes")
    .select("id, token, created_at, is_active, spins_remaining, wheel:wheels(title)")
    .eq("fan_id", fanId)
    .eq("creator_id", user.id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  const passesOldestFirst = ((passRows ?? []) as unknown as {
    id: string;
    token: string;
    created_at: string;
    is_active: boolean;
    spins_remaining: number;
    wheel?: { title: string } | null;
  }[]).map((p) => ({ ...p, isActive: p.is_active }));

  const links = passesOldestFirst
    .slice()
    .reverse()
    .map((p) => ({ token: p.token, createdAt: p.created_at }));

  // This fan's grants, newest first, with campaign name resolved via a join.
  const { data: grantRows } = await sb
    .from("grants")
    .select("id, fan_pass_id, spins, amount_cents, bonus_spins, campaign_id, created_at, campaign:campaigns(name)")
    .eq("fan_id", fanId)
    .order("created_at", { ascending: false });

  const grantData = (grantRows ?? []) as unknown as {
    id: string;
    fan_pass_id: string | null;
    spins: number;
    amount_cents: number;
    bonus_spins: number;
    campaign_id: string | null;
    created_at: string;
    campaign: { name: string } | null;
  }[];

  const grants: Grant[] = grantData.map((g) => {
    // The pass editGrant would move for this grant (same pickGrantPass rule).
    const pass = pickGrantPass(passesOldestFirst, g.fan_pass_id);
    return {
      id: g.id,
      spins: g.spins,
      amountCents: g.amount_cents,
      bonusSpins: g.bonus_spins,
      campaignId: g.campaign_id,
      campaignName: g.campaign?.name ?? null,
      at: g.created_at,
      editPass: pass ? { spinsRemaining: pass.spins_remaining, wheelTitle: pass.wheel?.title ?? null } : null,
    };
  });

  const totalSpent = grantData.reduce((s, g) => s + g.amount_cents, 0);

  // Per-campaign breakdown: grant rollups merged with FIFO-attributed spins.
  // Bucket key is the campaignId, or "" for null-campaign grants/spins.
  interface Bucket {
    campaignId: string;
    name: string;
    spinsBought: number;
    spinsPlayed: number;
    spentCents: number;
    prizeCounts: Map<string, { label: string; rarity: Rarity; count: number }>;
  }
  const buckets = new Map<string, Bucket>();
  const nameById = new Map<string, string>();
  for (const g of grantData) {
    if (g.campaign_id && g.campaign?.name) nameById.set(g.campaign_id, g.campaign.name);
  }
  const bucketFor = (campaignId: string | null): Bucket => {
    const key = campaignId ?? "";
    let b = buckets.get(key);
    if (!b) {
      b = {
        campaignId: key,
        name: campaignId ? nameById.get(campaignId) ?? "Uncategorized" : "Uncategorized",
        spinsBought: 0,
        spinsPlayed: 0,
        spentCents: 0,
        prizeCounts: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const g of grantData) {
    const b = bucketFor(g.campaign_id);
    b.spinsBought += g.spins;
    b.spentCents += g.amount_cents;
  }
  for (const s of spins) {
    const b = bucketFor(s.campaign_id);
    b.spinsPlayed += 1;
    const cur = b.prizeCounts.get(s.prize_label);
    if (cur) cur.count += 1;
    else b.prizeCounts.set(s.prize_label, { label: s.prize_label, rarity: s.prize_rarity, count: 1 });
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
    name: fan.display_name ?? fan.handle ?? "Fan",
    blocked: !!(fan as { blocked_at?: string | null }).blocked_at,
    breakUntil: isOnBreak(breakUntil) ? breakUntil : null,
    notes: fan.notes ?? null,
    tags: fan.tags ?? [],
    spinsRemaining: fan.spins_remaining,
    grantedTotal: fan.spins_granted_total,
    totalSpins,
    totalSpent,
    lastActive,
    winsByRarity,
    pendingPrizes,
    links,
    grants,
    byCampaign,
    visits7: await fanVisitsLast7(sb, fanId),
  };
}

/**
 * Permanently delete a fan account. Schema FKs cascade the fan's links + grants
 * and anonymize their spins, so a plain delete is safe. RLS keeps a creator
 * scoped to their own fans.
 */
export async function deleteFan(
  fanId: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockDeleteFan(fanId) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("fans")
    .delete()
    .eq("id", fanId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/** Block or unblock a fan — blocked fans' links stop working (enforced in claim_spin). */
export async function setFanBlocked(
  fanId: string,
  blocked: boolean
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetFanBlocked(fanId, blocked);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb
    .from("fans")
    .update({ blocked_at: blocked ? new Date().toISOString() : null })
    .eq("id", fanId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

/** A fan reports the creator behind their token (service-role; fans aren't authed). */
export async function reportCreator(
  token: string,
  reason: string,
  detail?: string
): Promise<{ ok: true } | { error: string }> {
  if (!reason.trim()) return { error: "empty" };
  if (!isSupabaseConfigured()) return mockReportCreator(token, reason, detail);
  const sb = createServiceClient();
  const { data } = await sb
    .from("fan_passes")
    .select("creator_id, fan_id")
    .eq("token", token)
    .maybeSingle();
  const pass = data as { creator_id: string; fan_id: string } | null;
  if (!pass) return { error: "not_found" };
  const { error } = await sb.from("creator_reports").insert({
    creator_id: pass.creator_id,
    fan_id: pass.fan_id,
    token,
    reason: reason.slice(0, 120),
    detail: detail?.slice(0, 2000) ?? null,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/** A fan pauses (self-excludes) their own link from the spin page. */
export async function selfExclude(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSelfExclude(token);
  const sb = createServiceClient();
  const { error } = await sb
    .from("fan_passes")
    .update({ self_excluded_at: new Date().toISOString(), is_active: false })
    .eq("token", token);
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Patch a fan's creator-applied metadata (free-form notes and/or tags). RLS
 * scopes the update to the owning creator, so we use the auth-scoped client.
 */
export async function updateFanMeta(
  fanId: string,
  patch: { notes?: string | null; tags?: string[] }
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockUpdateFanMeta(fanId, patch);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if ("notes" in patch) upd.notes = patch.notes ?? null;
  if (patch.tags) upd.tags = patch.tags;
  if (Object.keys(upd).length === 0) return { ok: true };

  const { error } = await sb
    .from("fans")
    .update(upd)
    .eq("id", fanId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

// --- Age-gate / ToS (#24) ---------------------------------------------------

/** Stamp the age-gate / ToS acknowledgement on the fan behind a token. */
export async function ackFan(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockAckFan(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const { error } = await sb
    .from("fans")
    .update({ acked_at: new Date().toISOString() })
    .eq("id", resolved.fanId);
  return error ? { error: "db_error" } : { ok: true };
}

// --- Wishlist ---------------------------------------------------------------

/** Resolve the fan + creator + active wheel behind a token (service role). */
export async function resolveFanByToken(
  sb: ReturnType<typeof createServiceClient>,
  token: string
): Promise<{
  fanId: string;
  creatorId: string;
  campaignId: string | null;
  wheelId: string;
} | null> {
  const { data } = await sb
    .from("fan_passes")
    .select("creator_id, campaign_id, wheel_id, fan_id")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = data as {
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    fan_id: string;
  } | null;
  if (!pass) return null;
  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return null;
  return {
    fanId: pass.fan_id,
    creatorId: pass.creator_id,
    campaignId: pass.campaign_id,
    wheelId,
  };
}
