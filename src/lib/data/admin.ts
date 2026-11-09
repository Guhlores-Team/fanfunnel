import { creatorMfaStepUpResponse } from "@/lib/auth/stepUp";
// Data layer — admin console, agency (orgs + seats), account provisioning
// and the gated-signup approval queue.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import type { AdminAccount, AdminOverview, AppRole } from "./types";
import { provisionCreatorUser } from "./creatorAccount";
import { recordAudit } from "./audit";
import { leaveApprovalNotice, sendApprovalEmail } from "@/lib/account/approvalNotice";
import { runAfterResponse } from "@/lib/afterResponse";
import { mockGetAdminOverview, mockUpdateAccount, mockCreateAccount } from "./mock";
import { NEUTRAL_CREATOR_TITLE, publicCreatorName } from "@/lib/publicCreator";

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
  if (await creatorMfaStepUpResponse(sb, user)) return { error: "mfa_required" };
  const email = (user.email ?? "").toLowerCase();
  if (!allow.includes(email)) return { error: "not_allowed" };

  // Service-role call: the bootstrap_first_admin RPC (0065) takes the 0062
  // active-admin fence, refuses once ANY admin exists ("already_bootstrapped"),
  // requires this account's own confirmed email, and promotes + approves in
  // the same transaction, so two racing claims can never both become admin.
  // RLS profiles_update is admin-only (the bootstrap chicken/egg). Any RPC
  // error or unknown answer fails closed.
  const svc = createServiceClient();
  const { data: outcome, error } = await svc.rpc("bootstrap_first_admin", { p_user: user.id, p_email: email });
  if (error) return { error: "db_error" };
  if (outcome === "already_bootstrapped" || outcome === "email_unconfirmed") return { error: outcome };
  if (outcome !== "ok") return { error: "db_error" };
  await recordAudit({ actorId: user.id, action: "admin.bootstrap", targetType: "profile", targetId: user.id });
  return { ok: true };
}

/**
 * T4: the age of each creator's oldest pending prize, next to the pending
 * count. Read with the admin's own session (redemptions_select allows
 * is_admin()), one indexed row per account that has any pending; a failed
 * read leaves the age unknown rather than failing the panel.
 */
async function addOldestPending(sb: Awaited<ReturnType<typeof createClient>>, accounts: AdminAccount[]): Promise<void> {
  await Promise.all(accounts.filter((a) => a.pending > 0).map(async (a) => {
    const { data, error } = await sb
      .from("redemptions")
      .select("created_at")
      .eq("creator_id", a.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);
    const row = !error && Array.isArray(data) ? (data[0] as { created_at?: string } | undefined) : undefined;
    a.oldestPendingAt = row?.created_at ?? null;
  }));
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
  await addOldestPending(sb, accounts);

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
  /** null: invited to join as a creator; otherwise the seat role on acceptance (0068). */
  role: OrgRole | null;
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
    revenue: number | null;
  }[]).map((r) => ({
    id: r.id,
    // M1: org_account_stats masks the e-mail; a name that is itself an
    // address is dropped here too, so the masked e-mail (or the neutral label)
    // shows instead.
    displayName: publicCreatorName(r.display_name) ?? r.email ?? NEUTRAL_CREATOR_TITLE,
    email: r.email ?? "",
    wheels: Number(r.wheels),
    fans: Number(r.fans),
    spins: Number(r.spins),
    pending: Number(r.pending),
    // 0068: e-mail and revenue are null for a scoped seat that may not manage
    // the creator (the stats RPC masks them); an owner/manager sees both.
    revenue: Number(r.revenue ?? 0),
  }));

  // Pending outgoing invites (owner-only view; RLS returns none to staff).
  const { data: inviteRows } = await sb
    .from("org_invites")
    .select("id, email, role")
    .eq("org_id", org.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString());
  const invites: PendingInvite[] = ((inviteRows ?? []) as { id: string; email: string; role: OrgRole | null }[]).map(
    (r) => ({ id: r.id, email: r.email, role: r.role ?? null })
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
  // A36: the demo has no agencies; say so instead of answering ok and keeping nothing.
  if (!isSupabaseConfigured()) return { error: "demo_only" };
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
  | { fn: "org_scope_creator"; args: { p_member: string; p_creator: string; p_on: boolean } }
  | { fn: "org_leave"; args: { p_org: string } };

/** Run an owner-guarded agency RPC; the RPC returns a status string. */
async function agencyRpc(call: OrgRpc): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { error: "demo_only" };
  const sb = await createClient();
  const { data, error } = await sb.rpc(call.fn, call.args);
  if (error) return { error: "db_error" };
  return data === "ok" ? { ok: true } : { error: String(data) };
}

// Creators and staff join via consent: the owner sends an invite, the invitee
// accepts (org_invite_respond). Both senders answer "ok" for any address
// (0068: no account enumeration); the invitation shows up for that account
// if and when it exists and is active.
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
/** The signed-in user leaves an agency: its own seat, and as a member creator
 *  the org itself (org_leave, 0071). Seats are only ever created by accepting
 *  an invitation, so leaving is the user's own way back out. */
export const leaveOrg = (orgId: string) => agencyRpc({ fn: "org_leave", args: { p_org: orgId } });

export interface MyInvite {
  id: string;
  orgId: string;
  orgName: string;
  /** null: join as a creator; otherwise the staff seat offered (0068). */
  role: OrgRole | null;
}

/** Pending agency invites addressed to the signed-in user (for their dashboard). */
export async function getMyInvites(): Promise<MyInvite[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user?.email) return [];
  const { data } = await sb
    .from("org_invites")
    .select("id, org_id, status, role, org:orgs(name)")
    .eq("status", "pending")
    .eq("email", user.email.trim().toLowerCase())
    .gt("expires_at", new Date().toISOString());
  return ((data ?? []) as unknown as {
    id: string;
    org_id: string;
    role: OrgRole | null;
    org: { name: string } | null;
  }[]).map((r) => ({ id: r.id, orgId: r.org_id, orgName: r.org?.name ?? "An agency", role: r.role ?? null }));
}

export async function updateAccount(
  id: string,
  patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    try { return mockUpdateAccount(id, patch) ? { ok: true } : { error: "not_found" }; }
    catch (error) { return { error: error instanceof Error && error.message === "last_admin" ? "last_admin" : "db_error" }; }
  }

  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

  const upd: Record<string, unknown> = {};
  if (patch.role) upd.role = patch.role;
  if (typeof patch.isActive === "boolean") upd.is_active = patch.isActive;
  if (patch.features) upd.features = patch.features;
  if (Object.keys(upd).length === 0) return { ok: true };

  const { data, error } = await sb.from("profiles").update(upd).eq("id", id).select("id").maybeSingle();
  if (error) return { error: error.message === "last_active_admin" ? "last_admin"
    : error.message === "account cleanup pending" ? "account_cleanup_pending"
    : error.code === "42501" ? "forbidden" : "db_error" };
  // An RLS-filtered or absent target is not a successful mutation/audit event.
  return data ? { ok: true } : { error: "not_found" };
}

export async function createCreatorAccount(
  email: string,
  password: string,
  displayName: string
): Promise<{ ok: true; id?: string } | { error: string }> {
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
  if (!isSupabaseConfigured()) return { error: "demo_only" };
  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

  const now = new Date().toISOString();
  const { error: aErr } = await sb
    .from("creator_applications")
    .update({ status: decision, decided_at: now })
    .eq("profile_id", profileId);
  if (aErr) return { error: "db_error" };

  // A30: only a real transition to approved leaves a notice and an e-mail, so
  // re-approving (or two admins approving at once) never notifies twice: the
  // approve update itself matches only a row that is not approved yet, and
  // only the request whose update changed the row notifies.
  let update = sb.from("profiles").update({ approval_status: decision }).eq("id", profileId);
  if (decision === "approved") update = update.neq("approval_status", "approved");
  const { data: updated, error: pErr } = await update.select("id").maybeSingle();
  if (pErr) return { error: "db_error" };
  if (decision === "approved" && updated) {
    const svc = createServiceClient();
    await leaveApprovalNotice(svc, profileId);
    runAfterResponse(() => sendApprovalEmail(svc, profileId));
  }
  return { ok: true };
}
