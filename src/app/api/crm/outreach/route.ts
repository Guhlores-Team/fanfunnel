import { NextResponse } from "next/server";
import { recordOutreach } from "@/lib/data";
import { isOutreachAction } from "@/lib/data/outreach";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Win-back (RM-5): log that the signed-in creator contacted (copied a filled
// DM for) or snoozed one of their quiet fans. Body: { fanId, action, templateId? }.
// Session client + RLS only. The creator is whoever is signed in: any creator
// or user id in the body is ignored, and the insert policy refuses a fan (or
// template) that isn't that creator's. Nothing is sent to the fan.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ fanId?: unknown; action?: unknown; templateId?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();

  const { fanId, action, templateId } = body;
  if (typeof fanId !== "string" || !fanId || fanId.length > 64) return badRequest();
  if (!isOutreachAction(action)) return badRequest("invalid_action");
  if (templateId !== undefined && templateId !== null && (typeof templateId !== "string" || templateId.length > 64)) {
    return badRequest();
  }

  const result = await recordOutreach({ fanId, action, templateId: templateId ?? null });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
