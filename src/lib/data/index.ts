import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import { externalUrl } from "@/lib/format";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import type { Rarity, WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";
import type { AdminAccount, AdminOverview, AppRole, HappyHourStatus } from "./types";
import { provisionCreatorUser } from "./creatorAccount";
import {
  mockGetAdminOverview,
  mockUpdateAccount,
  mockCreateAccount,
  mockClearMyData,
  mockGetOnboardingDismissed,
  mockSetOnboardingDismissed,
  mockGetMyAccount,
  mockSetMyDisplayName,
  mockSetMyNotificationPrefs,
  mockSetActiveWheelBrandColor,
  mockGetPublicWheelTeaser,
} from "./mock";
import { WHEEL_SELECT, toWheelConfig } from "./shared";
import type { DbWheelRow } from "./shared";
import { ensureWheelId, getActiveHappyHour, resolveActiveWheelId } from "./wheels";

export type { FanPassView, SpinError } from "./shared";
export {
  getWheel,
  saveWheel,
  prizeRow,
  getWheelById,
  listWheels,
  createWheel,
  duplicateWheel,
  archiveWheel,
  unarchiveWheel,
  deleteWheel,
  setActiveWheel,
  setWheelSchedule,
} from "./wheels";
export { listWebhooks, createWebhook, deleteWebhook, fireWebhooks } from "./webhooks";
export { getFanPass, spin, completeClaimedSpin, createPass } from "./spins";
export {
  editGrant,
  grantSpins,
  listFans,
  getCreatorCrm,
  getFanDetail,
  deleteFan,
  setFanBlocked,
  reportCreator,
  selfExclude,
  updateFanMeta,
  ackFan,
} from "./fans";
export type { CrmFan, CreatorCrm } from "./fans";
export {
  createCampaign,
  listCampaigns,
  getCampaignStats,
  getUncategorizedStats,
  listCampaignPacks,
  createCampaignPack,
  updateCampaignPack,
  deleteCampaignPack,
  setCampaignPinnedWheel,
  renameCampaign,
  deleteCampaign,
} from "./campaigns";
export type { UncategorizedStats } from "./campaigns";
export {
  listDmTemplates,
  createDmTemplate,
  deleteDmTemplate,
  sendFanMessage,
  getFanMessages,
  listThreads,
  getThread,
  sendCreatorMessage,
  getChatSettings,
  setChatSettings,
  ensureChatIntro,
  sendChatOutro,
} from "./inbox";
export {
  listPrizeTemplates,
  createPrizeTemplate,
  deletePrizeTemplate,
  listWheelTemplates,
  createWheelTemplate,
  deleteWheelTemplate,
} from "./templates";
export {
  getOverview,
  getMetricsExtra,
  getEngagementHeatmap,
  getPrizeRoi,
  getProfitSummary,
  getCohortRetention,
  getAutopilot,
  dismissAutopilotCard,
} from "./analytics";
export type { ProfitSummary, AutopilotAction, AutopilotCard } from "./analytics";
export { setRedemptionStatus, setRedemptionMeta } from "./fulfilment";
export {
  listHappyHours,
  createHappyHour,
  deleteHappyHour,
  getShareCard,
  getSpinVerification,
  addWishlist,
  removeWishlist,
  getWishlistDemand,
  setLeaderboardEnabled,
  setFanLeaderboardOptIn,
  getLeaderboard,
  getRecentWins,
} from "./boosts";
export type { RecentWin } from "./boosts";
export { getReferralOverview, getReferralStats } from "./referrals";

/**
 * Wipe ALL of the signed-in creator's data — wheels, prizes, fans, links, spins,
 * grants, redemptions, campaigns, packs, templates, happy hours — leaving a
 * fresh account. Destructive and irreversible. Child rows cascade from the
 * parents below; we delete the creator-owned parents explicitly.
 */
export async function clearMyData(): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockClearMyData();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // fans → cascades fan_passes, spins, grants, messages, wishlists, referrals.
  // wheels → cascades prizes, (wheel-scoped) passes, happy_hours.
  // Then standalone creator-owned tables.
  const tables = [
    "fans",
    "wheels",
    "campaigns",
    "campaign_packs",
    "dm_templates",
    "prize_templates",
    "wheel_templates",
    "happy_hours",
    "webhooks",
    "autopilot_dismissals",
  ];
  for (const t of tables) {
    const { error } = await sb.from(t).delete().eq("creator_id", user.id);
    if (error) return { error: `db_error:${t}` };
  }

  // A true fresh start also resets profile preferences (via the SECURITY
  // DEFINER self-update RPCs — profiles_update RLS is admin-only): the
  // Get-started checklist comes back, and the public leaderboard returns to
  // its off default instead of silently staying live from before the reset.
  // Best-effort: a pref that fails to reset shouldn't fail the whole wipe.
  await Promise.allSettled([
    sb.rpc("set_onboarding_dismissed", { p_dismissed: false }),
    sb.rpc("set_leaderboard_enabled", { p_enabled: false }),
    sb.rpc("set_chat_settings", { p_intro: "", p_outro: "" }),
  ]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin (cross-account)
// ---------------------------------------------------------------------------

// Admin gate = the shared is_admin() predicate (role AND is_active) from
// src/lib/auth/adminCheck.ts. A suspended admin must NOT retain admin power;
// these gates front service-role actions that bypass RLS (create/delete
// accounts), so the check has to live here too — not only in RLS policies.

/** Whether the signed-in user is an admin. Server-only; used to gate admin-only
 *  UI such as the in-app debug console. Returns false in demo mode (no Supabase). */
export async function isCurrentUserAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const sb = await createClient();
  return isActiveAdmin(sb);
}

/**
 * One-time admin bootstrap: promote the signed-in user to admin IF their email
 * is in the ADMIN_EMAILS env allowlist. Lets the owner claim admin without
 * touching the database. No-op (and safe) when the allowlist is unset/empty.
 */
export async function claimAdmin(): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const allow = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0) return { error: "not_configured" };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const email = (user.email ?? "").toLowerCase();
  if (!allow.includes(email)) return { error: "not_allowed" };

  // Service-role write: promote + approve this profile (RLS profiles_update is
  // admin-only, and the user isn't admin yet — that's the bootstrap chicken/egg).
  const svc = createServiceClient();

  // Lock: this bootstrap can ONLY ever create the FIRST admin. Once any admin
  // exists, it's permanently inert (further admin management goes through the
  // proper roles system / an existing admin).
  const { count: adminCount } = await svc
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
  if ((adminCount ?? 0) > 0) return { error: "already_bootstrapped" };

  const { error } = await svc
    .from("profiles")
    .update({ role: "admin", approval_status: "approved", is_active: true })
    .eq("id", user.id);
  return error ? { error: "db_error" } : { ok: true };
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

// --- Agency console (orgs + scoped seats) -----------------------------------

export type OrgRole = "owner" | "manager" | "chatter" | "fulfiller" | "analyst";

export interface OrgCreatorStat {
  id: string;
  displayName: string;
  email: string;
  wheels: number;
  fans: number;
  spins: number;
  pending: number;
  revenue: number; // cents
}
export interface OrgMember {
  id: string;
  profileId: string;
  email: string;
  displayName: string;
  role: OrgRole;
}
export interface PendingInvite {
  id: string;
  email: string;
}
export interface AgencyOverview {
  org: { id: string; name: string } | null;
  isOwner: boolean;
  totals: { creators: number; fans: number; spins: number; pending: number; revenue: number };
  creators: OrgCreatorStat[];
  members: OrgMember[];
  invites: PendingInvite[];
}

/** The agency roll-up for the org the signed-in user owns or belongs to. */
export async function getAgencyOverview(): Promise<AgencyOverview | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  // Resolve the user's org: one they own, else one they're a member of.
  const { data: ownedOrg } = await sb
    .from("orgs")
    .select("id, name")
    .eq("owner_id", user.id)
    .maybeSingle();
  let org = ownedOrg as { id: string; name: string } | null;
  const isOwner = !!org;
  if (!org) {
    const { data: mem } = await sb
      .from("org_members")
      .select("org:orgs(id, name)")
      .eq("profile_id", user.id)
      .maybeSingle();
    org = (mem as unknown as { org: { id: string; name: string } | null } | null)?.org ?? null;
  }
  if (!org) return null;

  const { data: statRows } = await sb.rpc("org_account_stats", { p_org: org.id });
  const creators: OrgCreatorStat[] = ((statRows ?? []) as {
    id: string;
    email: string | null;
    display_name: string | null;
    wheels: number;
    fans: number;
    spins: number;
    pending: number;
    revenue: number;
  }[]).map((r) => ({
    id: r.id,
    displayName: r.display_name ?? r.email ?? "Creator",
    email: r.email ?? "",
    wheels: Number(r.wheels),
    fans: Number(r.fans),
    spins: Number(r.spins),
    pending: Number(r.pending),
    revenue: Number(r.revenue),
  }));

  // Pending outgoing invites (owner-only view; RLS returns none to staff).
  const { data: inviteRows } = await sb
    .from("org_invites")
    .select("id, email")
    .eq("org_id", org.id)
    .eq("status", "pending");
  const invites: PendingInvite[] = ((inviteRows ?? []) as { id: string; email: string }[]).map(
    (r) => ({ id: r.id, email: r.email })
  );

  const { data: memberRows } = await sb
    .from("org_members")
    .select("id, role, profile:profiles(id, email, display_name)")
    .eq("org_id", org.id);
  const members: OrgMember[] = ((memberRows ?? []) as unknown as {
    id: string;
    role: OrgRole;
    profile: { id: string; email: string | null; display_name: string | null } | null;
  }[]).map((m) => ({
    id: m.id,
    profileId: m.profile?.id ?? "",
    email: m.profile?.email ?? "",
    displayName: m.profile?.display_name ?? m.profile?.email ?? "Member",
    role: m.role,
  }));

  return {
    org,
    isOwner,
    totals: {
      creators: creators.length,
      fans: creators.reduce((s, c) => s + c.fans, 0),
      spins: creators.reduce((s, c) => s + c.spins, 0),
      pending: creators.reduce((s, c) => s + c.pending, 0),
      revenue: creators.reduce((s, c) => s + c.revenue, 0),
    },
    creators,
    members,
    invites,
  };
}

/** Create the caller's agency org (or return their existing one). */
export async function createOrg(name: string): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const { error } = await sb.rpc("org_create", { p_name: name });
  return error ? { error: "db_error" } : { ok: true };
}

type OrgRpc =
  | { fn: "org_invite_creator"; args: { p_org: string; p_email: string } }
  | { fn: "org_invite_revoke"; args: { p_invite: string } }
  | { fn: "org_invite_respond"; args: { p_invite: string; p_accept: boolean } }
  | { fn: "org_remove_creator"; args: { p_org: string; p_creator: string } }
  | { fn: "org_add_member"; args: { p_org: string; p_email: string; p_role: OrgRole } }
  | { fn: "org_remove_member"; args: { p_member: string } }
  | { fn: "org_scope_creator"; args: { p_member: string; p_creator: string; p_on: boolean } };

/** Run an owner-guarded agency RPC; the RPC returns a status string. */
async function agencyRpc(call: OrgRpc): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const { data, error } = await sb.rpc(call.fn, call.args);
  if (error) return { error: "db_error" };
  return data === "ok" ? { ok: true } : { error: String(data) };
}

// Creators join via consent: the owner sends an invite, the creator accepts.
export const inviteOrgCreator = (orgId: string, email: string) =>
  agencyRpc({ fn: "org_invite_creator", args: { p_org: orgId, p_email: email } });
export const revokeOrgInvite = (inviteId: string) =>
  agencyRpc({ fn: "org_invite_revoke", args: { p_invite: inviteId } });
export const respondToOrgInvite = (inviteId: string, accept: boolean) =>
  agencyRpc({ fn: "org_invite_respond", args: { p_invite: inviteId, p_accept: accept } });
export const removeOrgCreator = (orgId: string, creatorId: string) =>
  agencyRpc({ fn: "org_remove_creator", args: { p_org: orgId, p_creator: creatorId } });
export const addOrgMember = (orgId: string, email: string, role: OrgRole) =>
  agencyRpc({ fn: "org_add_member", args: { p_org: orgId, p_email: email, p_role: role } });
export const removeOrgMember = (memberId: string) =>
  agencyRpc({ fn: "org_remove_member", args: { p_member: memberId } });
export const scopeOrgCreator = (memberId: string, creatorId: string, on: boolean) =>
  agencyRpc({ fn: "org_scope_creator", args: { p_member: memberId, p_creator: creatorId, p_on: on } });

export interface MyInvite {
  id: string;
  orgId: string;
  orgName: string;
}

/** Pending agency invites addressed to the signed-in user (for their dashboard). */
export async function getMyInvites(): Promise<MyInvite[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];
  const { data } = await sb
    .from("org_invites")
    .select("id, org_id, status, org:orgs(name)")
    .eq("status", "pending");
  return ((data ?? []) as unknown as {
    id: string;
    org_id: string;
    org: { name: string } | null;
  }[]).map((r) => ({ id: r.id, orgId: r.org_id, orgName: r.org?.name ?? "An agency" }));
}

export async function updateAccount(
  id: string,
  patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    return mockUpdateAccount(id, patch) ? { ok: true } : { error: "not_found" };
  }

  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

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
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

  // Service role is required to create a user without a sign-up flow.
  return provisionCreatorUser(createServiceClient(), email, password, displayName);
}

// --- Gated signups: request → admin approval queue ---------------------------

export type ApprovalStatus = "pending" | "approved" | "rejected" | "none";

/** The signed-in user's approval status (drives the dashboard gate). */
export async function getMyApprovalStatus(): Promise<ApprovalStatus> {
  if (!isSupabaseConfigured()) return "approved"; // demo: always in
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return "none";
  const { data } = await sb
    .from("profiles")
    .select("approval_status, role")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as { approval_status: ApprovalStatus; role: AppRole } | null;
  if (!row) return "none";
  if (row.role === "admin") return "approved";
  return row.approval_status;
}

/** A signed-in pending user submits their creator details for vetting. */
export async function submitCreatorApplication(input: {
  displayName?: string;
  socials?: string;
  audienceSize?: string;
  note?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.from("creator_applications").upsert(
    {
      profile_id: user.id,
      email: user.email ?? null,
      display_name: input.displayName?.slice(0, 120) ?? null,
      socials: input.socials?.slice(0, 600) ?? null,
      audience_size: input.audienceSize?.slice(0, 120) ?? null,
      note: input.note?.slice(0, 1000) ?? null,
      status: "pending",
    },
    { onConflict: "profile_id" }
  );
  return error ? { error: "db_error" } : { ok: true };
}

export interface CreatorApplication {
  id: string;
  profileId: string;
  email: string | null;
  displayName: string | null;
  socials: string | null;
  audienceSize: string | null;
  note: string | null;
  status: ApprovalStatus;
  createdAt: string;
}

/** Admin: the pending (and recently-decided) creator applications. */
export async function listCreatorApplications(): Promise<CreatorApplication[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return [];

  const { data } = await sb
    .from("creator_applications")
    .select(
      "id, profile_id, email, display_name, socials, audience_size, note, status, created_at"
    )
    .order("created_at", { ascending: false });

  return ((data ?? []) as {
    id: string;
    profile_id: string;
    email: string | null;
    display_name: string | null;
    socials: string | null;
    audience_size: string | null;
    note: string | null;
    status: ApprovalStatus;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    email: r.email,
    displayName: r.display_name,
    socials: r.socials,
    audienceSize: r.audience_size,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** Admin: approve or reject a creator application (flips the profile gate too). */
export async function decideCreatorApplication(
  profileId: string,
  decision: "approved" | "rejected"
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

  const now = new Date().toISOString();
  const { error: aErr } = await sb
    .from("creator_applications")
    .update({ status: decision, decided_at: now })
    .eq("profile_id", profileId);
  if (aErr) return { error: "db_error" };

  const { error: pErr } = await sb
    .from("profiles")
    .update({ approval_status: decision })
    .eq("id", profileId);
  return pErr ? { error: "db_error" } : { ok: true };
}

/** Whether the signed-in creator has dismissed the Get-started checklist. */
export async function getOnboardingDismissed(): Promise<boolean> {
  if (!isSupabaseConfigured()) return mockGetOnboardingDismissed();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return false;

  const { data } = await sb
    .from("profiles")
    .select("onboarding_dismissed")
    .eq("id", user.id)
    .maybeSingle();
  return (data as { onboarding_dismissed: boolean } | null)?.onboarding_dismissed ?? false;
}

/** Persist the creator's Get-started checklist dismissal (account, not browser). */
export async function setOnboardingDismissed(
  dismissed: boolean
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetOnboardingDismissed(dismissed);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.rpc("set_onboarding_dismissed", {
    p_dismissed: dismissed,
  });
  return error ? { error: "db_error" } : { ok: true };
}

// --- Public teaser ----------------------------------------------------------

/**
 * A token-free preview of a creator's active wheel + current happy hour, for a
 * public landing page. Service role; no spinning, no fan identity.
 */
export async function getPublicWheelTeaser(
  creatorId: string
): Promise<{ creatorTitle: string; wheel: WheelConfig; happyHour: HappyHourStatus } | null> {
  if (!isSupabaseConfigured()) return mockGetPublicWheelTeaser(creatorId);

  const sb = createServiceClient();
  const wheelId = await resolveActiveWheelId(sb, creatorId, new Date());
  if (!wheelId) return null;

  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return null;

  const { data: profile } = await sb
    .from("profiles")
    .select("display_name")
    .eq("id", creatorId)
    .maybeSingle();
  const creatorTitle =
    (profile as { display_name: string | null } | null)?.display_name ??
    "Creator";

  const happyHour = await getActiveHappyHour(sb, wheelId, new Date());
  return {
    creatorTitle,
    wheel: toWheelConfig(wheelData as unknown as DbWheelRow),
    happyHour,
  };
}

// --- SFW link-in-bio public profile -----------------------------------------

export interface PublicProfile {
  creatorTitle: string;
  tagline: string | null;
  brandColor: string;
  /** The creator's avatar — shown as the page's hero in place of the 🎡. */
  avatarUrl: string | null;
  // SFW prize teaser: labels + rarities only (no explicit media), best first.
  prizes: { label: string; rarity: Rarity; emoji?: string }[];
  hasTipUrl: boolean;
}

/** Public, SFW landing data for a creator's link-in-bio page (by slug). */
export async function getPublicProfileBySlug(
  slug: string
): Promise<{ profile: PublicProfile; tipUrl: string | null } | null> {
  if (!isSupabaseConfigured()) {
    return {
      profile: {
        creatorTitle: "Demo Creator",
        tagline: "Spin my wheel — every spin wins 🎡",
        brandColor: "#ec4899",
        avatarUrl: null,
        prizes: SAMPLE_WHEEL.prizes.slice(0, 6).map((p) => ({
          label: p.label,
          rarity: p.rarity,
          emoji: p.emoji,
        })),
        hasTipUrl: true,
      },
      tipUrl: "#",
    };
  }
  const sb = createServiceClient();
  const { data: prof } = await sb
    .from("profiles")
    .select("id, display_name, public_tagline, tip_url, avatar_url")
    .eq("public_slug", slug)
    .maybeSingle();
  const p = prof as {
    id: string;
    display_name: string | null;
    public_tagline: string | null;
    tip_url: string | null;
    avatar_url: string | null;
  } | null;
  if (!p) return null;

  const wheelId = await resolveActiveWheelId(sb, p.id, new Date());
  let brandColor = "#ec4899";
  let prizes: { label: string; rarity: Rarity; emoji?: string }[] = [];
  if (wheelId) {
    const { data: wheelData } = await sb
      .from("wheels")
      .select(WHEEL_SELECT)
      .eq("id", wheelId)
      .maybeSingle();
    if (wheelData) {
      const cfg = toWheelConfig(wheelData as unknown as DbWheelRow);
      brandColor = cfg.brandColor ?? "#ec4899";
      prizes = cfg.prizes
        .slice()
        .sort(
          (a, b) =>
            RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
        )
        .slice(0, 6)
        .map((pr) => ({ label: pr.label, rarity: pr.rarity, emoji: pr.emoji }));
    }
  }

  return {
    profile: {
      creatorTitle: p.display_name ?? "Creator",
      tagline: p.public_tagline,
      brandColor,
      avatarUrl: p.avatar_url,
      prizes,
      hasTipUrl: !!p.tip_url,
    },
    tipUrl: p.tip_url,
  };
}

/** The signed-in creator's editable public-profile fields. */
export async function getMyPublicProfile(): Promise<{
  slug: string | null;
  tipUrl: string | null;
  tagline: string | null;
  note: string | null;
  avatarUrl: string | null;
}> {
  if (!isSupabaseConfigured())
    return { slug: "demo-creator", tipUrl: "", tagline: "", note: "", avatarUrl: "" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { slug: null, tipUrl: null, tagline: null, note: null, avatarUrl: null };
  const { data } = await sb
    .from("profiles")
    .select("public_slug, tip_url, public_tagline, creator_note, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as {
    public_slug: string | null;
    tip_url: string | null;
    public_tagline: string | null;
    creator_note: string | null;
    avatar_url: string | null;
  } | null;
  return {
    slug: row?.public_slug ?? null,
    tipUrl: row?.tip_url ?? null,
    tagline: row?.public_tagline ?? null,
    note: row?.creator_note ?? null,
    avatarUrl: row?.avatar_url ?? null,
  };
}

// Cap stored avatar URLs so a multi-KB string can't be persisted via the note RPC.
const MAX_AVATAR_URL_LEN = 2048;

/** Creator updates their SFW link-in-bio fields + fan-page personal note. */
/** The stored form of a public slug (the `/c/<slug>` path segment). */
export function normalizePublicSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function setMyPublicProfile(input: {
  slug?: string;
  tipUrl?: string;
  tagline?: string;
  note?: string;
  avatarUrl?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  // Atomic partial update: pass NULL for any field omitted from the request so
  // the RPC leaves that column unchanged (migration 0033). This replaces the
  // route's old read-modify-write, which raced concurrent partial updates
  // (TOCTOU) and could wipe an omitted note/avatar.
  if (input.slug !== undefined || input.tipUrl !== undefined || input.tagline !== undefined) {
    const slug = input.slug !== undefined ? normalizePublicSlug(input.slug) : null;
    const { error } = await sb.rpc("set_public_profile", {
      p_slug: slug,
      p_tip_url: input.tipUrl !== undefined ? externalUrl(input.tipUrl) : null,
      p_tagline: input.tagline !== undefined ? input.tagline : null,
    });
    if (error) return { error: "db_error" };
  }
  if (input.note !== undefined || input.avatarUrl !== undefined) {
    // Defense in depth: never persist an avatar URL with a non-http(s) scheme
    // (blocks data:/javascript:) or an oversized value, even if a caller skips
    // the validated upload path. An empty string clears the avatar; an omitted
    // avatar (null) leaves the current one unchanged.
    let avatar: string | null = null;
    if (input.avatarUrl !== undefined) {
      avatar = input.avatarUrl;
      if (avatar !== "") {
        if (avatar.length > MAX_AVATAR_URL_LEN) return { error: "invalid_avatar_url" };
        let protocol: string;
        try {
          protocol = new URL(avatar).protocol;
        } catch {
          return { error: "invalid_avatar_url" };
        }
        if (protocol !== "http:" && protocol !== "https:") {
          return { error: "invalid_avatar_url" };
        }
      }
    }
    const { error: noteError } = await sb.rpc("set_creator_note", {
      p_note: input.note !== undefined ? input.note : null,
      p_avatar: avatar,
    });
    if (noteError) return { error: "db_error" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Account settings (Phase 9 #6): display name, email, notification prefs.
// profiles_update is admin-only, so self-updates go through the narrow
// SECURITY DEFINER RPCs added in migration 0025 (set_display_name,
// set_notification_prefs) — same pattern as set_public_profile / set_creator_note.
// ---------------------------------------------------------------------------

export interface NotificationPrefs {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}

export interface MyAccount {
  email: string | null;
  displayName: string | null;
  notifications: NotificationPrefs;
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  newSpin: true,
  lowBalance: true,
  messages: true,
};

/** The signed-in creator's account settings (display name, email, notify prefs). */
export async function getMyAccount(): Promise<MyAccount> {
  if (!isSupabaseConfigured()) return mockGetMyAccount();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return { email: null, displayName: null, notifications: { ...DEFAULT_NOTIFICATION_PREFS } };
  }
  const { data } = await sb
    .from("profiles")
    .select("display_name, notify_new_spin, notify_low_balance, notify_messages")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as {
    display_name: string | null;
    notify_new_spin: boolean | null;
    notify_low_balance: boolean | null;
    notify_messages: boolean | null;
  } | null;
  return {
    email: user.email ?? null,
    displayName: row?.display_name ?? null,
    notifications: {
      newSpin: row?.notify_new_spin ?? true,
      lowBalance: row?.notify_low_balance ?? true,
      messages: row?.notify_messages ?? true,
    },
  };
}

/** Update only the creator's display name (self-update RPC). Blank is ignored. */
export async function setMyDisplayName(
  name: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetMyDisplayName(name);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.rpc("set_display_name", { p_name: name });
  return error ? { error: "db_error" } : { ok: true };
}

/** Update only the creator's notification preferences (self-update RPC). */
export async function setMyNotificationPrefs(
  prefs: NotificationPrefs
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetMyNotificationPrefs(prefs);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.rpc("set_notification_prefs", {
    p_new_spin: prefs.newSpin,
    p_low_balance: prefs.lowBalance,
    p_messages: prefs.messages,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Set the brand color of the creator's currently-active wheel. The public
 * /c/[slug] page derives its brand color from the active wheel, so this powers
 * the Settings → Public profile brand-color control (with a live preview).
 * wheels has a creator-scoped RW policy, so the auth client may write directly.
 */
export async function setActiveWheelBrandColor(
  color: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetActiveWheelBrandColor(color);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  await ensureWheelId(sb, user.id);
  const wheelId = await resolveActiveWheelId(sb, user.id, new Date());
  if (!wheelId) return { error: "no_wheel" };
  const { error } = await sb
    .from("wheels")
    .update({ brand_color: color, updated_at: new Date().toISOString() })
    .eq("id", wheelId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}
