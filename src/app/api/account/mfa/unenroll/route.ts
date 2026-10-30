import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getSessionAssurance } from "@/lib/auth/assurance";
import { recordAudit } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { isUuid } from "@/lib/data/shared";
import { LIMITS } from "@/lib/privacy/config";
import { privateError, privateJson } from "@/lib/privacy/respond";

// Remove one of the signed-in user's own two-factor factors. Body: { factorId }.
// Only an aal2 session may do it (someone holding just the password can't turn
// 2FA off); Supabase Auth scopes the factor to the session's own user. The
// removal is recorded in the admin activity log. Enrolling and verifying run
// in the browser through Supabase Auth directly (they only ever ADD a check).
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return privateError("demo_mode", 400);

  const sb = await createClient();
  const { userId, assurance } = await getSessionAssurance(sb);
  if (!userId) return privateError("unauthorized", 401);

  const limited = await rateLimitOr429("mfaunenroll:" + userId, ...LIMITS.mfaUnenroll);
  if (limited) return limited;

  const body = await parseJsonBody<{ factorId?: unknown }>(req);
  if (body === BAD_REQUEST || typeof body.factorId !== "string" || !isUuid(body.factorId)) {
    return privateError("bad_request", 400);
  }
  if (assurance.aal !== "aal2") return privateError("mfa_required", 403, { step: "challenge" });

  const { error } = await sb.auth.mfa.unenroll({ factorId: body.factorId });
  if (error) return privateError("unenroll_failed", 400);

  await recordAudit({
    actorId: userId,
    action: "mfa.factor_removed",
    targetType: "factor",
    targetId: body.factorId,
    details: { by: "self" },
  });
  return privateJson({ ok: true });
}
