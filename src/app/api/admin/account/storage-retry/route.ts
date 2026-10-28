import { requireAdminRoute } from "@/lib/auth/admin";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { deleteAccountAndTombstoneLinks, processAccountStorageDeletion } from "@/lib/account/deleteAccount";
import { recordAudit } from "@/lib/data";
import { isUuid } from "@/lib/data/shared";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { privateError, privateJson } from "@/lib/privacy/respond";

/** Retry an already-authorized deletion; this endpoint cannot create a new one. */
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  if (!isSupabaseConfigured()) return privateError("demo_mode", 400);
  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body.id !== "string" || !isUuid(body.id)) return privateError("bad_request", 400);
  const svc = createServiceClient();
  const existing = await svc.from("creator_storage_deletions").select("state, was_role").eq("owner_id", body.id).maybeSingle();
  if (existing.error) return privateError("db_error", 500);
  if (!existing.data) return privateError("not_found", 404);
  const result = existing.data.state === "paused"
    ? await deleteAccountAndTombstoneLinks(svc, body.id, { wasAdmin: existing.data.was_role === "admin", actorId: admin.userId!, action: "account.delete" })
    : await processAccountStorageDeletion(svc, body.id);
  if ("error" in result) return privateError(result.error, result.error === "last_admin" ? 409 : 500);
  await recordAudit({ actorId: admin.userId, action: "account.storage_retry", targetType: "profile", targetId: body.id,
    details: { completed: "ok" in result, pending: "pending" in result } });
  return privateJson(result, "pending" in result ? 202 : 200);
}
