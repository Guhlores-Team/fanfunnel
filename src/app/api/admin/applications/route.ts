import { NextResponse } from "next/server";
import { listCreatorApplications, decideCreatorApplication, recordAudit } from "@/lib/data";
import { requireAdminRoute } from "@/lib/auth/admin";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { isRejectionReason } from "@/lib/account/rejectionReasons";

// Admin: list creator applications.
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const applications = await listCreatorApplications();
  // A36: demo sign-ups are always approved, so the demo never has requests.
  return NextResponse.json({ applications, ...(isSupabaseConfigured() ? {} : { demo: true }) });
}

// Admin: approve or reject one application by profileId. Approving a
// rejected request is the undo (C7). A reject may carry one of the fixed
// reason codes (rejectionReasons.ts); it is kept in the activity log and shown
// to the applicant on /pending. Admin-only: requireAdminRoute here and
// isActiveAdmin in decideCreatorApplication.
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = await parseJsonBody<{
    profileId?: string;
    decision?: "approved" | "rejected";
    reason?: unknown;
  }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  if (typeof body.profileId !== "string" || !body.profileId || (body.decision !== "approved" && body.decision !== "rejected")) {
    return badRequest();
  }
  const reason = body.reason === undefined || body.reason === null || body.reason === "" ? null : body.reason;
  if (reason !== null && (body.decision !== "rejected" || !isRejectionReason(reason))) return badRequest("invalid_reason");
  const result = await decideCreatorApplication(body.profileId, body.decision);
  if ("error" in result) return errorResponse(result.error);
  await recordAudit({
    actorId: admin.userId,
    action: body.decision === "approved" ? "account.approve" : "account.reject",
    targetType: "profile",
    targetId: body.profileId,
    ...(reason ? { details: { reason: reason as string } } : {}),
  });
  return NextResponse.json(result);
}
