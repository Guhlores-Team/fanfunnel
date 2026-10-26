import { NextResponse } from "next/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { checkAdmin } from "./adminCheck";

export { checkAdmin, isActiveAdmin } from "./adminCheck";
export type { AdminAccess, AdminCheckClient } from "./adminCheck";

/**
 * Request-bound admin check for Server Components and `src/app/api/admin/**`
 * route handlers. The predicate itself lives in `./adminCheck.ts`.
 *
 * Server-only: it builds the cookie-bound server client. Never import it from a
 * `"use client"` module (src/lib/security/adminGuard.test.ts checks).
 */

export type AdminRouteResult =
  | { ok: true; userId: string | null }
  | { ok: false; response: NextResponse };

/**
 * Guard for admin route handlers. Call it first and return `response` when
 * `ok` is false:
 *
 *   const admin = await requireAdminRoute();
 *   if (!admin.ok) return admin.response;
 *
 * Not signed in → 401 `unauthorized`; signed in but not an ACTIVE admin → 403
 * `forbidden` (the codes `statusForError` already uses). In demo mode (no
 * Supabase configured) there are no accounts and the admin panel is open, so the
 * guard passes with `userId: null` and the data layer serves the in-memory mock.
 */
export async function requireAdminRoute(): Promise<AdminRouteResult> {
  if (!isSupabaseConfigured()) return { ok: true, userId: null };
  const access = await checkAdmin(await createClient());
  if (access.status === "admin") return { ok: true, userId: access.userId };
  if (access.status === "anonymous") {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return {
    ok: false,
    response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  };
}
