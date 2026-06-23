import { NextResponse } from "next/server";
import { setCampaignPinnedWheel, renameCampaign, deleteCampaign } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Rename a campaign and/or pin (or unpin) its default wheel.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await parseJsonBody<{ pinnedWheelId?: string | null; name?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  if (typeof body.name === "string") {
    const result = await renameCampaign(id, body.name);
    if ("error" in result) return errorResponse(result.error);
  }

  if ("pinnedWheelId" in body) {
    const result = await setCampaignPinnedWheel(id, body.pinnedWheelId ?? null);
    if ("error" in result) return errorResponse(result.error);
  }
  return NextResponse.json({ ok: true });
}

// Delete a campaign (grants keep their history; their campaign link is cleared).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteCampaign(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
