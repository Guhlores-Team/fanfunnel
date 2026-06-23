import { NextResponse } from "next/server";
import { listCreatorApplications, decideCreatorApplication } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Admin: list creator applications.
export async function GET() {
  const applications = await listCreatorApplications();
  return NextResponse.json({ applications });
}

// Admin: approve/reject one application by profileId.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    profileId?: string;
    decision?: "approved" | "rejected";
  }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.profileId || (body.decision !== "approved" && body.decision !== "rejected")) {
    return badRequest();
  }
  const result = await decideCreatorApplication(body.profileId, body.decision);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
