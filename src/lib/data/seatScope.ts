// Data layer — A19 agency seat scopes. A staff seat acts for a creator in its
// agency only through the job its role and scope allow, checked server-side
// with the SECURITY DEFINER can_act_for() on the caller's own session:
//   chat    owners, managers, and chatters scoped to that creator (inbox)
//   fulfil  owners, managers, and fulfillers scoped to that creator (prizes)
//   manage  owners and managers of that creator's agency (campaigns)
// Roles come from org_members/org_member_creators (server-controlled), never
// from user or app metadata. A request that names no creator, or the caller's
// own id, keeps the existing own-account behaviour.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { isUuid } from "./shared";
import { publicCreatorTitle } from "@/lib/publicCreator";

export type SeatJob = "chat" | "fulfil" | "manage";
export type ActingCreator = { creatorId: string } | { error: "bad_request" | "forbidden" };
type RpcClient = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/**
 * The creator this request acts for. `requested` is untrusted input (a query
 * parameter or body field): anything but a UUID the caller may do `job` for is
 * refused before any read or write.
 */
export async function resolveActingCreator(sb: RpcClient, userId: string, requested: unknown, job: SeatJob): Promise<ActingCreator> {
  if (requested === undefined || requested === null || requested === "" || requested === userId) return { creatorId: userId };
  if (typeof requested !== "string" || !isUuid(requested)) return { error: "bad_request" };
  const { data, error } = await sb.rpc("can_act_for", { target_creator: requested, perm: job });
  return !error && data === true ? { creatorId: requested } : { error: "forbidden" };
}

/** Demo mode has no agencies: naming any creator there is refused. */
export function demoActingCreator(requested: unknown): { error: "forbidden" } | null {
  return requested === undefined || requested === null || requested === "" ? null : { error: "forbidden" };
}

/** Concurrent can_act_for calls when listing which creators a seat may manage. */
const MANAGE_CHECK_BATCH = 8;

export interface SeatCreator {
  creatorId: string;
  displayName: string;
  canChat: boolean;
  canFulfil: boolean;
  /** Present only when asked for (`{ manage: true }`): may run this creator's campaigns. */
  canManage?: boolean;
}

/**
 * Creators the signed-in user may act for as a staff seat, and which jobs.
 * With `manage`, each creator also says whether the seat may run its
 * campaigns: my_seat_creators.can_manage (0073), or before that
 * can_act_for(creator, 'manage') on the caller's own session. Only
 * owners and managers hold 'manage', and they also hold both listed jobs, so
 * only those rows are asked; every other row is false. This list only shapes
 * the UI: each campaign request re-checks 'manage' on the server.
 */
export async function listMySeatCreators(opts: { manage?: boolean } = {}): Promise<SeatCreator[] | { error: "unauthorized" | "db_error" }> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data, error } = await (sb as unknown as RpcClient).rpc("my_seat_creators");
  if (error) return { error: "db_error" };
  const rows = (data ?? []) as { creator_id: string; display_name: string | null; can_chat: boolean; can_fulfil: boolean; can_manage?: boolean | null }[];
  const seats = rows.map((r) => ({
    creatorId: r.creator_id,
    // M1: never an address, and a missing name reads as the neutral label.
    displayName: publicCreatorTitle(r.display_name),
    canChat: r.can_chat === true,
    canFulfil: r.can_fulfil === true,
  }));
  if (!opts.manage) return seats;
  // 0073 (DB-17): the list itself says whether the seat may run campaigns, so
  // no can_act_for call per creator is needed. Older rows without the column
  // are asked one by one below.
  if (rows.every((r) => typeof r.can_manage === "boolean")) return seats.map((s, i) => ({ ...s, canManage: rows[i].can_manage === true }));
  const out: SeatCreator[] = [];
  for (let i = 0; i < seats.length; i += MANAGE_CHECK_BATCH) {
    const batch = seats.slice(i, i + MANAGE_CHECK_BATCH);
    const flags = await Promise.all(batch.map(async (s) => {
      if (!s.canChat || !s.canFulfil) return false;
      const { data: ok, error: e } = await (sb as unknown as RpcClient).rpc("can_act_for", { target_creator: s.creatorId, perm: "manage" });
      return !e && ok === true;
    }));
    batch.forEach((s, j) => out.push({ ...s, canManage: flags[j] }));
  }
  return out;
}

export interface AgencyStanding {
  /** Owns an agency. */
  ownsOrg: boolean;
  /** Holds a staff seat in one. */
  hasSeat: boolean;
  /** Is a creator an agency manages (accepted an invite). */
  inAgency: boolean;
  /** That agency's id (the caller's own profiles.org_id), for leaving it. */
  creatorOrgId: string | null;
}

/**
 * A45: the caller's tie to an agency, read on its own session (orgs,
 * org_members and its own profile, all under RLS). Decides whether the
 * dashboard links to /agency and what /agency shows a managed creator. Never
 * an authorization input: every agency action re-checks on the server.
 */
export async function getAgencyStanding(): Promise<AgencyStanding | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const [owned, seat, profile] = await Promise.all([
    sb.from("orgs").select("id", { count: "exact", head: true }).eq("owner_id", user.id),
    sb.from("org_members").select("id", { count: "exact", head: true }).eq("profile_id", user.id),
    sb.from("profiles").select("org_id").eq("id", user.id).maybeSingle(),
  ]);
  const orgId = (profile.data as { org_id: string | null } | null)?.org_id ?? null;
  return {
    ownsOrg: (owned.count ?? 0) > 0,
    hasSeat: (seat.count ?? 0) > 0,
    inAgency: !!orgId,
    creatorOrgId: orgId,
  };
}

/** Whether the dashboard shows the Agency link. Demo: yes (its /agency explains agencies). */
export async function showAgencyLink(): Promise<boolean> {
  if (!isSupabaseConfigured()) return true;
  const s = await getAgencyStanding();
  return !!s && (s.ownsOrg || s.hasSeat || s.inAgency);
}
