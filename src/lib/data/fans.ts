import { issueCreatorActorContext } from "@/lib/auth/creatorActorContext";
import { storedReportToken } from "@/lib/reports/reportToken";
import { CompleteReadError, MAX_REPORT_PAGES, MAX_REPORT_ROWS, readScopedRows } from "./readPages";
// Data layer — fans and grants: creator CRM, fan detail, grant edits, fan
// moderation, and the token-scoped fan actions (ack, self-exclude, report).
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import type { Rarity } from "@/lib/games/wheel/types";
import type { FanAccountSummary, FanCampaignBreakdown, FanDetail, Grant } from "./types";
import {
  mockGrantSpins,
  mockListFans,
  mockListFansPage,
  mockGetFanDetail,
  mockDeleteFanWithTombstones,
  mockUpdateFanMeta,
  mockEditGrant,
  mockAckFan,
  mockSelfExclude,
  mockSetFanBlocked,
  mockSetFanLinkGame,
  mockUpdateFanLink,
  mockReportCreator,
  mockDemoCreatorActive,
} from "./mock";
import { campaignPinError, isUuid } from "./shared";
import { creatorSummary } from "./creatorSummaries";
import { resolveWheelId } from "./wheels";
import { pickGrantPass } from "./grantPass";
import { isOnBreak } from "@/lib/play/playGuard";
import { fanVisitsLast7, visitsByFan } from "./checkins";
import { contactToken, fanEngagementAllowed } from "@/lib/engagement";
import { selectDormant, winbackStats, type WinbackStats } from "@/lib/winback/list";
import { listRecentOutreach } from "./outreach";
import { LEGAL, fanNeedsAck } from "@/lib/legal";

/** Service-only atomic economic writes. A transport retry reuses the same
 * request payload; it never subtracts credits after an ambiguous response. */
async function economicRpc(name: string, args: Record<string, unknown>, uncertainStatus?: string): Promise<Record<string, unknown> | null> {
  const service = createServiceClient() as unknown as { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await service.rpc(name, args);
      if (!error) return data && typeof data === "object" ? data as Record<string, unknown> : uncertainStatus ? { status: uncertainStatus } : null;
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code && !error.code.startsWith("PGRST")) return null;
    } catch { /* Retry the same idempotent operation, never compensate. */ }
  }
  return uncertainStatus ? { status: uncertainStatus } : null;
}

/** Absolute grant edits and balance deltas commit in one database transaction.
 * `grants.spins` includes its bonus subset, including pre-0059 grants. */
export async function editGrant(
  grantId: string,
  patch: { spins?: number; amountCents?: number; campaignId?: string | null },
  requestId: string = crypto.randomUUID(),
): Promise<{ ok: true; requestId: string; grantId: string; replayed: boolean } | { error: string }> {
  if (!isUuid(requestId) || requestId !== requestId.toLowerCase()) return { error: "invalid" };
  // Bind the supplied patch, including presence, rather than deriving a new
  // payload from mutable grant terms on each transport retry.
  const exact: { spins?: number; amountCents?: number; campaignId?: string | null } = {};
  if (patch.spins !== undefined) {
    if (!Number.isInteger(patch.spins) || patch.spins < 0 || patch.spins > 1_000_000) return { error: "invalid" };
    exact.spins = patch.spins;
  }
  if (patch.amountCents !== undefined) {
    if (!Number.isInteger(patch.amountCents) || patch.amountCents < 0 || patch.amountCents > 100_000_000) return { error: "invalid" };
    exact.amountCents = patch.amountCents;
  }
  if (patch.campaignId !== undefined) {
    if (patch.campaignId !== null && (typeof patch.campaignId !== "string" || !patch.campaignId || patch.campaignId.length > 200)) return { error: "invalid" };
    exact.campaignId = patch.campaignId;
  }
  if (!isSupabaseConfigured()) {
    const result = mockEditGrant(grantId, exact, requestId);
    return "error" in result ? result : { ok: true, requestId: result.requestId, grantId: result.grantId, replayed: result.replayed };
  }
  const sb = await createClient();
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return { error: "unauthorized" };
  const { data: grant, error: readError } = await sb.from("grants")
    .select("id, creator_id").eq("id", grantId).maybeSingle();
  if (readError) return { error: "db_error" };
  if (!grant) return { error: "not_found" };
  const { data: allowed, error: permissionError } = await sb.rpc("can_act_for", { target_creator: grant.creator_id, perm: "grant" });
  if (permissionError || allowed !== true) return { error: "unauthorized" };
  // The transaction checks the actual actor again and recovers an existing
  // receipt before validating live stock, break status or edited campaign rows.
  const context = await issueCreatorActorContext(sb, grant.creator_id, "grant");
  if (!context) return { error: "edit_pending" };
  const result = await economicRpc("edit_pass_grant", { p_request: requestId, p_creator: grant.creator_id, p_grant: grantId, p_patch: exact, p_actor: user.id, p_context: context }, "edit_pending");
  if (!result) return { error: "db_error" };
  if (result.status === "updated") {
    if (result.grantId !== grantId || typeof result.replayed !== "boolean") return { error: "edit_pending" };
    return { ok: true, requestId, grantId, replayed: result.replayed };
  }
  if (result.status === "conflict") return { error: "conflict" };
  if (result.status === "gone" || result.status === "cancelled" || result.status === "rejected") return { error: typeof result.error === "string" ? result.error : result.status };
  if (result.status === "invalid") return { error: ["insufficient_spins", "no_active_pass", "campaign_not_found"].includes(String(result.error)) ? String(result.error) : "invalid" };
  if (result.status === "unavailable") return { error: ["on_break", "blocked", "forbidden"].includes(String(result.error)) ? String(result.error) : "not_found" };
  return { error: "edit_pending" };
}

/**
 * The link tokens of one creator (or of one fan), keyed by pass id, through
 * creator_link_tokens (0068): the column is not selectable by a session, and
 * the RPC answers only the owner, an admin or a seat that may 'grant' for the
 * creator. Anyone else gets an empty map, never an error.
 */
async function servedLinkTokens(
  sb: Awaited<ReturnType<typeof createClient>>,
  creatorId: string,
  fanId?: string,
): Promise<Map<string, string>> {
  const { data, error } = await sb.rpc("creator_link_tokens", { p_creator: creatorId, ...(fanId ? { p_fan: fanId } : {}) });
  if (error) throw new Error("fan links unavailable");
  const map = new Map<string, string>();
  for (const row of (data ?? []) as { pass_id: string; token: string }[]) map.set(row.pass_id, row.token);
  return map;
}

/**
 * The pass behind a token the dashboard was served (creator_link_pass, 0068):
 * answered for a caller that may view the creator, never for anyone else, so a
 * foreign token is not found. Acting on it still needs can_act_for 'grant'.
 */
async function resolveServedLink(
  sb: Awaited<ReturnType<typeof createClient>>,
  token: string,
): Promise<{ id: string; creator_id: string; fan_id: string; campaign_id: string | null; is_active: boolean } | null | "db_error"> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(token)) return null;
  const { data, error } = await sb.rpc("creator_link_pass", { p_token: token });
  if (error) return "db_error";
  const row = ((data ?? []) as { id: string; creator_id: string; fan_id: string; campaign_id: string | null; is_active: boolean }[])[0];
  return row ?? null;
}

/** Top up this token's pass through an atomic, replay-safe grant transaction. */
export async function grantSpins(
  token: string,
  n: number,
  requestId: string = crypto.randomUUID(),
): Promise<{ spinsRemaining: number } | { error: string }> {
  if (!Number.isFinite(n) || n > 1_000_000 || !isUuid(requestId)) return { error: "invalid" };
  const add = Math.max(1, Math.floor(n) || 0);
  if (!isSupabaseConfigured() && !mockDemoCreatorActive()) return { error: "forbidden" }; // WU-01 parity: a suspended creator cannot write
  if (!isSupabaseConfigured()) {
    try {
      const remaining = mockGrantSpins(token, add, requestId);
      return remaining === null ? { error: "not_found" } : { spinsRemaining: remaining };
    } catch (error) { return { error: error instanceof Error && error.message === "conflict" ? "conflict" : "db_error" }; }
  }
  const sb = await createClient();
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return { error: "unauthorized" };
  // 0068: a session never selects fan_passes.token; the pass behind a served
  // token comes from creator_link_pass, which answers only a caller that may
  // grant for its creator (the same check is repeated below for the ledger).
  const pass = await resolveServedLink(sb, token);
  if (pass === "db_error") return { error: "db_error" };
  if (!pass) return { error: "not_found" };
  const { data: allowed, error: permissionError } = await sb.rpc("can_act_for", { target_creator: pass.creator_id, perm: "grant" });
  if (permissionError || allowed !== true) return { error: "unauthorized" };
  const { data: fan, error: fanError } = await sb.from("fans").select("blocked_at, break_until").eq("id", pass.fan_id).eq("creator_id", pass.creator_id).maybeSingle();
  if (fanError) return { error: "db_error" };
  if (!fan) return { error: "not_found" };
  if (fan.blocked_at) return { error: "blocked" };
  if (isOnBreak(fan.break_until)) return { error: "on_break" };
  const context = await issueCreatorActorContext(sb, pass.creator_id, "grant");
  if (!context) return { error: "db_error" };
  const result = await economicRpc("grant_pass_spins", { p_request: requestId, p_creator: pass.creator_id, p_fan: pass.fan_id, p_pass: pass.id, p_spins: add, p_bonus: 0, p_amount: 0, p_campaign: pass.campaign_id, p_actor: user.id, p_context: context });
  if (!result) return { error: "db_error" };
  return result.status === "granted" && typeof result.balance === "number" ? { spinsRemaining: result.balance } : { error: result.status === "conflict" ? "conflict" : "not_found" };
}

/** One page of the Fans list (PA-03): bounded, searchable, keyset-paged. */
export interface FanListPage {
  fans: FanAccountSummary[];
  /** Cursor for the next page; null when this was the last one. */
  nextCursor: string | null;
  /** The creator's unfiltered fan count (null when the count could not be read). */
  total: number | null;
  /**
   * Set when the pre-0073 fallback had to cap the per-fan spin/grant reads
   * for this page, so a fan's "last win" or "tips recorded" may be missing.
   */
  approximate?: boolean;
}
export interface FanListOptions {
  /** Case-insensitive match over display name, handle and tags. */
  query?: string | null;
  /** The previous page's nextCursor. */
  cursor?: string | null;
  limit?: number;
}
export const FAN_PAGE_SIZE = 50;
const FAN_PAGE_MAX = 200;
/** Fallback-only caps for the page's own spin / grant reads. */
const FAN_PAGE_DETAIL_ROWS = 5_000;
const SAFE_UUID = /^[0-9a-f-]{36}$/i;

export function encodeFanCursor(r: { createdAt: string; fanId: string }): string {
  return `${r.createdAt}|${r.fanId}`;
}
export function decodeFanCursor(raw: string | null | undefined): { createdAt: string; fanId: string } | null {
  if (!raw) return null;
  const i = raw.lastIndexOf("|");
  if (i <= 0) return null;
  const createdAt = raw.slice(0, i), fanId = raw.slice(i + 1);
  if (!SAFE_UUID.test(fanId) || Number.isNaN(Date.parse(createdAt)) || createdAt.length > 40) return null;
  return { createdAt, fanId };
}
/** Clamp the page size the way the 0073 RPC does. */
export function fanPageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return FAN_PAGE_SIZE;
  return Math.min(FAN_PAGE_MAX, Math.max(1, Math.floor(limit)));
}
/** The query as PostgREST will see it: trimmed, bounded, wildcards literal. */
function fanQueryText(query: string | null | undefined): string | null {
  const q = (query ?? "").trim().slice(0, 80);
  return q ? q : null;
}
function escapeLikeText(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** What every fan row needs before links and visits are attached. */
interface FanCore {
  id: string;
  display_name: string | null;
  handle: string | null;
  spins_remaining: number;
  spins_granted_total: number;
  tags: string[] | null;
  created_at: string;
  blocked_at: string | null;
  break_until: string | null;
  total_spent: number;
  campaign_names: string[];
  last_win: { label: string; rarity: Rarity; at: string } | null;
}
type PassRow = {
  id: string; fan_id: string; token?: string; created_at: string; spins_remaining: number; wheel_id: string; campaign_id: string | null;
  pinned_wheel_id?: string | null; is_active: boolean; self_excluded_at: string | null;
  wheel: { title: string } | null; campaign: { name: string } | null;
};
const PASS_COLUMNS = "id, fan_id, created_at, spins_remaining, wheel_id, campaign_id, pinned_wheel_id, is_active, self_excluded_at, wheel:wheels!fan_passes_wheel_id_fkey(title), campaign:campaigns(name)";
type Sb = Awaited<ReturnType<typeof createClient>>;


/**
 * One page of fan cores through creator_fan_summaries (0073, service role
 * after a session can_act_for 'manage' check); null when the function is not
 * there or the session may not act for the creator (the RLS-scoped read
 * below answers instead).
 */
async function fanCoresViaRpc(sb: Sb, creatorId: string, opts: { query: string | null; cursor: { createdAt: string; fanId: string } | null; limit: number }): Promise<{ cores: FanCore[]; total: number | null } | null> {
  const result = await creatorSummary(sb, creatorId, "manage", "creator_fan_summaries", {
    p_query: opts.query,
    p_before_created: opts.cursor?.createdAt ?? null,
    p_before_id: opts.cursor?.fanId ?? null,
    p_limit: opts.limit,
  });
  if (result.status === "error") throw new CompleteReadError();
  if (result.status !== "ok") return null;
  const data = result.data;
  // A set-returning RPC answers an array; anything else means it is not there.
  if (!Array.isArray(data)) return null;
  const rows = data as {
    fan_id: string; display_name: string | null; handle: string | null; spins_remaining: number; spins_granted_total: number; tags: string[] | null;
    created_at: string; blocked_at: string | null; break_until: string | null; total_spent_cents: number | string | null; campaign_names: string[] | null;
    last_win_label: string | null; last_win_rarity: Rarity | null; last_win_at: string | null; total_fans: number | string | null;
  }[];
  const cores = rows.map((r) => ({
    id: r.fan_id, display_name: r.display_name, handle: r.handle, spins_remaining: r.spins_remaining ?? 0, spins_granted_total: r.spins_granted_total ?? 0,
    tags: r.tags, created_at: r.created_at, blocked_at: r.blocked_at, break_until: r.break_until,
    total_spent: Number(r.total_spent_cents ?? 0), campaign_names: r.campaign_names ?? [],
    last_win: r.last_win_label && r.last_win_rarity && r.last_win_at ? { label: r.last_win_label, rarity: r.last_win_rarity, at: r.last_win_at } : null,
  }));
  const total = rows.length > 0 && rows[0].total_fans != null ? Number(rows[0].total_fans) : null;
  return { cores, total };
}

/**
 * Pre-0073 fallback: one keyset page of fans, then the spins and grants of
 * only those fans (capped, never refused). The caps make a fan's last win or
 * tips approximate on a very heavy page; the page itself always loads.
 */
async function fanCoresPaged(sb: Sb, creatorId: string, opts: { query: string | null; cursor: { createdAt: string; fanId: string } | null; limit: number }): Promise<{ cores: FanCore[]; total: number | null; approximate: boolean }> {
  let query = sb
    .from("fans")
    .select("id, display_name, handle, spins_remaining, spins_granted_total, tags, created_at, blocked_at, break_until")
    .eq("creator_id", creatorId);
  if (opts.query) {
    // PostgREST's `or` grammar: `*` is the ilike wildcard; the value is quoted
    // so commas and parentheses in a name cannot change the filter.
    const needle = `"*${escapeLikeText(opts.query).replace(/"/g, "")}*"`;
    query = query.or(`display_name.ilike.${needle},handle.ilike.${needle}`);
  }
  if (opts.cursor) {
    query = query.or(`created_at.lt.${opts.cursor.createdAt},and(created_at.eq.${opts.cursor.createdAt},id.lt.${opts.cursor.fanId})`);
  }
  const [{ data: fanRows, error: fanError }, { count, error: countError }] = await Promise.all([
    query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(opts.limit),
    sb.from("fans").select("id", { count: "exact", head: true }).eq("creator_id", creatorId),
  ]);
  if (fanError) throw new CompleteReadError();
  const fans = (fanRows ?? []) as { id: string; display_name: string | null; handle: string | null; spins_remaining: number; spins_granted_total: number; tags: string[] | null; created_at: string; blocked_at: string | null; break_until: string | null }[];
  const ids = fans.map((f) => f.id);
  if (ids.length === 0) return { cores: [], total: countError ? null : count ?? null, approximate: false };
  const [{ data: spinRows, error: spinError }, { data: grantRows, error: grantError }] = await Promise.all([
    sb.from("spins").select("fan_id, prize_label, prize_rarity, created_at").eq("creator_id", creatorId).in("fan_id", ids).order("created_at", { ascending: false }).limit(FAN_PAGE_DETAIL_ROWS),
    sb.from("grants").select("fan_id, amount_cents, campaign_id, campaign:campaigns(name)").eq("creator_id", creatorId).in("fan_id", ids).order("created_at", { ascending: false }).limit(FAN_PAGE_DETAIL_ROWS),
  ]);
  if (spinError || grantError) throw new CompleteReadError();
  const spins = (spinRows ?? []) as { fan_id: string; prize_label: string; prize_rarity: Rarity; created_at: string }[];
  const grants = (grantRows ?? []) as unknown as { fan_id: string; amount_cents: number; campaign_id: string | null; campaign: { name: string } | null }[];
  const lastWin = new Map<string, FanCore["last_win"]>();
  for (const s of spins) if (!lastWin.has(s.fan_id)) lastWin.set(s.fan_id, { label: s.prize_label, rarity: s.prize_rarity, at: s.created_at });
  const spent = new Map<string, number>();
  const campaignsByFan = new Map<string, { names: string[]; seen: Set<string> }>();
  for (const g of grants) {
    spent.set(g.fan_id, (spent.get(g.fan_id) ?? 0) + (g.amount_cents ?? 0));
    if (g.campaign_id && g.campaign?.name) {
      const entry = campaignsByFan.get(g.fan_id) ?? { names: [], seen: new Set<string>() };
      if (!entry.seen.has(g.campaign_id)) { entry.seen.add(g.campaign_id); entry.names.push(g.campaign.name); }
      campaignsByFan.set(g.fan_id, entry);
    }
  }
  return {
    cores: fans.map((f) => ({
      ...f,
      total_spent: spent.get(f.id) ?? 0,
      campaign_names: campaignsByFan.get(f.id)?.names ?? [],
      last_win: lastWin.get(f.id) ?? null,
    })),
    total: countError ? null : count ?? null,
    approximate: spins.length >= FAN_PAGE_DETAIL_ROWS || grants.length >= FAN_PAGE_DETAIL_ROWS,
  };
}

/** Attach the links (tokens this session may hand out) and 7-day visits to a page of cores. */
async function assembleFans(sb: Sb, creatorId: string, cores: FanCore[]): Promise<FanAccountSummary[]> {
  if (cores.length === 0) return [];
  const ids = cores.map((c) => c.id);
  const [{ data: passData, error: passError }, visits, tokens] = await Promise.all([
    sb.from("fan_passes").select(PASS_COLUMNS).eq("creator_id", creatorId).in("fan_id", ids).order("created_at", { ascending: false }).limit(FAN_PAGE_DETAIL_ROWS),
    visitsByFan(sb, creatorId),
    servedLinkTokens(sb, creatorId),
  ]);
  if (passError) throw new CompleteReadError();
  // 0068: tokens are served by creator_link_tokens (owner / 'grant' seats
  // only). A link this session may not hand out is left out of the list.
  const passesByFan = new Map<string, (PassRow & { token: string })[]>();
  for (const row of (passData ?? []) as unknown as PassRow[]) {
    const token = tokens.get(row.id);
    if (!token) continue;
    (passesByFan.get(row.fan_id) ?? passesByFan.set(row.fan_id, []).get(row.fan_id)!).push({ ...row, token });
  }
  return cores.map((r) => {
    const links = (passesByFan.get(r.id) ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    const passes = links
      .filter((p): p is typeof p & { wheel_id: string } => typeof p.wheel_id === "string")
      .map((p) => ({
        token: p.token,
        wheelId: p.wheel_id,
        wheelTitle: p.wheel?.title ?? "Wheel",
        campaignId: p.campaign_id ?? null,
        pinnedWheelId: p.pinned_wheel_id ?? null,
        campaignName: p.campaign?.name ?? null,
        spinsRemaining: p.spins_remaining ?? 0,
        createdAt: p.created_at,
        isActive: p.is_active !== false,
        selfExcludedAt: p.self_excluded_at ?? null,
      }));
    return {
      fanId: r.id,
      name: r.display_name ?? r.handle ?? "Fan",
      spinsRemaining: r.spins_remaining,
      grantedTotal: r.spins_granted_total,
      primaryToken: links[0]?.token ?? null,
      totalSpent: r.total_spent,
      campaignNames: r.campaign_names,
      tags: r.tags ?? [],
      links: links.map((p) => ({ token: p.token })),
      passes,
      lastWin: r.last_win,
      blocked: !!r.blocked_at,
      selfExcluded: links.some((p) => !!p.self_excluded_at),
      activeToken: links.find((p) => p.is_active === true && !p.self_excluded_at)?.token ?? null,
      // RM-6: only the break state, never the fan's reminder or counts.
      breakUntil: isOnBreak(r.break_until) ? r.break_until : null,
      visits7: visits.get(r.id) ?? 0,
      createdAt: r.created_at,
    };
  });
}

/**
 * One page of the creator's fans (PA-03): newest first, searched and paged
 * on the server. Uses creator_fan_summaries (0073) when the database has it,
 * otherwise a bounded keyset page that never refuses for size.
 */
export async function listFansPage(options: FanListOptions = {}): Promise<FanListPage> {
  const limit = fanPageLimit(options.limit);
  const query = fanQueryText(options.query);
  if (!isSupabaseConfigured()) return mockListFansPage({ query, cursor: options.cursor ?? null, limit });
  const cursor = decodeFanCursor(options.cursor);
  if (options.cursor && !cursor) return { fans: [], nextCursor: null, total: null };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { fans: [], nextCursor: null, total: 0 };

  const viaRpc = await fanCoresViaRpc(sb, user.id, { query, cursor, limit });
  const page = viaRpc ?? (await fanCoresPaged(sb, user.id, { query, cursor, limit }));
  const fans = await assembleFans(sb, user.id, page.cores);
  const last = page.cores[page.cores.length - 1];
  return {
    fans,
    nextCursor: page.cores.length === limit && last ? encodeFanCursor({ createdAt: last.created_at, fanId: last.id }) : null,
    total: page.total,
    ...("approximate" in page && page.approximate ? { approximate: true } : {}),
  };
}

/**
 * Every fan of the creator, newest first, for server-side reports (the CRM)
 * that need the whole set. With creator_fan_summaries (0073) it pages the
 * RPC; before that it is the complete bounded read (CompleteReadError past
 * MAX_REPORT_ROWS), never an approximate page.
 */
export async function listFans(): Promise<FanAccountSummary[]> {
  if (!isSupabaseConfigured()) return mockListFans();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  const all: FanAccountSummary[] = [];
  let cursor: { createdAt: string; fanId: string } | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_REPORT_PAGES || all.length >= MAX_REPORT_ROWS) throw new CompleteReadError("limit");
    const page = await fanCoresViaRpc(sb, user.id, { query: null, cursor, limit: FAN_PAGE_MAX });
    if (!page) return pages === 0 ? listFansComplete(sb, user) : all;
    all.push(...(await assembleFans(sb, user.id, page.cores)));
    const last = page.cores[page.cores.length - 1];
    if (page.cores.length < FAN_PAGE_MAX || !last) return all;
    cursor = { createdAt: last.created_at, fanId: last.id };
  }
}

/**
 * Pre-0073 complete read of every fan (+ links): exact-count id pages with
 * one fixed cutoff, refused past MAX_REPORT_ROWS (CompleteReadError) so a
 * report never publishes a partial total.
 */
async function listFansComplete(sb: Sb, user: { id: string }): Promise<FanAccountSummary[]> {
  const cutoff = new Date().toISOString();
  const [fanRows, passRowsWithoutTokens, spinRows, grantRows, visits, tokens] = await Promise.all([
    readScopedRows<Record<string, unknown>>(sb, "fans", "display_name, handle, spins_remaining, spins_granted_total, tags, created_at, blocked_at, break_until", q => q.eq("creator_id", user.id), cutoff),
    readScopedRows<Record<string, unknown>>(sb, "fan_passes", "fan_id, created_at, spins_remaining, wheel_id, campaign_id, pinned_wheel_id, is_active, self_excluded_at, wheel:wheels!fan_passes_wheel_id_fkey(title), campaign:campaigns(name)", q => q.eq("creator_id", user.id), cutoff),
    readScopedRows<Record<string, unknown>>(sb, "spins", "fan_id, prize_label, prize_rarity, created_at", q => q.eq("creator_id", user.id).not("fan_id", "is", null), cutoff),
    readScopedRows<Record<string, unknown>>(sb, "grants", "fan_id, amount_cents, campaign_id, campaign:campaigns(name)", q => q.eq("creator_id", user.id), cutoff),
    visitsByFan(sb, user.id),
    servedLinkTokens(sb, user.id),
  ]);
  // 0068: tokens are served by creator_link_tokens (owner / 'grant' seats
  // only). A link this session may not hand out is left out of the list.
  const passRows = passRowsWithoutTokens.flatMap(row => {
    const token = tokens.get(row.id);
    return token ? [{ ...row, token }] : [];
  });
  const groupByFan = (items: Record<string, unknown>[]) => {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of items) {
      if (typeof row.fan_id !== "string") continue;
      const group = groups.get(row.fan_id) ?? [];
      group.push(row); groups.set(row.fan_id, group);
    }
    return groups;
  };
  const passesByFan = groupByFan(passRows), spinsByFan = groupByFan(spinRows), grantsByFan = groupByFan(grantRows);
  fanRows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id));
  const rows = fanRows.map(fan => ({ ...fan, fan_passes: passesByFan.get(fan.id) ?? [], spins: spinsByFan.get(fan.id) ?? [], grants: grantsByFan.get(fan.id) ?? [] })) as unknown as {
    id: string; display_name: string | null; handle: string | null;
    spins_remaining: number; spins_granted_total: number; tags: string[] | null;
    blocked_at: string | null; break_until: string | null;
    fan_passes: { token: string; created_at: string; spins_remaining: number; wheel_id: string; campaign_id: string | null; pinned_wheel_id?: string | null; is_active: boolean; self_excluded_at: string | null; wheel: { title: string } | null; campaign: { name: string } | null }[];
    spins: { prize_label: string; prize_rarity: Rarity; created_at: string }[];
    grants: { amount_cents: number; campaign_id: string | null; campaign: { name: string } | null }[];
  }[];

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
        campaignId: p.campaign_id ?? null,
        pinnedWheelId: p.pinned_wheel_id ?? null,
        campaignName: p.campaign?.name ?? null,
        spinsRemaining: p.spins_remaining ?? 0,
        createdAt: p.created_at,
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
      breakUntil: isOnBreak(r.break_until) ? r.break_until : null,
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
  lastWin: string | null; // label of the fan's last win (template {lastWin})
}
export interface CreatorCrm {
  totalLtv: number; // cents across all fans
  avgLtv: number; // cents per fan with spend
  whales: CrmFan[]; // top spenders, desc
  dormant: CrmFan[]; // spent before, quiet 14+ days, not contacted/snoozed: the win-back queue
  winback: WinbackStats; // "N contacted · M came back" + recent contacts (RM-5)
}

/**
 * Whale detection + win-back, derived from fan data plus the outreach log:
 *   • LTV per fan = sum of their grant amounts (real money tied to their spins).
 *   • Whales = fans ranked by LTV desc (your highest-value relationships).
 *   • Dormant = fans who HAVE spent (LTV > 0) but whose last win/activity is
 *     WINBACK_QUIET_DAYS+ ago — the cheapest revenue is a fan you already
 *     converted (selectDormant in src/lib/winback/list.ts).
 *     Spend safety: a fan failing the engagement gate (blocked, paused a link,
 *     on a break), a fan with no active link, a fan contacted within the
 *     cooldown and a snoozed fan are never suggested. Whales pass the same F6
 *     gate (they drive Autopilot's top-spender and out-of-spins cards). If the outreach log
 *     can't be read, nobody is suggested (fail closed).
 * The link offered on any row is the fan's newest ACTIVE link (never a paused
 * one), and none at all for a fan failing the engagement gate.
 */
export async function getCreatorCrm(): Promise<CreatorCrm> {
  const now = Date.now();
  const [fans, outreach] = await Promise.all([listFans(), listRecentOutreach(now)]);
  const DAY = 86_400_000;

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
      primaryToken: contactToken(f, now),
      lastWin: f.lastWin?.label ?? null,
    };
  };

  const all = fans.map(enrich);
  const spenders = all.filter((f) => f.totalSpent > 0);
  const totalLtv = spenders.reduce((s, f) => s + f.totalSpent, 0);
  const avgLtv = spenders.length ? Math.round(totalLtv / spenders.length) : 0;

  // F6: whales feed "check in with your top spenders" and "out of spins" nudges,
  // so a blocked, paused or on-break fan is never one.
  const engaged = new Set(fans.filter((f) => fanEngagementAllowed(f, now)).map((f) => f.fanId));
  const whales = spenders
    .filter((f) => engaged.has(f.fanId))
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 10);
  // primaryToken is null exactly when the fan fails the gate (see enrich).
  const dormant = outreach ? selectDormant(spenders, outreach, now) : [];
  const winback = winbackStats(all, outreach ?? [], now);

  return { totalLtv, avgLtv, whales, dormant, winback };
}

/**
 * A single fan account's full detail, for the creator's fan drill-in. RLS keeps
 * this scoped to the owning creator, so we use the auth-scoped client.
 */
export async function getFanDetail(fanId: string): Promise<FanDetail | null> {
  if (!isSupabaseConfigured()) return mockGetFanDetail(fanId);
  const cutoff = new Date().toISOString();

  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;

  const { data: fan, error: fanReadError } = await sb
    .from("fans")
    .select("id, display_name, handle, spins_remaining, spins_granted_total, notes, tags, blocked_at")
    .eq("id", fanId)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (fanReadError) throw new CompleteReadError();
  if (!fan) return null;

  const [{ data: spinRows }, breakRes] = await Promise.all([
    readScopedRows<{ prize_label: string; prize_rarity: Rarity; campaign_id: string | null; created_at: string; kind?: "play" | "bonus" }>(sb, "spins", "prize_label, prize_rarity, campaign_id, created_at, kind", q => q.eq("creator_id", user.id).eq("fan_id", fanId), cutoff).then(data => ({ data: data.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) })),
    // RM-6: read on its own so a DB without 0049 still opens the drawer.
    Promise.resolve(sb.from("fans").select("break_until").eq("id", fanId).maybeSingle()).catch(() => null),
  ]);
  const breakUntil = (breakRes?.data as { break_until?: string | null } | null)?.break_until ?? null;

  const spins = (spinRows ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
    campaign_id: string | null;
    created_at: string;
    kind?: "play" | "bonus";
  }[];
  const paidPlays = spins.filter(spin => spin.kind !== "bonus");
  const totalSpins = paidPlays.length;
  const lastActive = paidPlays[0]?.created_at ?? null;

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
  const pendingRows = await readScopedRows<{ created_at: string; spin: { prize_label: string; prize_rarity: Rarity; fan_id: string } | null }>(sb, "redemptions", "created_at, spin:spins!inner(prize_label, prize_rarity, fan_id)", q => q.eq("creator_id", user.id).eq("status", "pending").eq("spin.fan_id", fanId), cutoff);
  pendingRows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

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
  const [passRowsWithoutTokens, tokens] = await Promise.all([
    readScopedRows<{ created_at: string; is_active: boolean; spins_remaining: number; wheel_id?: string; campaign_id?: string | null; pinned_wheel_id?: string | null; self_excluded_at?: string | null; wheel: { title: string } | null; campaign?: { name: string } | null }>(sb, "fan_passes", "created_at, is_active, spins_remaining, wheel_id, campaign_id, pinned_wheel_id, self_excluded_at, wheel:wheels!fan_passes_wheel_id_fkey(title), campaign:campaigns(name)", q => q.eq("creator_id", user.id).eq("fan_id", fanId), cutoff),
    servedLinkTokens(sb, user.id, fanId),
  ]);
  // 0068: the link itself comes from creator_link_tokens; a pass this session
  // may not hand out is not listed.
  const passRows = passRowsWithoutTokens.flatMap(row => {
    const token = tokens.get(row.id);
    return token ? [{ ...row, token }] : [];
  });
  passRows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  // PR-13: link expiry is its own read (0073 grants sessions SELECT on
  // fan_passes.expires_at under the existing RLS; the token stays revoked).
  // On a database without that grant the read is refused and the drawer
  // hides the expiry control; the links themselves always load.
  const expiryRead = await sb.from("fan_passes").select("id, expires_at").eq("creator_id", user.id).eq("fan_id", fanId);
  const expiries = expiryRead.error ? null : new Map(((expiryRead.data ?? []) as unknown as { id: string; expires_at: string | null }[]).map((row) => [row.id, row.expires_at ?? null]));

  const passesOldestFirst = ((passRows ?? []) as unknown as {
    id: string;
    token: string;
    created_at: string;
    is_active: boolean;
    spins_remaining: number;
    wheel_id?: string;
    campaign_id?: string | null;
    pinned_wheel_id?: string | null;
    self_excluded_at?: string | null;
    wheel?: { title: string } | null;
    campaign?: { name: string } | null;
  }[]).map((p) => ({ ...p, isActive: p.is_active }));

  const links = passesOldestFirst
    .slice()
    .reverse()
    .map((p) => ({ token: p.token, createdAt: p.created_at }));
  const passes = passesOldestFirst
    .slice()
    .reverse()
    .filter((p): p is typeof p & { wheel_id: string } => typeof p.wheel_id === "string")
    .map((p) => ({
      token: p.token,
      wheelId: p.wheel_id,
      wheelTitle: p.wheel?.title ?? "Wheel",
      campaignId: p.campaign_id ?? null,
      pinnedWheelId: p.pinned_wheel_id ?? null,
      campaignName: p.campaign?.name ?? null,
      spinsRemaining: p.spins_remaining ?? 0,
      createdAt: p.created_at,
      isActive: p.is_active !== false,
      selfExcludedAt: p.self_excluded_at ?? null,
      ...(expiries ? { expiresAt: expiries.get(p.id) ?? null } : {}),
    }));

  // This fan's grants, newest first, with campaign name resolved via a join.
  const grantRows = await readScopedRows<{ created_at: string } & Record<string, unknown>>(sb, "grants", "fan_pass_id, spins, amount_cents, bonus_spins, campaign_id, created_at, campaign:campaigns(name)", q => q.eq("creator_id", user.id).eq("fan_id", fanId), cutoff);
  grantRows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

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
    if (s.kind !== "bonus") b.spinsPlayed += 1;
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
    dataStatus: "complete",
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
    passes,
    grants,
    byCampaign,
    visits7: await fanVisitsLast7(sb, fanId),
  };
}

/**
 * Permanently delete a fan account. Schema FKs cascade the fan's links, grants,
 * messages, wishlists and referrals; spins and redemptions are KEPT with their
 * fan reference cleared (fan_id / fan_pass_id ON DELETE SET NULL), and the
 * fans BEFORE DELETE trigger (0068) scrubs the link token from safety reports
 * and the fan's spin attempts. RLS keeps a creator scoped to their own fans.
 */
export async function deleteFan(
  fanId: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return (await mockDeleteFanWithTombstones(fanId)) ? { ok: true } : { error: "not_found" };
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
  if (!isSupabaseConfigured() && !mockDemoCreatorActive()) return { error: "forbidden" }; // WU-01 parity: a suspended creator cannot write
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

/**
 * Choose the game one fan link plays (0065): null follows the link's campaign
 * and the creator's live game again. The game must be the creator's own and
 * playable (campaignPinError, the campaign pin's test). The write is the
 * service RPC set_fan_pass_game behind an actor context minted from this
 * session ('grant', the fan_passes_write permission, 0062 MFA step-up), which
 * rechecks authority after its row locks and refuses another creator's game.
 */
export async function setFanLinkGame(
  fanId: string,
  token: string,
  wheelId: string | null
): Promise<{ ok: true } | { error: string }> {
  // The demo store checks its own ids (they are not UUIDs).
  if (!isSupabaseConfigured()) return mockSetFanLinkGame(fanId, token, wheelId);
  if (wheelId !== null && !isUuid(wheelId)) return { error: "not_found" };
  if (!isUuid(fanId) || typeof token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { error: "not_found" };
  const sb = await createClient();
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return { error: "unauthorized" };
  const served = await resolveServedLink(sb, token);
  if (served === "db_error") return { error: "db_error" };
  const pass = served && served.fan_id === fanId && served.is_active ? served : null;
  if (!pass) return { error: "not_found" };
  const { data: allowed, error: permissionError } = await sb.rpc("can_act_for", { target_creator: pass.creator_id, perm: "grant" });
  if (permissionError || allowed !== true) return { error: "forbidden" };
  const pinError = await campaignPinError(sb, pass.creator_id, wheelId);
  if (pinError) return { error: pinError };
  const context = await issueCreatorActorContext(sb, pass.creator_id, "grant");
  if (!context) return { error: "db_error" };
  const result = await economicRpc("set_fan_pass_game", { p_context: context, p_creator: pass.creator_id, p_pass: pass.id, p_wheel: wheelId, p_actor: user.id });
  if (result?.status === "ok") return { ok: true };
  return { error: ["forbidden", "not_found", "game_not_playable"].includes(String(result?.status)) ? String(result?.status) : "db_error" };
}

/**
 * PR-13: switch one link off (or back on) without blocking the fan. The fan
 * keeps their account, chat and other links; the switched-off link shows
 * the paused page. Owner / 'grant' seats only (fan_passes_write RLS).
 */
export async function setFanLinkActive(
  fanId: string,
  token: string,
  active: boolean
): Promise<{ ok: true } | { error: string }> {
  return updateFanLink(fanId, token, { active });
}

/** A link can live at most this long from now when an expiry is set. */
export const MAX_LINK_EXPIRY_DAYS = 365;

/**
 * PR-13: switch one link off/on and/or set when it expires (0073:
 * fan_passes.expires_at; every play path treats an expired link as paused).
 * Owner / 'grant' seats only: the session proves can_act_for and the
 * fan_passes_write RLS policy scopes the update.
 */
export async function updateFanLink(
  fanId: string,
  token: string,
  patch: { active?: boolean; expiresAt?: string | null }
): Promise<{ ok: true } | { error: string }> {
  const update: { is_active?: boolean; expires_at?: string | null } = {};
  if (typeof patch.active === "boolean") update.is_active = patch.active;
  if (patch.expiresAt !== undefined) {
    if (patch.expiresAt === null) update.expires_at = null;
    else {
      const at = Date.parse(patch.expiresAt);
      if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + MAX_LINK_EXPIRY_DAYS * 86_400_000) return { error: "bad_request" };
      update.expires_at = new Date(at).toISOString();
    }
  }
  if (Object.keys(update).length === 0) return { error: "bad_request" };
  if (!isSupabaseConfigured() && !mockDemoCreatorActive()) return { error: "forbidden" }; // WU-01 parity: a suspended creator cannot write
  if (!isSupabaseConfigured()) return mockUpdateFanLink(fanId, token, { active: update.is_active, expiresAt: update.expires_at });
  if (!isUuid(fanId) || typeof token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) return { error: "not_found" };
  const sb = await createClient();
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return { error: "unauthorized" };
  const served = await resolveServedLink(sb, token);
  if (served === "db_error") return { error: "db_error" };
  if (!served || served.fan_id !== fanId) return { error: "not_found" };
  const { data: allowed, error: permissionError } = await sb.rpc("can_act_for", { target_creator: served.creator_id, perm: "grant" });
  if (permissionError || allowed !== true) return { error: "forbidden" };
  const { data: updated, error } = await sb
    .from("fan_passes")
    .update(update)
    .eq("id", served.id)
    .eq("creator_id", served.creator_id)
    .select("id");
  if (error) return { error: "db_error" };
  if (!updated || updated.length === 0) return { error: "not_found" };
  return { ok: true };
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
    // N4: a digest and a 4-character hint, never the bearer token itself.
    token: storedReportToken(token),
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
  // self_exclude_pass (0071) locks the fan, then the link, the order every
  // play and grant takes them (a plain UPDATE locked the link first and its
  // triggers the fan after it, which deadlocked against a committing play).
  // An unknown token answers ok, as the plain UPDATE of no row did.
  const { data, error } = await createServiceClient().rpc("self_exclude_pass", { p_token: token });
  return error || (data !== "ok" && data !== "not_found") ? { error: "db_error" } : { ok: true };
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

/**
 * Stamp the age-gate / ToS acknowledgement, and the Terms version agreed to, on
 * the fan behind a token. The version always comes from the server (LEGAL), never
 * from the request, and only the fan resolved from this token is updated.
 */
export async function ackFan(
  token: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockAckFan(token);

  const sb = createServiceClient();
  const resolved = await resolveFanByToken(sb, token);
  if (!resolved) return { error: "not_found" };

  const { error } = await sb
    .from("fans")
    .update({ acked_at: new Date().toISOString(), acked_terms_version: LEGAL.version })
    .eq("id", resolved.fanId);
  return error ? { error: "db_error" } : { ok: true };
}

// --- Wishlist ---------------------------------------------------------------

/**
 * Resolve the fan + creator + active wheel behind a token (service role).
 * `blocked` is the creator's block (fans.blocked_at): callers that let a fan
 * reach the creator (chat, wishlist, leaderboard opt-in) refuse it (A4).
 */
export async function resolveFanByToken(
  sb: ReturnType<typeof createServiceClient>,
  token: string
): Promise<{
  fanId: string;
  creatorId: string;
  campaignId: string | null;
  wheelId: string;
  blocked: boolean;
  needsAck: boolean;
} | null> {
  const { data } = await sb
    .from("fan_passes")
    .select("creator_id, campaign_id, wheel_id, pinned_wheel_id, fan_id, fan:fans(blocked_at, acked_at, acked_terms_version)")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const pass = data as {
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    pinned_wheel_id?: string | null;
    fan_id: string;
    fan?: { blocked_at: string | null; acked_at?: string | null; acked_terms_version?: string | null } | null;
  } | null;
  if (!pass) return null;
  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return null;
  return {
    fanId: pass.fan_id,
    creatorId: pass.creator_id,
    campaignId: pass.campaign_id,
    wheelId,
    blocked: !!pass.fan?.blocked_at,
    // T2: the same age/terms check the spin uses; callers that let a fan reach
    // the creator refuse with needs_ack until it is confirmed.
    needsAck: fanNeedsAck(pass.fan?.acked_at, pass.fan?.acked_terms_version),
  };
}
