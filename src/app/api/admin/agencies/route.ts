import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { adminAgencyAction, listAgenciesForAdmin } from "@/lib/data/agencyAdmin";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";
import { isUuid } from "@/lib/data/shared";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// WG-09: the admin's view of agencies (orgs, owners, seats, managed
// creators, open invitations) and two audited levers: remove a seat and
// dissolve an agency (typed name). Suspending the owner is the ordinary
// account suspend (which pauses every seat through can_act_for).
export async function GET(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const rateLimited = await limitRoute(req, "admin/agencies:GET");
  if (rateLimited) return rateLimited;
  const result = await listAgenciesForAdmin();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const rateLimited = await limitRoute(req, "admin/agencies:POST", "costly");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ action?: unknown; memberId?: unknown; orgId?: unknown; confirmName?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  let result: { ok: true } | { error: string };
  if (body.action === "remove_seat") {
    if (typeof body.memberId !== "string" || !isUuid(body.memberId)) return badRequest();
    result = await adminAgencyAction({ action: "remove_seat", memberId: body.memberId });
  } else if (body.action === "dissolve") {
    if (typeof body.orgId !== "string" || !isUuid(body.orgId) || typeof body.confirmName !== "string" || body.confirmName.length > 120) return badRequest();
    result = await adminAgencyAction({ action: "dissolve", orgId: body.orgId, confirmName: body.confirmName });
  } else {
    return badRequest("unknown_action");
  }
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
