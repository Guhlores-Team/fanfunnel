import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { isMissingRpc } from "./shared";

// 0073: creator_fan_summaries, creator_obligations and
// creator_analytics_summary are SECURITY DEFINER functions granted to the
// service role only. The caller's own session must first prove
// can_act_for(creator, perm); only then is the function called with the
// service client and that creator id. Nothing here trusts a client-sent role.

type RpcError = { code?: string; message?: string } | null;
type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }> };

export type CreatorSummaryName = "creator_fan_summaries" | "creator_obligations" | "creator_analytics_summary";
export type CreatorSummaryResult =
  | { status: "ok"; data: unknown }
  /** The session may not act for this creator: read through RLS instead. */
  | { status: "denied" }
  /** The function (or the service key) is not there: use the older read. */
  | { status: "absent" }
  | { status: "error" };

export async function creatorSummary(
  session: unknown,
  creatorId: string,
  perm: "view" | "manage",
  name: CreatorSummaryName,
  args: Record<string, unknown> = {}
): Promise<CreatorSummaryResult> {
  const { data: allowed, error: permissionError } = await (session as RpcClient).rpc("can_act_for", { target_creator: creatorId, perm });
  if (permissionError) return { status: "error" };
  if (allowed !== true) return { status: "denied" };
  let service: RpcClient;
  try {
    service = createServiceClient() as unknown as RpcClient;
  } catch {
    return { status: "absent" };
  }
  const { data, error } = await service.rpc(name, { ...args, p_creator: creatorId });
  if (error) return isMissingRpc(error) ? { status: "absent" } : { status: "error" };
  return { status: "ok", data };
}
