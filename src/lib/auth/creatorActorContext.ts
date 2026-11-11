import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/data/shared";
/** DB binds actual signed actor/session/aal, creator and scope for <=60s.
 * Never accept a context from request JSON or cache/log it. Request UUID and
 * economic payload remain unchanged when a later HTTP retry mints a fresh one. */
export async function issueCreatorActorContext(session: Awaited<ReturnType<typeof createClient>>, creatorId: string | null, permission: "grant" | "edit_wheel" | "reconcile" | "system_health"): Promise<string | null> {
  try {
    const { data, error } = await session.rpc("issue_creator_actor_context", { p_creator: creatorId, p_permission: permission });
    return !error && typeof data === "string" && isUuid(data) ? data : null;
  } catch { return null; }
}
