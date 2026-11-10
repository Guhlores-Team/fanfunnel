import "server-only";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { linkExpired } from "./linkExpiry";

/**
 * PR-13: whether the link behind this token has passed its expiry. One
 * indexed read by token (service role, like every fan-page read). A read that
 * fails, or a database that predates 0073 (no such column), is "not expired":
 * the ledger still refuses an expired link's spins on its own, so this only
 * decides what the page shows.
 */
export async function fanLinkExpired(token: string): Promise<boolean> {
  if (!isSupabaseConfigured() || !token) return false;
  try {
    const { data, error } = await createServiceClient().from("fan_passes").select("expires_at").eq("token", token).maybeSingle();
    if (error || !data) return false;
    return linkExpired((data as { expires_at?: string | null }).expires_at);
  } catch {
    return false;
  }
}
