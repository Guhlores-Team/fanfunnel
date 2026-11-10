import { creatorMfaStepUpResponse } from "@/lib/auth/stepUp";
// Data layer — admin console, agency (orgs + seats), account provisioning
// and the gated-signup approval queue.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import type { AdminAccount, AdminOverview, AppRole } from "./types";
import { inviteCreatorUser } from "./creatorAccount";
import { recordAudit } from "./audit";
import { leaveApprovalNotice, sendApprovalEmail } from "@/lib/account/approvalNotice";
import { sendApplicationAlert } from "@/lib/account/applicationNotice";
import { deliverAgencyInviteEmail } from "@/lib/agency/inviteEmail";
import { displayNameInputError } from "@/lib/profileErrors";
import { runAfterResponse } from "@/lib/afterResponse";
import { reportAccountMail } from "@/lib/monitoring/opsAlerts";
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
  /** "" when the stats RPC masked it for a scoped seat (0068). */
  email: string;
  wheels: number;
  fans: number;
  spins: number;
  pending: number;
  /** cents; null when masked for a scoped seat (WG-19: never shown as $0.00). */
  revenue: number | null;
}
export interface OrgMember {
  id: string;
  profileId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  /** C10: the creators this (non-manager) seat may act for. Owner view only;
   *  RLS (omc_rw: the seat's org owner or an admin) returns none to staff. */
  creatorIds: string[];
}
export interface PendingInvite {
  id: string;
  email: string;
  /** null: invited to join as a creator; otherwise the seat role on acceptance (0068). */
  role: OrgRole | null;
  expiresAt: string | null;
  /** WG-06: still listed for a while after it ran out, with Resend. */
  expired: boolean;
}
/** WG-03: every agency the viewer is tied to, so each one has a Leave. */
export interface AgencyTie {
  orgId: string;
  orgName: string;
  kind: "owner" | "staff" | "creator";
  role: OrgRole | null;
}
export interface AgencyOverview {
  org: { id: string; name: string } | null;
  isOwner: boolean;
  /** The signed-in user, so the console can tell their own seat apart. */
  viewerId: string;
  /** WG-02: the owner has a seat row (org_members) and so can act for creators. */
  viewerHasSeat: boolean;
  /** WG-13: false when the owner's account is suspended and every seat is frozen; null when unknown to this viewer. */
  ownerActive: boolean | null;
  ties: AgencyTie[];
  totals: { creators: number; fans: number; spins: number; pending: number; revenue: number | null };
  creators: OrgCreatorStat[];
  members: OrgMember[];
  invites: PendingInvite[];
}

/** How long a run-out invitation stays listed with "Resend" (WG-06). */
export const EXPIRED_INVITE_GRACE_DAYS = 14;

/**
 * The agency roll-up for one org the signed-in user owns or belongs to.
 * WG-03: a freelancer seated by two agencies, or an owner who also holds a
 * seat elsewhere, has several ties; `orgId` picks the console to show and
 * `ties` lists every one with its kind, so each can be left.
 */
export async function getAgencyOverview(opts: { orgId?: string | null } = {}): Promise<AgencyOverview | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const [{ data: ownedOrg }, { data: seatRows }, { data: me }] = await Promise.all([
    sb.from("orgs").select("id, name").eq("owner_id", user.id).maybeSingle(),
    sb.from("org_members").select("id, role, org:orgs(id, name)").eq("profile_id", user.id),
    sb.from("profiles").select("org_id").eq("id", user.id).maybeSingle(),
  ]);
  const owned = ownedOrg as { id: string; name: string } | null;
  const seats = ((seatRows ?? []) as unknown as { id: string; role: OrgRole; org: { id: string; name: string } | null }[])
    .filter((r) => r.org)
    .map((r) => ({ id: r.id, role: r.role, org: r.org as { id: string; name: string } }))
    .sort((a, b) => a.org.name.localeCompare(b.org.name));
  const managedOrgId = (me as { org_id: string | null } | null)?.org_id ?? null;

  const ties: AgencyTie[] = [];
  if (owned) ties.push({ orgId: owned.id, orgName: owned.name, kind: "owner", role: null });
  for (const st of seats) {
    if (owned && st.org.id === owned.id) continue; // the owner's own seat is not a tie to leave
    ties.push({ orgId: st.org.id, orgName: st.org.name, kind: "staff", role: st.role });
  }
  if (managedOrgId && managedOrgId !== owned?.id) {
    const { data: managed } = await sb.from("orgs").select("id, name").eq("id", managedOrgId).maybeSingle();
    const m = managed as { id: string; name: string } | null;
    // A managed creator cannot read the orgs row through RLS unless seated there; name it when known.
    ties.push({ orgId: managedOrgId, orgName: m?.name ?? seats.find((x) => x.org.id === managedOrgId)?.org.name ?? "the agency that manages your account", kind: "creator", role: null });
  }

  // The console to show: the requested org when the viewer owns or sits in it, else the owned org, else the first seat.
  const consoles = [owned, ...seats.map((st) => st.org)].filter((o): o is { id: string; name: string } => !!o);
  const org = (opts.orgId && consoles.find((o) => o.id === opts.orgId)) || owned || seats[0]?.org || null;
  if (!org) return null;
  const isOwner = !!owned && owned.id === org.id;
  const viewerHasSeat = seats.some((st) => st.org.id === org.id);

  // WG-13: the owner's account state (profiles RLS shows other rows to admins only; null = unknown).
  let ownerActive: boolean | null = null;
  if (isOwner) ownerActive = true;
  else {
    const { data: ownerRow } = await sb.from("orgs").select("owner:profiles!orgs_owner_id_fkey(is_active)").eq("id", org.id).maybeSingle();
    const active = (ownerRow as unknown as { owner: { is_active: boolean } | null } | null)?.owner?.is_active;
    ownerActive = typeof active === "boolean" ? active : null;
  }

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
    revenue: r.revenue === null || r.revenue === undefined ? null : Number(r.revenue),
  }));

  // Outgoing invites (owner-only view; RLS returns none to staff): pending
  // ones, and ones that ran out recently so the owner can re-send (WG-06).
  const now = Date.now();
  const graceFloor = new Date(now - EXPIRED_INVITE_GRACE_DAYS * 86_400_000).toISOString();
  const { data: inviteRows } = await sb
    .from("org_invites")
    .select("id, email, role, expires_at")
    .eq("org_id", org.id)
    .eq("status", "pending")
    .gt("expires_at", graceFloor)
    .order("created_at", { ascending: false });
  const invites: PendingInvite[] = ((inviteRows ?? []) as { id: string; email: string; role: OrgRole | null; expires_at: string | null }[]).map(
    (r) => ({ id: r.id, email: r.email, role: r.role ?? null, expiresAt: r.expires_at, expired: !!r.expires_at && Date.parse(r.expires_at) <= now })
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
    creatorIds: [],
  }));
  if (isOwner && members.length > 0) {
    const { data: scopeRows } = await sb
      .from("org_member_creators")
      .select("member_id, creator_id")
      .in("member_id", members.map((m) => m.id));
    const byMember = new Map<string, string[]>();
    for (const r of (scopeRows ?? []) as { member_id: string; creator_id: string }[]) {
      byMember.set(r.member_id, [...(byMember.get(r.member_id) ?? []), r.creator_id]);
    }
    for (const m of members) m.creatorIds = byMember.get(m.id) ?? [];
  }

  const revenueKnown = creators.every((c) => c.revenue !== null);
  return {
    org,
    isOwner,
    viewerId: user.id,
    viewerHasSeat,
    ownerActive,
    ties,
    totals: {
      creators: creators.length,
      fans: creators.reduce((s, c) => s + c.fans, 0),
      spins: creators.reduce((s, c) => s + c.spins, 0),
      pending: creators.reduce((s, c) => s + c.pending, 0),
      revenue: revenueKnown ? creators.reduce((s, c) => s + (c.revenue ?? 0), 0) : null,
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
  // ATK-06: whether an address has an account is never revealed. An invite
  // to an unknown address answers "ok" exactly like one to a real account
  // (nothing is stored or mailed; the real outcome stays in the server log).
  if (data === "no_such_user" && (call.fn === "org_invite_creator" || call.fn === "org_add_member")) {
    console.info("agency invite: no account for that address", { fn: call.fn, org: call.args.p_org });
    return { ok: true };
  }
  if (data === "ok") {
    void auditAgencyAction(sb, call);
    return { ok: true };
  }
  return { error: String(data) };
}

/** WG-07: agency membership changes are activity-log rows (ids only, never addresses). */
async function auditAgencyAction(sb: Awaited<ReturnType<typeof createClient>>, call: OrgRpc): Promise<void> {
  const { data: { user } } = await sb.auth.getUser();
  const actorId = user?.id ?? null;
  const a = call.args as Record<string, unknown>;
  const org = typeof a.p_org === "string" ? a.p_org : null;
  try {
    switch (call.fn) {
      case "org_invite_creator": await recordAudit({ actorId, action: "org.invite", targetType: "org", targetId: org, details: { kind: "creator" } }); break;
      case "org_add_member": await recordAudit({ actorId, action: "org.invite", targetType: "org", targetId: org, details: { kind: "seat", role: String(a.p_role) } }); break;
      case "org_invite_revoke": await recordAudit({ actorId, action: "org.invite_revoke", targetType: "org", targetId: null, details: { invite: String(a.p_invite).slice(0, 36) } }); break;
      case "org_invite_respond": await recordAudit({ actorId, action: a.p_accept ? "org.invite_accept" : "org.invite_decline", targetType: "org", targetId: null, details: { invite: String(a.p_invite).slice(0, 36) } }); break;
      case "org_remove_creator": await recordAudit({ actorId, action: "org.remove_creator", targetType: "profile", targetId: String(a.p_creator), details: { org: org ?? "" } }); break;
      case "org_remove_member": await recordAudit({ actorId, action: "org.remove_member", targetType: "org", targetId: null, details: { member: String(a.p_member).slice(0, 36) } }); break;
      case "org_scope_creator": await recordAudit({ actorId, action: "org.scope_change", targetType: "profile", targetId: String(a.p_creator), details: { member: String(a.p_member).slice(0, 36), on: a.p_on === true } }); break;
      case "org_leave": await recordAudit({ actorId, action: "org.leave", targetType: "org", targetId: org }); break;
    }
  } catch {
    // recordAudit reports its own failures; an audit miss never fails the action.
  }
}

// Creators and staff join via consent: the owner sends an invite, the invitee
// accepts (org_invite_respond). Both senders answer "ok" for any address
// (0068: no account enumeration); the invitation shows up for that account
// if and when it exists and is active.
export const inviteOrgCreator = (orgId: string, email: string) =>
  withInviteEmail(orgId, email, null, () => agencyRpc({ fn: "org_invite_creator", args: { p_org: orgId, p_email: email } }));
export const revokeOrgInvite = (inviteId: string) =>
  agencyRpc({ fn: "org_invite_revoke", args: { p_invite: inviteId } });
export const respondToOrgInvite = (inviteId: string, accept: boolean) =>
  agencyRpc({ fn: "org_invite_respond", args: { p_invite: inviteId, p_accept: accept } });
export const removeOrgCreator = async (orgId: string, creatorId: string) => {
  const result = await agencyRpc({ fn: "org_remove_creator", args: { p_org: orgId, p_creator: creatorId } });
  if ("ok" in result && isSupabaseConfigured()) {
    // WG-14: the seat scopes that pointed at this creator go too, so a later
    // re-invitation never silently restores every chatter's access. The
    // omc_rw policy lets the org owner delete them. (0073 does the same inside
    // org_remove_creator and org_leave; this is a no-op once it has.)
    const sb = await createClient();
    const { data: members } = await sb.from("org_members").select("id").eq("org_id", orgId);
    const ids = ((members ?? []) as { id: string }[]).map((m) => m.id);
    if (ids.length > 0) await sb.from("org_member_creators").delete().eq("creator_id", creatorId).in("member_id", ids);
  }
  return result;
};
export const addOrgMember = (orgId: string, email: string, role: OrgRole) =>
  withInviteEmail(orgId, email, role, () => agencyRpc({ fn: "org_add_member", args: { p_org: orgId, p_email: email, p_role: role } }));

/** The address an invitation is stored under (public._org_invite_email). */
const inviteAddress = (email: string) => {
  const v = email.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 254 ? v : null;
};

/**
 * C10: run an invite RPC, then e-mail the address only when the RPC created a
 * NEW pending invitation where none was pending before. A repeat for a
 * still-pending invite, a role switch on one (B2: the RPC replaces it, which
 * would otherwise mail the same person again), the owner's own address or a
 * refusal sends nothing. deliverAgencyInviteEmail then mails only an existing
 * account, at most 3 times a day per address (B2). Both reads use the owner's session client: RLS shows a
 * pending invitation only to its org's owner. The answer never depends on the
 * e-mail (the RPC answers "ok" for any address).
 */
export type InviteOutcome = { ok: true; invite: "new" | "pending" | "unknown" } | { error: string };
async function withInviteEmail(
  orgId: string,
  email: string,
  role: OrgRole | null,
  rpc: () => Promise<{ ok: true } | { error: string }>,
): Promise<InviteOutcome> {
  const address = inviteAddress(email);
  if (!isSupabaseConfigured() || !address) { const r = await rpc(); return "error" in r ? r : { ok: true, invite: "unknown" }; }
  const sb = await createClient();
  const pendingId = async () => {
    const { data } = await sb
      .from("org_invites")
      .select("id")
      .eq("org_id", orgId)
      .eq("email", address)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };
  const before = await pendingId();
  const result = await rpc();
  if ("error" in result) return result;
  const after = await pendingId();
  // WG-06: the owner is told whether this saved a NEW invitation (then the
  // e-mail goes out, if the address has an approved account) or found one
  // still waiting (nothing is sent twice; Resend exists for that). Neither
  // answer says whether the address has an account (B2 / ATK-06).
  const outcome: InviteOutcome = { ok: true, invite: after && before === null ? "new" : after ? "pending" : "unknown" };
  if (after && before === null) {
    const { data: org } = await sb.from("orgs").select("name").eq("id", orgId).maybeSingle();
    const orgName = (org as { name: string } | null)?.name ?? "";
    // B2 decides whether to send (existing account, per-address cap, first
    // invite only); OPS-05 reports a refused send so it reaches Admin › Errors.
    runAfterResponse(async () => {
      const outcome = await deliverAgencyInviteEmail(address, orgName, role);
      if (outcome === "failed") reportAccountMail("agency_invite", "failed");
    });
  }
  return outcome;
}

/**
 * WG-06: re-send an invitation the owner already made (still pending or run
 * out): revoke it and create it afresh, which mails the address again (B2's
 * 3-a-day cap still applies). Owner-only through the RPCs' own checks.
 */
export async function resendOrgInvite(inviteId: string): Promise<InviteOutcome> {
  if (!isSupabaseConfigured()) return { error: "demo_only" };
  const sb = await createClient();
  const { data: row } = await sb.from("org_invites").select("org_id, email, role, status").eq("id", inviteId).maybeSingle();
  const inv = row as { org_id: string; email: string; role: OrgRole | null; status: string } | null;
  if (!inv || inv.status !== "pending") return { error: "not_found" };
  const revoked = await revokeOrgInvite(inviteId);
  if ("error" in revoked && revoked.error !== "not_found") return revoked;
  const fresh = inv.role
    ? await withInviteEmail(inv.org_id, inv.email, inv.role, () => agencyRpc({ fn: "org_add_member", args: { p_org: inv.org_id, p_email: inv.email, p_role: inv.role as OrgRole } }))
    : await withInviteEmail(inv.org_id, inv.email, null, () => agencyRpc({ fn: "org_invite_creator", args: { p_org: inv.org_id, p_email: inv.email } }));
  if ("ok" in fresh) {
    const { data: { user } } = await sb.auth.getUser();
    await recordAudit({ actorId: user?.id ?? null, action: "org.invite_resend", targetType: "org", targetId: inv.org_id, details: { kind: inv.role ? "seat" : "creator" } });
  }
  return fresh;
}

/**
 * WG-02 (until 0073 seats the owner in org_create): the owner takes a seat
 * in their own agency so can_act_for grants them the inbox, queue and
 * campaigns of the creators they manage. org_add_member's owner branch
 * inserts the seat directly (no invitation) for the owner's own address.
 */
export async function seatOrgOwner(orgId: string): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { error: "demo_only" };
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email) return { error: "unauthorized" };
  const { data: owned } = await sb.from("orgs").select("id").eq("id", orgId).eq("owner_id", user.id).maybeSingle();
  if (!owned) return { error: "not_owner" };
  const result = await agencyRpc({ fn: "org_add_member", args: { p_org: orgId, p_email: user.email.trim().toLowerCase(), p_role: "manager" } });
  if ("ok" in result) await recordAudit({ actorId: user.id, action: "org.seat_self", targetType: "org", targetId: orgId });
  return result;
}
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
  /** WG-05: who runs the agency (their public creator name; never an address). */
  invitedBy: string | null;
  expiresAt: string | null;
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
    .select("id, org_id, status, role, expires_at, org:orgs(name, owner_id)")
    .eq("status", "pending")
    .eq("email", user.email.trim().toLowerCase())
    .gt("expires_at", new Date().toISOString());
  const rows = (data ?? []) as unknown as {
    id: string;
    org_id: string;
    role: OrgRole | null;
    expires_at: string | null;
    org: { name: string; owner_id: string | null } | null;
  }[];
  // WG-05: the invitee sees who runs the agency. The owner's profile row is
  // not readable through RLS by the invitee, so the service client reads only
  // the display names of the owners of orgs that invited THIS user, and only
  // the public (non-address) form of them is returned.
  const ownerIds = [...new Set(rows.map((r) => r.org?.owner_id).filter((v): v is string => !!v))];
  const names = new Map<string, string | null>();
  if (ownerIds.length > 0) {
    const { data: owners } = await createServiceClient().from("profiles").select("id, display_name").in("id", ownerIds);
    for (const o of (owners ?? []) as { id: string; display_name: string | null }[]) names.set(o.id, publicCreatorName(o.display_name));
  }
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org?.name ?? "An agency",
    role: r.role ?? null,
    invitedBy: r.org?.owner_id ? names.get(r.org.owner_id) ?? null : null,
    expiresAt: r.expires_at,
  }));
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

/**
 * C8: an admin's "New account" e-mails an invite (the creator sets their own
 * password at /set-password). `redirectTo` is this site's
 * /auth/callback?next=/set-password, built by the route from its own origin.
 */
export async function inviteCreatorAccount(
  email: string,
  displayName: string,
  redirectTo: string
): Promise<{ ok: true; id?: string } | { error: string }> {
  if (!isSupabaseConfigured()) {
    mockCreateAccount(email, displayName);
    return { ok: true };
  }

  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };

  // The service role is required to invite a user; only after the admin check.
  return inviteCreatorUser(createServiceClient(), email, displayName, redirectTo);
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

export interface ApplicationInput {
  displayName?: string;
  socials?: string;
  audienceSize?: string;
  note?: string;
}

const applicationRow = (input: ApplicationInput) => ({
  display_name: input.displayName?.slice(0, 120) ?? null,
  socials: input.socials?.slice(0, 600) ?? null,
  audience_size: input.audienceSize?.slice(0, 120) ?? null,
  note: input.note?.slice(0, 1000) ?? null,
});

/**
 * A signed-in pending user submits their creator details for vetting. One
 * request per account: a second submit answers "already_submitted" (C21: the
 * page shows the stored request with an Edit path instead of silently
 * overwriting it). A new request tells the admins (C6).
 */
export async function submitCreatorApplication(input: ApplicationInput): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.from("creator_applications").insert({
    profile_id: user.id,
    email: user.email ?? null,
    ...applicationRow(input),
    status: "pending",
  });
  if (error) return { error: error.code === "23505" ? "already_submitted" : "db_error" };
  runAfterResponse(async () => reportAccountMail("application_alert", await sendApplicationAlert()));
  return { ok: true };
}

/**
 * C21: the applicant edits their still-pending request. Applicants have no
 * UPDATE policy on creator_applications (admin-only), so the write uses the
 * service role, pinned to the session user's own row and to status
 * 'pending': never another account's, never a decided one.
 */
export async function updateMyCreatorApplication(input: ApplicationInput): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const svc = createServiceClient();
  const { data: current } = await svc.from("creator_applications").select("status").eq("profile_id", user.id).maybeSingle();
  const status = (current as { status?: string } | null)?.status;
  if (status !== "pending" && status !== "rejected") return { error: "not_found" };
  // WG-11: a rejected request can be fixed and sent again; it goes back to
  // the queue (profile first, so the server-controlled status leads) and the
  // admins hear about it like a new request.
  const reapply = status === "rejected";
  if (reapply) {
    const { data: prof, error: pErr } = await svc
      .from("profiles")
      .update({ approval_status: "pending" })
      .eq("id", user.id)
      .eq("approval_status", "rejected")
      .select("id")
      .maybeSingle();
    if (pErr) return { error: "db_error" };
    if (!prof) return { error: "not_found" };
  }
  const { data, error } = await svc
    .from("creator_applications")
    .update({ ...applicationRow(input), ...(reapply ? { status: "pending", decided_at: null } : {}) })
    .eq("profile_id", user.id)
    .in("status", ["pending", "rejected"])
    .select("id")
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!data) return { error: "not_found" };
  if (reapply) runAfterResponse(async () => reportAccountMail("application_alert", await sendApplicationAlert()));
  return { ok: true };
}

export interface MyApplication {
  displayName: string | null;
  socials: string | null;
  audienceSize: string | null;
  note: string | null;
  status: ApprovalStatus;
  createdAt: string;
}

/** The signed-in user's own request (RLS: own row), or null. */
export async function getMyCreatorApplication(): Promise<MyApplication | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb
    .from("creator_applications")
    .select("display_name, socials, audience_size, note, status, created_at")
    .eq("profile_id", user.id)
    .maybeSingle();
  const r = data as {
    display_name: string | null;
    socials: string | null;
    audience_size: string | null;
    note: string | null;
    status: ApprovalStatus;
    created_at: string;
  } | null;
  return r
    ? { displayName: r.display_name, socials: r.socials, audienceSize: r.audience_size, note: r.note, status: r.status, createdAt: r.created_at }
    : null;
}

/**
 * C7: the reason code an admin gave with the latest rejection of the
 * signed-in user, from the activity log (admin-only table, so read with the
 * service role, pinned to the session user's id). Display only.
 */
export async function getMyRejectionReason(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await createServiceClient()
    .from("admin_audit_log")
    .select("details")
    .eq("action", "account.reject")
    .eq("target_type", "profile")
    .eq("target_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const reason = (data as { details: { reason?: unknown } | null } | null)?.details?.reason;
  return typeof reason === "string" ? reason : null;
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

const APPLICATIONS_LIMIT = 200;
const clip = (v: string | null, n: number) => (typeof v === "string" ? v.slice(0, n) : null);

/**
 * B1 (batch 6): the e-mail an access request is shown under. An applicant can
 * write their own creator_applications row straight through PostgREST (the
 * insert policy only pins profile_id), so the row's `email` is never shown:
 * this reads the sign-in address of the auth user (service role, server only;
 * module-private: its only caller checked isActiveAdmin first).
 */
async function authEmailsFor(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const svc = createServiceClient();
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map(async (id) => {
        try {
          const { data, error } = await svc.auth.admin.getUserById(id);
          out.set(id, error ? null : (data?.user?.email ?? null));
        } catch {
          out.set(id, null);
        }
      })
    );
  }
  return out;
}

/**
 * Admin: the pending (and recently-decided) creator applications.
 *
 * B1 (batch 6): everything the applicant can write on their row is display
 * text only. The address comes from the auth user, the status from
 * `profiles.approval_status` (admin-only UPDATE, the server-controlled gate),
 * and the date is clamped to the account's own creation (a request cannot
 * predate its account or lie in the future). The row's `status`/`decided_*`
 * columns decide nothing.
 */
export async function listCreatorApplications(): Promise<CreatorApplication[]> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return [];

  const { data } = await sb
    .from("creator_applications")
    .select("id, profile_id, display_name, socials, audience_size, note, created_at")
    .order("created_at", { ascending: false })
    .limit(APPLICATIONS_LIMIT);
  const rows = (data ?? []) as {
    id: string;
    profile_id: string;
    display_name: string | null;
    socials: string | null;
    audience_size: string | null;
    note: string | null;
    created_at: string;
  }[];
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.profile_id))];
  const { data: profs } = await sb.from("profiles").select("id, approval_status, created_at").in("id", ids);
  const byId = new Map(
    ((profs ?? []) as { id: string; approval_status: ApprovalStatus; created_at: string }[]).map((p) => [p.id, p])
  );
  const emails = await authEmailsFor(ids);
  const now = Date.now();

  return rows.flatMap((r) => {
    const prof = byId.get(r.profile_id);
    if (!prof) return [];
    const at = Math.min(now, Math.max(Date.parse(r.created_at) || 0, Date.parse(prof.created_at) || 0));
    return [
      {
        id: r.id,
        profileId: r.profile_id,
        email: emails.get(r.profile_id) ?? null,
        displayName: clip(r.display_name, 120),
        socials: clip(r.socials, 600),
        audienceSize: clip(r.audience_size, 120),
        note: clip(r.note, 1000),
        status: prof.approval_status,
        createdAt: new Date(at).toISOString(),
      },
    ];
  });
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

  if (decision === "rejected") {
    // C7: a reject only applies to an account that is not approved, so a
    // stale Admin tab can never lock out a live creator (suspend is for that).
    const { data: rejected, error: rErr } = await sb
      .from("profiles")
      .update({ approval_status: "rejected" })
      .eq("id", profileId)
      .neq("approval_status", "approved")
      .select("id")
      .maybeSingle();
    if (rErr) return { error: "db_error" };
    if (!rejected) return { error: "already_approved" };
    const { error: aErr } = await sb
      .from("creator_applications")
      .update({ status: "rejected", decided_at: now })
      .eq("profile_id", profileId);
    return aErr ? { error: "db_error" } : { ok: true };
  }

  // B1 (batch 6): the decision follows the profile (server-controlled), never
  // the applicant-writable request row. Approve only an account that is still
  // waiting (pending, or rejected: the C7 undo); an approved one is a no-op,
  // and a missing profile is refused before anything is written.
  const { data: prof, error: rpErr } = await sb
    .from("profiles")
    .select("approval_status")
    .eq("id", profileId)
    .maybeSingle();
  if (rpErr) return { error: "db_error" };
  const state = (prof as { approval_status?: ApprovalStatus } | null)?.approval_status;
  if (state === "approved") return { ok: true };
  if (state !== "pending" && state !== "rejected") return { error: "not_found" };

  // A30: only a real transition to approved leaves a notice and an e-mail, so
  // re-approving (or two admins approving at once) never notifies twice: the
  // approve update itself matches only a row that is not approved yet, and
  // only the request whose update changed the row notifies.
  const { data: updated, error: pErr } = await sb
    .from("profiles")
    .update({ approval_status: decision })
    .eq("id", profileId)
    .neq("approval_status", "approved")
    .select("id")
    .maybeSingle();
  if (pErr) return { error: "db_error" };
  if (updated) {
    // Display only: mirrors the decision onto the request row.
    const { error: aErr } = await sb
      .from("creator_applications")
      .update({ status: decision, decided_at: now })
      .eq("profile_id", profileId);
    if (aErr) console.error("approval: marking the request decided failed", aErr.code ?? "error");
    await copyApplicationName(sb, profileId);
    const svc = createServiceClient();
    await leaveApprovalNotice(svc, profileId);
    runAfterResponse(async () => reportAccountMail("approval", await sendApprovalEmail(svc, profileId)));
  }
  return { ok: true };
}

/**
 * C9: the name from the request becomes the profile's display name when the
 * profile has none (fans would otherwise see "Creator"). It goes through the
 * same rules as Settings (displayNameInputError here; the database's own
 * check, which also refuses a name containing the account's e-mail, on the
 * write). A refused or failed copy never undoes the approval.
 */
async function copyApplicationName(sb: Awaited<ReturnType<typeof createClient>>, profileId: string): Promise<void> {
  try {
    const { data } = await sb
      .from("creator_applications")
      .select("display_name")
      .eq("profile_id", profileId)
      .maybeSingle();
    const name = ((data as { display_name: string | null } | null)?.display_name ?? "").trim();
    if (!name || displayNameInputError(name)) return;
    const { error } = await sb
      .from("profiles")
      .update({ display_name: name })
      .eq("id", profileId)
      .or("display_name.is.null,display_name.eq.");
    if (error) console.error("approval: copying the request's name failed", error.code ?? "error");
  } catch {
    /* the approval stands */
  }
}
