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
 * campaigns: can_act_for(creator, 'manage') on the caller's own session. Only
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
  const seats = ((data ?? []) as { creator_id: string; display_name: string; can_chat: boolean; can_fulfil: boolean }[]).map((r) => ({
    creatorId: r.creator_id,
    displayName: r.display_name,
    canChat: r.can_chat === true,
    canFulfil: r.can_fulfil === true,
  }));
  if (!opts.manage) return seats;
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
