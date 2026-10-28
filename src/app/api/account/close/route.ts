import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getSessionAssurance } from "@/lib/auth/assurance";
import { mfaStepUpResponse, verifyCurrentPassword } from "@/lib/auth/stepUp";
import { deleteAccountAndTombstoneLinks } from "@/lib/account/deleteAccount";
import { recordAudit } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { CLOSE_ACCOUNT_PHRASE, LIMITS } from "@/lib/privacy/config";
import { privateError, privateJson } from "@/lib/privacy/respond";

/**
 * "Close my account": the signed-in creator permanently deletes their own
 * account and everything it owns. Body: { currentPassword, confirm }.
 *
 * Guards, in order:
 *   1. signed in (Supabase verifies the session) and rate-limited per user;
 *   2. the typed phrase matches CLOSE_ACCOUNT_PHRASE exactly;
 *   3. two-factor, if the creator turned it on, was used in this session;
 *   4. the CURRENT password (step-up on a throwaway client, the same pattern as
 *      POST /api/account/email), so an open or stolen session alone can't do it;
 *   5. the last-admin guard: reserve_self_account_deletion refuses the last
 *      admin and otherwise demotes an admin first (atomic, like the admin
 *      delete's admin_reserve_account_deletion).
 * Then the shared account deletion (src/lib/account/deleteAccount.ts) removes
 * the auth user (FK cascades wipe every tenant row) and tombstones each fan
 * link so it shows "this creator has left", and an admin activity entry is
 * recorded.
 *
 * Service role: the reservation RPC is server-only (it can demote an admin)
 * and deleting an auth user needs the Auth admin API. Both run only after the
 * checks above, for the caller's OWN id taken from the verified session.
 */
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return privateError("demo_mode", 400);

  const sb = await createClient();
  const { userId, email, assurance } = await getSessionAssurance(sb);
  if (!userId || !email) return privateError("unauthorized", 401);

  const limited = await rateLimitOr429("closeaccount:" + userId, ...LIMITS.closeAccount);
  if (limited) return limited;

  const body = await parseJsonBody<{ currentPassword?: unknown; confirm?: unknown }>(req);
  if (body === BAD_REQUEST) return privateError("bad_request", 400);
  if (typeof body.confirm !== "string" || body.confirm.trim() !== CLOSE_ACCOUNT_PHRASE) {
    return privateError("confirm_mismatch", 400);
  }
  const step = mfaStepUpResponse(assurance);
  if (step) return step;
  const password = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!(await verifyCurrentPassword(email, password))) return privateError("wrong_password", 403);

  const svc = createServiceClient();
  const { data: profile } = await svc.from("profiles").select("role").eq("id", userId).maybeSingle();
  const wasAdmin = (profile as { role?: string } | null)?.role === "admin";

  const { data: reserve, error: reserveErr } = await svc.rpc("reserve_self_account_deletion", {
    p_user: userId,
  });
  if (reserveErr) return privateError("db_error", 500);
  if (reserve === "last_admin") return privateError("last_admin", 409);
  if (reserve !== "ok") return privateError("not_found", 404);

  const deleted = await deleteAccountAndTombstoneLinks(svc, userId, { wasAdmin });
  if ("error" in deleted) return privateError(deleted.error, 500);

  await recordAudit({
    actorId: userId,
    action: "account.self_close",
    targetType: "profile",
    targetId: userId,
    details: { role: wasAdmin ? "admin" : "creator", fanLinks: deleted.links },
  });

  // The user (and with it every session) is gone; clear this browser's cookies.
  try {
    await sb.auth.signOut({ scope: "local" });
  } catch {
    // The refresh token was already revoked with the user; nothing to undo.
  }
  return privateJson({ ok: true });
}
