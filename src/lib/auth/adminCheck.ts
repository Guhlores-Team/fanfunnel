import type { SupabaseClient } from "@supabase/supabase-js";

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
 */

/** The slice of the Supabase client the check uses (tests cast a fake to it). */
export type AdminCheckClient = Pick<SupabaseClient, "auth" | "rpc" | "from">;

export type AdminAccess =
  | { status: "anonymous" }
  | { status: "not_admin"; userId: string }
  | { status: "admin"; userId: string };

/**
 * Resolve the caller's admin status with the given cookie-bound client.
 *
 * `is_admin()` is authoritative: a definite true/false from the database wins.
 * Only when the RPC itself fails (function revoked from `authenticated`, not yet
 * migrated, transport error) does it fall back to the caller's own RLS-visible
 * `profiles` row — and applies the SAME predicate, `role = 'admin' AND
 * is_active = true`, so a suspended admin is refused on both paths. Anything
 * ambiguous (no row, missing columns, errors) fails closed.
 */
export async function checkAdmin(sb: AdminCheckClient): Promise<AdminAccess> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { status: "anonymous" };

  const rpc = await sb.rpc("is_admin");
  if (!rpc.error && typeof rpc.data === "boolean") {
    return { status: rpc.data ? "admin" : "not_admin", userId: user.id };
  }

  const row = await sb
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  const profile = row.error
    ? null
    : (row.data as { role?: unknown; is_active?: unknown } | null);
  const active = profile?.role === "admin" && profile?.is_active === true;
  return { status: active ? "admin" : "not_admin", userId: user.id };
}

/** `true` only for a signed-in, ACTIVE admin. */
export async function isActiveAdmin(sb: AdminCheckClient): Promise<boolean> {
  return (await checkAdmin(sb)).status === "admin";
}
