import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "@/lib/supabase/url";

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

/**
 * Review A4: end ONE session at the Auth server, given its own access token
 * (`POST /logout?scope=local` with that token as the bearer, the same call
 * auth-js makes for `signOut({ scope: "local" })`). Used when an e-mail link
 * replaces the session in this browser with another account's: dropping the
 * old cookie alone would leave the old refresh token alive. No service key:
 * a session can only ever end itself. Best-effort and bounded; the caller has
 * already replaced the cookies, so a failure is reported, never thrown.
 */
export async function revokeSession(accessToken: string | null | undefined): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The session this request arrived with (verified by the Auth server), or null. */
export async function verifiedSession(sb: Pick<SupabaseClient, "auth">): Promise<{ userId: string; email: string | null; accessToken: string | null } | null> {
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data: { session } } = await sb.auth.getSession();
    return { userId: user.id, email: user.email ?? null, accessToken: session?.access_token ?? null };
  } catch {
    return null;
  }
}
