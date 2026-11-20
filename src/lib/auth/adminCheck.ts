import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_MFA_REQUIRED } from "@/lib/privacy/config";
import { aalFromAccessToken, hasVerifiedFactor } from "./assurance";

/**
 * The ONE admin predicate, framework-free so it can be unit-tested with a fake
 * client (`adminCheck.test.ts`). Pages and routes reach it through
 * `./admin.ts`, which binds it to the request's cookie-backed server client.
 *
 * Contract (AGENTS.md rule 2): "admin" is `profiles.role = 'admin' AND
 * profiles.is_active`, decided by the SECURITY DEFINER `is_admin()` function —
 * never by the auth user's metadata fields, which the user can edit. A
 * suspended admin (is_active=false) is refused everywhere this is used, which
 * matters because several admin actions run with the service role and so are
 * not stopped by RLS.
 *
 * Two-factor (ADMIN_MFA_REQUIRED): an admin must also be on an aal2 session
 * (a verified TOTP challenge). Since migration 0054 `is_admin()` itself requires
 * aal2; this check applies the same rule app-side too, so it holds even on a
 * database that hasn't run 0054 yet. An admin on an aal1 session gets
 * `mfa_required` (never `admin`), with the step that fixes it.
 */

/** The slice of the Supabase client the check uses (tests cast a fake to it). */
export type AdminCheckClient = Pick<SupabaseClient, "auth" | "rpc" | "from">;

export type AdminAccess =
  | { status: "anonymous" }
  | { status: "not_admin"; userId: string }
  | { status: "mfa_required"; userId: string; step: "enrol" | "challenge" }
  | { status: "admin"; userId: string };

/** Read the caller's own profile row and apply the is_admin() predicate. */
async function roleRowSaysAdmin(sb: AdminCheckClient, userId: string): Promise<boolean> {
  const row = await sb
    .from("profiles")
    .select("role, is_active")
    .eq("id", userId)
    .maybeSingle();
  const profile = row.error
    ? null
    : (row.data as { role?: unknown; is_active?: unknown } | null);
  return profile?.role === "admin" && profile?.is_active === true;
}

/**
 * Resolve the caller's admin status with the given cookie-bound client.
 *
 * `is_admin()` is authoritative: a definite true/false from the database wins.
 * Only when the RPC itself fails (function revoked from `authenticated`, not yet
 * migrated, transport error) does it fall back to the caller's own RLS-visible
 * `profiles` row — and applies the SAME predicate, `role = 'admin' AND
 * is_active = true`, so a suspended admin is refused on both paths. Anything
 * ambiguous (no row, missing columns, errors) fails closed.
 *
 * A definite `false` on a session that is not aal2 may be an admin who hasn't
 * done the two-factor step yet (0054's is_admin() says false for them). Only
 * then is the caller's own row read, and only to say WHICH step to send them
 * to: the answer is `mfa_required`, never `admin`.
 */
export async function checkAdmin(
  sb: AdminCheckClient,
  { mfaRequired = ADMIN_MFA_REQUIRED }: { mfaRequired?: boolean } = {}
): Promise<AdminAccess> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { status: "anonymous" };

  // The aal claim of the session getUser() just verified.
  const {
    data: { session },
  } = await sb.auth.getSession();
  const aal2 = aalFromAccessToken(session?.access_token) === "aal2";
  const needsMfa = mfaRequired && !aal2;
  const mfa = (): AdminAccess => ({
    status: "mfa_required",
    userId: user.id,
    step: hasVerifiedFactor(user) ? "challenge" : "enrol",
  });

  const rpc = await sb.rpc("is_admin");
  if (!rpc.error && typeof rpc.data === "boolean") {
    if (rpc.data) return needsMfa ? mfa() : { status: "admin", userId: user.id };
    if (needsMfa && (await roleRowSaysAdmin(sb, user.id))) return mfa();
    return { status: "not_admin", userId: user.id };
  }

  if (!(await roleRowSaysAdmin(sb, user.id))) return { status: "not_admin", userId: user.id };
  return needsMfa ? mfa() : { status: "admin", userId: user.id };
}

/** `true` only for a signed-in, ACTIVE admin on a two-factor session. */
export async function isActiveAdmin(sb: AdminCheckClient): Promise<boolean> {
  return (await checkAdmin(sb)).status === "admin";
}
