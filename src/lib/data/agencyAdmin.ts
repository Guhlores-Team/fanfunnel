// Data layer — what an agency means when its owner goes (WG-04), the admin's
// view of agencies (WG-09) and the notices seats get when an owner is
// suspended (WG-13). Every read here runs on the service client AFTER an
// explicit check: the caller's own id (close account) or isActiveAdmin().
import { createHash } from "node:crypto";
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import { recordAudit, type AuditInput } from "./audit";
import { publicCreatorName } from "@/lib/publicCreator";

type Service = ReturnType<typeof createServiceClient>;

export interface AgencyImpact {
  orgId: string;
  orgName: string;
  /** Staff seats (every org_members row, the owner's own seat excluded). */
  seats: number;
  /** Creators the agency manages (profiles.org_id). */
  creators: number;
  memberIds: string[];
  creatorIds: string[];
}

/** What dissolving `ownerId`'s agency would end; null when they own none. Reads only. */
export async function agencyImpactForOwner(svc: Service, ownerId: string): Promise<AgencyImpact | null> {
  const { data: org } = await svc.from("orgs").select("id, name").eq("owner_id", ownerId).maybeSingle();
  const o = org as { id: string; name: string } | null;
  if (!o) return null;
  const [{ data: members }, { data: creators }] = await Promise.all([
    svc.from("org_members").select("profile_id").eq("org_id", o.id),
    svc.from("profiles").select("id").eq("org_id", o.id),
  ]);
  // The owner's own seat and own profile are not "someone the agency loses".
  const memberIds = [...new Set(((members ?? []) as { profile_id: string }[]).map((m) => m.profile_id))].filter((id) => id !== ownerId);
  const creatorIds = ((creators ?? []) as { id: string }[]).map((c) => c.id).filter((id) => id !== ownerId);
  return { orgId: o.id, orgName: o.name, seats: memberIds.length, creators: creatorIds.length, memberIds, creatorIds };
}

/** The signed-in user's own agency impact (for the Close-account warning). */
export async function myAgencyImpact(): Promise<Omit<AgencyImpact, "memberIds" | "creatorIds"> | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const impact = await agencyImpactForOwner(createServiceClient(), user.id);
  if (!impact) return null;
  return { orgId: impact.orgId, orgName: impact.orgName, seats: impact.seats, creators: impact.creators };
}

/**
 * The notice row for one recipient of one dissolved agency. Derived, so a
 * close that answers "pending" and is retried writes the SAME primary key
 * and the database keeps one notice per person.
 */
export function dissolvedNoticeId(orgId: string, profileId: string): string {
  const hex = createHash("sha256").update(`agency_dissolved:${orgId}:${profileId}`).digest("hex");
  // Shaped as a name-based (version 5, RFC 4122 variant) UUID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Leave a bell notice for every seat and managed creator of a dissolved
 * agency (creator_notices); answers how many were NEWLY written. The
 * owner-suspended notice is NOT written here: a database trigger on
 * profiles.is_active writes it (0073), so the app never inserts that kind.
 */
async function leaveAgencyNotices(svc: Service, impact: AgencyImpact): Promise<number> {
  const profileIds = [...new Set([...impact.memberIds, ...impact.creatorIds])];
  if (profileIds.length === 0) return 0;
  try {
    const { data, error } = await svc
      .from("creator_notices")
      .upsert(
        profileIds.map((id) => ({ id: dissolvedNoticeId(impact.orgId, id), creator_id: id, kind: "agency_dissolved", details: { org_name: impact.orgName.slice(0, 80) } })),
        { onConflict: "id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) {
      console.error("agency notice: insert failed", { kind: "agency_dissolved", code: error.code ?? "error" });
      return 0;
    }
    return ((data ?? []) as unknown[]).length;
  } catch {
    return 0;
  }
}

type DissolvedBy = "self_close" | "admin_delete" | "admin_dissolve";

/**
 * WG-04: tell the seats and managed creators that the agency is gone. Call
 * only AFTER the database accepted the deletion (S1: a refused close used to
 * announce a dissolution that never happened), with the impact read BEFORE
 * it (the rows cascade away). Answers the audit entry for the caller to
 * write.
 */
export async function announceAgencyDissolved(svc: Service, impact: AgencyImpact, actorId: string | null, by: DissolvedBy): Promise<AuditInput> {
  const notified = await leaveAgencyNotices(svc, impact);
  return { actorId, action: "org.dissolve", targetType: "org", targetId: impact.orgId, details: { by, seats: impact.seats, creators: impact.creators, notified } };
}

/**
 * announceAgencyDissolved + the audit row, for the account routes. Safe to
 * call again for the same agency (a deletion that answered "pending" and
 * then finished): the notices keep their keys and the activity entry is
 * written once.
 */
export async function recordAgencyDissolved(svc: Service, impact: AgencyImpact | null, actorId: string | null, by: DissolvedBy): Promise<void> {
  if (!impact) return;
  const audit = await announceAgencyDissolved(svc, impact, actorId, by);
  const { data: logged, error } = await svc.from("admin_audit_log").select("id").eq("action", "org.dissolve").eq("target_id", impact.orgId).limit(1);
  if (!error && ((logged ?? []) as unknown[]).length > 0) return;
  await recordAudit(audit);
}

// --- Admin view (WG-09) ------------------------------------------------------

export interface AdminAgency {
  id: string;
  name: string;
  createdAt: string;
  owner: { id: string; displayName: string; email: string; isActive: boolean } | null;
  seats: { memberId: string; profileId: string; displayName: string; role: string; isActive: boolean }[];
  creators: { id: string; displayName: string; email: string }[];
  pendingInvites: number;
}

/** Every agency, with owner, seats, managed creators and open invitations. Admins only. */
export async function listAgenciesForAdmin(): Promise<{ agencies: AdminAgency[]; demo?: boolean } | { error: "unauthorized" | "db_error" }> {
  if (!isSupabaseConfigured()) return { agencies: [], demo: true };
  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };
  const svc = createServiceClient();
  const [{ data: orgs, error }, { data: members }, { data: managed }, { data: invites }] = await Promise.all([
    svc.from("orgs").select("id, name, created_at, owner_id").order("created_at", { ascending: false }).limit(500),
    svc.from("org_members").select("id, org_id, profile_id, role").limit(5000),
    svc.from("profiles").select("id, org_id, display_name, email").not("org_id", "is", null).limit(5000),
    svc.from("org_invites").select("org_id").eq("status", "pending").gt("expires_at", new Date().toISOString()).limit(5000),
  ]);
  if (error) return { error: "db_error" };
  const orgRows = (orgs ?? []) as { id: string; name: string; created_at: string; owner_id: string }[];
  const memberRows = (members ?? []) as { id: string; org_id: string; profile_id: string; role: string }[];
  const ids = [...new Set([...orgRows.map((o) => o.owner_id), ...memberRows.map((m) => m.profile_id)])];
  const profiles = new Map<string, { display_name: string | null; email: string | null; is_active: boolean }>();
  if (ids.length > 0) {
    const { data: rows } = await svc.from("profiles").select("id, display_name, email, is_active").in("id", ids);
    for (const r of (rows ?? []) as { id: string; display_name: string | null; email: string | null; is_active: boolean }[]) profiles.set(r.id, r);
  }
  const inviteCount = new Map<string, number>();
  for (const i of (invites ?? []) as { org_id: string }[]) inviteCount.set(i.org_id, (inviteCount.get(i.org_id) ?? 0) + 1);
  const name = (p: { display_name: string | null; email: string | null } | undefined) => publicCreatorName(p?.display_name ?? null) ?? p?.email ?? "Creator";
  return {
    agencies: orgRows.map((o) => {
      const owner = profiles.get(o.owner_id);
      return {
        id: o.id,
        name: o.name,
        createdAt: o.created_at,
        owner: owner ? { id: o.owner_id, displayName: name(owner), email: owner.email ?? "", isActive: owner.is_active } : null,
        seats: memberRows.filter((m) => m.org_id === o.id && m.profile_id !== o.owner_id).map((m) => {
          const p = profiles.get(m.profile_id);
          return { memberId: m.id, profileId: m.profile_id, displayName: name(p), role: m.role, isActive: p?.is_active ?? true };
        }),
        creators: ((managed ?? []) as { id: string; org_id: string; display_name: string | null; email: string | null }[])
          .filter((c) => c.org_id === o.id && c.id !== o.owner_id)
          .map((c) => ({ id: c.id, displayName: name(c), email: c.email ?? "" })),
        pendingInvites: inviteCount.get(o.id) ?? 0,
      };
    }),
  };
}

export type AdminAgencyAction =
  | { action: "remove_seat"; memberId: string }
  | { action: "dissolve"; orgId: string; confirmName: string };

/** Admin levers against an agency, each audited. Suspending the owner uses the ordinary account suspend. */
/** Removes a seat or dissolves an agency; the caller (the admin route) writes the returned audit entry. */
export async function adminAgencyAction(input: AdminAgencyAction): Promise<{ ok: true; audit: AuditInput } | { error: string }> {
  if (!isSupabaseConfigured()) return { error: "demo_only" };
  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return { error: "unauthorized" };
  const { data: { user } } = await sb.auth.getUser();
  const actorId = user?.id ?? null;
  const svc = createServiceClient();
  if (input.action === "remove_seat") {
    const { data: row } = await svc.from("org_members").select("id, org_id, profile_id").eq("id", input.memberId).maybeSingle();
    const m = row as { id: string; org_id: string; profile_id: string } | null;
    if (!m) return { error: "not_found" };
    const { error } = await svc.from("org_members").delete().eq("id", m.id);
    if (error) return { error: "db_error" };
    return { ok: true, audit: { actorId, action: "org.remove_member", targetType: "org", targetId: m.org_id, details: { by: "admin", member: m.id } } };
  }
  const { data: org } = await svc.from("orgs").select("id, name, owner_id").eq("id", input.orgId).maybeSingle();
  const o = org as { id: string; name: string; owner_id: string } | null;
  if (!o) return { error: "not_found" };
  if (o.name.trim().toLowerCase() !== input.confirmName.trim().toLowerCase()) return { error: "name_mismatch" };
  // Who to tell is read before the rows go; they are told only once the
  // agency really is gone.
  const impact = await agencyImpactForOwner(svc, o.owner_id);
  // Managed creators are detached by the FK (profiles.org_id → on delete set null); seats and invites cascade.
  const { error } = await svc.from("orgs").delete().eq("id", o.id);
  if (error) return { error: "db_error" };
  return { ok: true, audit: impact ? await announceAgencyDissolved(svc, impact, actorId, "admin_dissolve") : { actorId, action: "org.dissolve", targetType: "org", targetId: o.id, details: { by: "admin_dissolve" } } };
}
