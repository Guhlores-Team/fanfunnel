// Data layer — A19 agency seat scopes. A staff seat acts for a creator in its
// agency only through the job its role and scope allow, checked server-side
// with the SECURITY DEFINER can_act_for() on the caller's own session:
//   chat    owners, managers, and chatters scoped to that creator (inbox)
//   fulfil  owners, managers, and fulfillers scoped to that creator (prizes)
// Roles come from org_members/org_member_creators (server-controlled), never
// from user or app metadata. A request that names no creator, or the caller's
// own id, keeps the existing own-account behaviour.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { isUuid } from "./shared";

export type SeatJob = "chat" | "fulfil";
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

export interface SeatCreator {
  creatorId: string;
  displayName: string;
  canChat: boolean;
  canFulfil: boolean;
}

/** Creators the signed-in user may act for as a staff seat, and which jobs. */
export async function listMySeatCreators(): Promise<SeatCreator[] | { error: "unauthorized" | "db_error" }> {
  if (!isSupabaseConfigured()) return [];
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data, error } = await (sb as unknown as RpcClient).rpc("my_seat_creators");
  if (error) return { error: "db_error" };
  return ((data ?? []) as { creator_id: string; display_name: string; can_chat: boolean; can_fulfil: boolean }[]).map((r) => ({
    creatorId: r.creator_id,
    displayName: r.display_name,
    canChat: r.can_chat === true,
    canFulfil: r.can_fulfil === true,
  }));
}
