import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * WG-16 / WU-20: end every other session of the signed-in account (a lost
 * phone, a shared laptop), keeping this one. Supabase Auth's `scope: "others"`
 * revokes the account's other refresh tokens with the caller's own session (no
 * service key needed), and the sign-in page's "Password changed" notice tells
 * the creator what happened. Best-effort: the password change or the explicit
 * action it follows has already succeeded, so a failure here is reported in
 * the response (`othersSignedOut: false`), never thrown.
 */
export async function signOutOtherSessions(sb: Pick<SupabaseClient, "auth">): Promise<boolean> {
  try {
    const { error } = await sb.auth.signOut({ scope: "others" });
    return !error;
  } catch {
    return false;
  }
}
