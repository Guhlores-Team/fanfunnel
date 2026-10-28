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
import { exportCreatorTheme } from "@/lib/privacy/themeExport";
import type { Json } from "./db.types";
import {
  CREATOR_EXPORT_ABOUT,
  CREATOR_EXPORT_FORMAT,
  FAN_EXPORT_ABOUT,
  FAN_EXPORT_FORMAT,
  FAN_EXPORT_EXCLUDED,
  CREATOR_EXPORT_EXCLUDED,
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

import { EXPORT_PAGE_SIZE, EXPORT_ROW_CAP, exportStatus, safeExportValue } from "@/lib/privacy/exportRecords";

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

type ExportRow = Record<string, unknown>;
type ExportResult<T> = { rows: T[]; truncated: boolean; failed: boolean };
type ExportQuery = PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> & {
  select(columns: string, options?: { count: "exact" }): ExportQuery;
  eq(column: string, value: unknown): ExportQuery;
  in(column: string, values: unknown[]): ExportQuery;
  order(column: string, options: { ascending: boolean }): ExportQuery;
  range(from: number, to: number): ExportQuery;
};
type ExportClient = Pick<Svc, "from">;

/** Advance by returned rows, even when PostgREST's configured page limit is
 * smaller than ours. Count and an empty-page probe distinguish a cap from a
 * complete file; a short response alone never claims completeness. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>,
  cap = EXPORT_ROW_CAP,
): Promise<ExportResult<T>> {
  const rows: T[] = [];
  while (rows.length < cap) {
    try {
      const { data, error, count } = await page(rows.length, Math.min(rows.length + EXPORT_PAGE_SIZE, cap) - 1);
      if (error || (data !== null && !Array.isArray(data))) return { rows, truncated: false, failed: true };
      const batch = (data ?? []) as T[];
      if (!batch.length) return { rows, truncated: false, failed: false };
      rows.push(...batch.slice(0, cap - rows.length));
      if (typeof count === "number" && rows.length >= count) return { rows, truncated: false, failed: false };
    } catch {
      return { rows, truncated: false, failed: true };
    }
  }
  return { rows, truncated: true, failed: false };
}

function readRows<T = ExportRow>(
  client: ExportClient, table: string, columns: string,
  filters: [string, unknown][], order: string[] = ["id"],
  inFilter?: [string, unknown[]], cap = EXPORT_ROW_CAP,
): Promise<ExportResult<T>> {
  return fetchAll<T>((from, to) => {
    let query = (client.from(table) as unknown as ExportQuery).select(columns, { count: "exact" });
    for (const [column, value] of filters) query = query.eq(column, value);
    if (inFilter) query = query.in(inFilter[0], inFilter[1]);
    for (const column of order) query = query.order(column, { ascending: true });
    return query.range(from, to);
  }, cap);
}

const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

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
  const own: [string, unknown][] = [["fan_id", fanId], ["creator_id", creatorId]];
  const failed: string[] = [], truncated: string[] = [];
  const remember = <T>(name: string, result: ExportResult<T>): T[] => {
    if (result.failed) failed.push(name);
    if (result.truncated) truncated.push(name);
    return result.rows;
  };
  const [fanRes, creatorRes, linksRead, grantsRead, wishesRead, messagesRead, spinsRead, checkinsRead, outreachRead, reportsRead, reminderRes, refRes] = await Promise.all([
    svc.from("fans").select("display_name, handle, created_at, spins_remaining, spins_granted_total, last_spin_at, referral_code, referred_by_fan_id, acked_at, acked_terms_version, leaderboard_opt_in, break_until").eq("id", fanId).eq("creator_id", creatorId).maybeSingle(),
    svc.from("profiles").select("display_name").eq("id", creatorId).maybeSingle(),
    readRows(svc, "fan_passes", "id, token, created_at, is_active, self_excluded_at, spins_remaining, spins_granted_total, last_spin_at, wheel:wheels(title)", own),
    readRows(svc, "grants", "id, created_at, spins, bonus_spins", own),
    readRows(svc, "wishlists", "id, prize_label, prize_rarity, created_at", own),
    readRows(svc, "messages", "id, body, created_at", [...own, ["sender", "fan"]]),
    readRows(svc, "spins", "id, created_at, prize_label, prize_rarity, share_id, server_seed, server_seed_hash, client_seed, nonce, seed_commitment, fair_version, pool_hash, pool_snapshot, fair_trace, wheel:wheels(title)", own),
    readRows(svc, "fan_checkins", "day, created_at", own, ["day"]),
    readRows(svc, "fan_outreach", "id, created_at, contacted_at", own),
    readRows(svc, "creator_reports", "id, created_at, reason, detail", own),
    svc.from("fan_play_reminders").select("daily, updated_at").eq("fan_id", fanId).maybeSingle(),
    svc.from("referrals").select("id", { count: "exact", head: true }).eq("referrer_fan_id", fanId).eq("creator_id", creatorId),
  ]);
  if (fanRes.error || !fanRes.data) return null;
  const fan = fanRes.data as ExportRow;
  if (creatorRes.error) failed.push("creator");
  if (reminderRes.error) failed.push("play.reminder");
  if (refRes.error) failed.push("profile.referrals");
  const links = remember("links", linksRead), grants = remember("topUps", grantsRead);
  const wishes = remember("wishlist", wishesRead), messages = remember("messagesYouSent", messagesRead);
  const spins = remember("spins", spinsRead), checkins = remember("checkIns", checkinsRead);
  const outreach = remember("outreach", outreachRead), reports = remember("reportsYouSent", reportsRead);
  const reminder = reminderRes.data as { daily: number; updated_at: string } | null;
  const creator = creatorRes.data as { display_name: string | null } | null;
  const prizes: FanDataExport["prizes"] = [];
  const bySpin = new Map(spins.map((row) => [String(row.id), row]));
  const ids = [...bySpin.keys()];
  for (let at = 0; at < ids.length; at += 200) {
    const batch = await readRows(svc, "redemptions", "id, spin_id, status, created_at, fulfilled_at", [["creator_id", creatorId]], ["id"], ["spin_id", ids.slice(at, at + 200)], EXPORT_ROW_CAP - prizes.length);
    for (const row of remember("prizes", batch)) prizes.push({ spinId: String(row.spin_id), prize: str(bySpin.get(String(row.spin_id))?.prize_label) ?? "Prize", status: str(row.status) ?? "unknown", wonAt: str(row.created_at) ?? "", fulfilledAt: str(row.fulfilled_at) });
    if (batch.failed || batch.truncated) break;
  }
  const instantReceipts: FanDataExport["instantReceipts"] = [];
  for (let at = 0; at < ids.length; at += 200) {
    const batch = await readRows(svc, "spin_rewards", "spin_id, kind, views, last_viewed_at, created_at, erased_at", [["creator_id", creatorId]], ["spin_id"], ["spin_id", ids.slice(at, at + 200)], EXPORT_ROW_CAP - instantReceipts.length);
    for (const row of remember("instantReceipts", batch)) instantReceipts.push({ spinId: String(row.spin_id), kind: str(row.kind) ?? "unknown", views: num(row.views), lastViewedAt: str(row.last_viewed_at), createdAt: str(row.created_at) ?? "", erasedAt: str(row.erased_at) });
    if (batch.failed || batch.truncated) break;
  }
  if (spinsRead.failed) failed.push("prizes", "instantReceipts");
  if (spinsRead.truncated) truncated.push("prizes", "instantReceipts");
  return safeExportValue({
    format: FAN_EXPORT_FORMAT, exportedAt: new Date().toISOString(), about: FAN_EXPORT_ABOUT,
    ...exportStatus(failed, truncated), excluded: [...FAN_EXPORT_EXCLUDED],
    creator: { displayName: creator?.display_name ?? null },
    profile: { displayName: str(fan.display_name), handle: str(fan.handle), joinedAt: str(fan.created_at), spinsRemaining: num(fan.spins_remaining), spinsGrantedTotal: num(fan.spins_granted_total), lastSpinAt: str(fan.last_spin_at), referralCode: str(fan.referral_code), joinedThroughAReferral: fan.referred_by_fan_id != null, friendsReferred: refRes.count ?? 0 },
    consents: { ageAndTermsAcceptedAt: str(fan.acked_at), termsVersion: str(fan.acked_terms_version), leaderboardOptIn: fan.leaderboard_opt_in === true },
    links: links.map((row) => ({ linkEndsWith: maskToken(str(row.token)), isThisLink: row.token === token, wheel: str((row.wheel as ExportRow | null)?.title), createdAt: str(row.created_at), active: row.is_active === true, pausedByYouAt: str(row.self_excluded_at), spinsRemaining: num(row.spins_remaining), spinsGrantedTotal: num(row.spins_granted_total), lastSpinAt: str(row.last_spin_at) })),
    topUps: grants.map((row) => ({ at: str(row.created_at) ?? "", spins: num(row.spins), bonusSpins: num(row.bonus_spins) })),
    spins: spins.map((row) => ({ id: String(row.id), at: str(row.created_at) ?? "", prize: str(row.prize_label) ?? "Prize", rarity: str(row.prize_rarity) ?? "common", wheel: str((row.wheel as ExportRow | null)?.title), shareId: str(row.share_id), fairness: { version: row.fair_version ?? null, serverSeed: str(row.server_seed), serverSeedHash: str(row.server_seed_hash), clientSeed: str(row.client_seed), nonce: row.nonce ?? null, seedCommitment: str(row.seed_commitment), poolHash: str(row.pool_hash), poolSnapshot: (row.pool_snapshot ?? null) as Json, trace: (row.fair_trace ?? null) as Json } })),
    prizes, instantReceipts,
    wishlist: wishes.map((row) => ({ prize: str(row.prize_label) ?? "Prize", rarity: str(row.prize_rarity) ?? "common", addedAt: str(row.created_at) ?? "" })),
    messagesYouSent: messages.map((row) => ({ at: str(row.created_at) ?? "", body: str(row.body) ?? "" })),
    play: { breakUntil: str(fan.break_until), reminderDaily: reminder?.daily ?? null, reminderUpdatedAt: reminder?.updated_at ?? null },
    checkIns: checkins.map((row) => ({ day: String(row.day), recordedAt: str(row.created_at) })),
    outreach: outreach.map((row) => ({ at: str(row.created_at) ?? "", contactedAt: str(row.contacted_at) })),
    reportsYouSent: reports.map((row) => ({ at: str(row.created_at) ?? "", reason: str(row.reason) ?? "", detail: str(row.detail) })),
  }, true) as FanDataExport;
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

/** A deliberate column inventory: credentials never enter the export query.
 * Keep new feature tables/columns explicit instead of widening SELECT *. */
const CREATOR_TABLES: [string, string, string, string, string[]?][] = [
  ["wheels", "wheels", "creator_id", "id, creator_id, title, subtitle, brand_color, label_color, label_size, show_stock, is_active, active_from, active_until, archived_at, created_at, updated_at"],
  ["campaigns", "campaigns", "creator_id", "id, creator_id, name, is_active, pinned_wheel_id, created_at"],
  ["campaign_packs", "campaign_packs", "creator_id", "id, creator_id, campaign_id, label, spins, bonus_spins, amount_cents, sort_order, created_at"],
  ["prize_templates", "prize_templates", "creator_id", "id, creator_id, label, description, rarity, weight, color, emoji, created_at"],
  ["wheel_templates", "wheel_templates", "creator_id", "id, creator_id, name, title, subtitle, brand_color, prizes, created_at"],
  ["dm_templates", "dm_templates", "creator_id", "id, creator_id, title, body, created_at"],
  ["happy_hours", "happy_hours", "creator_id", "id, creator_id, wheel_id, multiplier, starts_at, ends_at, created_at"],
  ["webhooks", "webhooks", "creator_id", "id, creator_id, event, created_at"],
  ["fans", "fans", "creator_id", "id, creator_id, display_name, handle, spins_remaining, spins_granted_total, notes, tags, pity_counter, blocked_at, break_until, acked_at, acked_terms_version, leaderboard_opt_in, referral_code, referred_by_fan_id, referral_credited, last_spin_at, created_at"],
  ["grants", "grants", "creator_id", "id, creator_id, fan_id, fan_pass_id, campaign_id, spins, bonus_spins, amount_cents, created_at"],
  ["spins", "spins", "creator_id", "id, creator_id, fan_id, fan_pass_id, wheel_id, campaign_id, prize_id, prize_label, prize_rarity, prize_image_url, share_id, server_seed, server_seed_hash, client_seed, nonce, seed_commitment, fair_version, pool_hash, pool_snapshot, fair_trace, created_at"],
  ["redemptions", "redemptions", "creator_id", "id, creator_id, spin_id, status, notes, due_at, fulfilled_at, created_at"],
  ["prize_rewards", "prize_rewards", "creator_id", "prize_id, creator_id, kind, updated_at", ["prize_id"]],
  ["prize_reward_codes", "prize_reward_codes", "creator_id", "id, prize_id, creator_id, spin_id, assigned_at, created_at, erased_at"],
  ["spin_rewards", "spin_rewards", "creator_id", "spin_id, creator_id, kind, views, last_viewed_at, created_at, erased_at", ["spin_id"]],
  ["referrals", "referrals", "creator_id", "id, creator_id, referrer_fan_id, referred_fan_id, bonus_spins, credited_at, created_at"],
  ["messages", "messages", "creator_id", "id, creator_id, fan_id, sender, body, read_at, created_at"],
  ["wishlists", "wishlists", "creator_id", "id, creator_id, fan_id, prize_id, prize_label, prize_rarity, created_at"],
  ["autopilot_dismissals", "autopilot_dismissals", "creator_id", "creator_id, dedupe_key, snooze_until, created_at", ["dedupe_key"]],
  ["creator_notices", "creator_notices", "creator_id", "id, creator_id, kind, details, created_at"],
  ["fan_checkins", "fan_checkins", "creator_id", "creator_id, fan_id, day, created_at", ["fan_id", "day"]],
  ["fan_outreach", "fan_outreach", "creator_id", "id, creator_id, fan_id, kind, contacted_at, snoozed_until, template_id, created_at"],
  ["creator_media", "creator_media", "creator_id", "id, creator_id, caption, sort_order, width, height, sfw_attested_at, created_at"],
  ["storage_dispatches", "creator_storage_dispatches", "owner_id", "id, owner_id, kind, object_id, bucket, path, state, created_at, settled_at"],
  ["storage_objects", "creator_storage_objects", "owner_id", "id, owner_id, bucket, path, upload_state, cleanup_kind, media_id, attempts, last_error, created_at, updated_at, expires_at, settled_at, published_at, removed_at, last_attempt_at, next_attempt_at"],
  ["storage_deletions", "creator_storage_deletions", "owner_id", "id, owner_id, state, action, attempts, last_error, created_at, updated_at, completed_at"],
  ["push_devices", "push_subscriptions", "user_id", "id, user_id, user_agent, show_details, failures, last_success_at, created_at"],
  ["push_history", "push_log", "user_id", "user_id, item_id, tag, sent_at", ["item_id"]],
  ["access_request", "creator_applications", "profile_id", "id, profile_id, email, display_name, socials, audience_size, note, status, decided_at, created_at"],
  ["agency_memberships", "org_members", "profile_id", "id, profile_id, org_id, role, created_at"],
  ["agencies_owned", "orgs", "owner_id", "id, owner_id, name, billing_model, created_at"],
];
const ACCOUNT_COLUMNS = "theme, id, email, display_name, avatar_url, creator_note, role, approval_status, is_active, features, org_id, public_slug, public_tagline, tip_url, chat_intro, chat_outro, leaderboard_enabled, notify_new_spin, notify_low_balance, notify_messages, notifications_seen_at, onboarding_dismissed, pwa_icon_mode, terms_version, terms_accepted_at, created_at";

/** Session/RLS reads only. Parent IDs are themselves limited to this account,
 * so agency access to another creator never expands the business export. */
export async function exportCreatorData(): Promise<CreatorDataExport | null> {
  if (!isSupabaseConfigured()) return mockExportCreatorData();
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const uid = user.id;
  const { data: profile, error: profileErr } = await sb.from("profiles").select(ACCOUNT_COLUMNS).eq("id", uid).maybeSingle();
  const sections: Record<string, ExportRow[]> = {};
  const failed: string[] = [], truncated: string[] = [];
  const store = (section: string, result: ExportResult<ExportRow>) => {
    sections[section] = result.rows;
    if (result.failed) failed.push(section);
    if (result.truncated) truncated.push(section);
  };
  await Promise.all(CREATOR_TABLES.map(async ([section, table, owner, columns, order]) => {
    store(section, await readRows(sb, table, columns, [[owner, uid]], order));
  }));
  const related = async (section: string, table: string, columns: string, parent: string, ids: unknown[], order = ["id"]) => {
    const all: ExportResult<ExportRow> = { rows: [], failed: false, truncated: false };
    for (let at = 0; at < ids.length; at += 100) {
      const part = await readRows(sb, table, columns, [], order, [parent, ids.slice(at, at + 100)], EXPORT_ROW_CAP - all.rows.length);
      all.rows.push(...part.rows); all.failed ||= part.failed; all.truncated ||= part.truncated;
      if (part.failed || part.truncated) break;
    }
    store(section, all);
  };
  const wheelIds = sections.wheels.map((row) => row.id);
  const orgIds = sections.agencies_owned.map((row) => row.id);
  const memberIds = sections.agency_memberships.map((row) => row.id);
  await Promise.all([
    related("prizes", "prizes", "id, wheel_id, label, description, rarity, weight, stock, cost_cents, color, emoji, image_url, sort_order, created_at", "wheel_id", wheelIds),
    related("agency_owned_members", "org_members", "id, org_id, profile_id, role, created_at", "org_id", orgIds),
    related("agency_invitations", "org_invites", "id, org_id, email, status, created_at", "org_id", orgIds),
    related("agency_scopes", "org_member_creators", "member_id, creator_id", "member_id", memberIds, ["member_id", "creator_id"]),
  ]);
  const ownedMemberIds = sections.agency_owned_members.map((row) => row.id);
  await related("agency_owned_scopes", "org_member_creators", "member_id, creator_id", "member_id", ownedMemberIds, ["member_id", "creator_id"]);
  store("fan_links", await readRows(sb, "fan_passes", "id, token, fan_id, wheel_id, campaign_id, created_at, is_active, self_excluded_at, spins_remaining, spins_granted_total, last_spin_at, next_server_seed_hash", [["creator_id", uid]]));
  sections.fan_links = sections.fan_links.map(({ token, ...row }) => ({ ...row, link_ends_with: maskToken(str(token)) }));
  for (const [parent, children] of [["wheels", ["prizes"]], ["agencies_owned", ["agency_owned_members", "agency_invitations", "agency_owned_scopes"]], ["agency_memberships", ["agency_scopes"]], ["agency_owned_members", ["agency_owned_scopes"]]] as const) {
    if (failed.includes(parent)) failed.push(...children);
    if (truncated.includes(parent)) truncated.push(...children);
  }
  if (profileErr || !profile) failed.push("account");
  return safeExportValue({
    format: CREATOR_EXPORT_FORMAT, exportedAt: new Date().toISOString(), about: CREATOR_EXPORT_ABOUT,
    ...exportStatus(failed, truncated), excluded: [...CREATOR_EXPORT_EXCLUDED],
    account: { ...(profile ?? {}), theme: exportCreatorTheme((profile as ExportRow | null)?.theme), id: uid, email: user.email ?? null, created_at: user.created_at, last_sign_in_at: user.last_sign_in_at ?? null, two_factor: (user.factors ?? []).map((factor) => ({ id: factor.id, type: factor.factor_type, name: factor.friendly_name ?? null, status: factor.status, created_at: factor.created_at })) },
    sections,
  }) as CreatorDataExport;
}
