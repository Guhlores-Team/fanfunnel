import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { adminRemoveCreatorMedia } from "@/lib/data";
import { recordAudit } from "@/lib/data/audit";
import { requireAdminRoute } from "@/lib/auth/admin";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Moderation (per-creator theming, D13): remove every photo-hub photo of one
// creator, e.g. after a fan's "Inappropriate photo" report. Active admins only
// (requireAdminRoute → is_admin()); the delete itself runs through RLS too.
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await adminRemoveCreatorMedia(body.id);
  if ("error" in result && result.error === "storage_cleanup_failed") return NextResponse.json({ error: result.error }, { status: 500 });
  if ("error" in result) return errorResponse(result.error);
  // Real removals audit atomically in the durable SQL completion. Demo/no-op
  // results use the current audit hook without duplicating that event.
  if (!("auditRecorded" in result && result.auditRecorded)) await recordAudit({
    actorId: admin.userId,
    action: "account.media_remove",
    targetType: "profile",
    targetId: body.id as string,
    details: { photosRemoved: result.removed },
  });
  // The admin doesn't know the creator's slug here; public pages refresh.
  revalidatePath("/c/[slug]", "page");
  return NextResponse.json(result);
}
