import { NextResponse } from "next/server";
import { setCampaignPinnedWheel, renameCampaign, deleteCampaign } from "@/lib/data";

const statusFor = (e: string) =>
  e === "unauthorized" ? 401 : e === "not_found" ? 404 : 400;

// Rename a campaign and/or pin (or unpin) its default wheel.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { pinnedWheelId?: string | null; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.name === "string") {
    const result = await renameCampaign(id, body.name);
    if ("error" in result) {
      return NextResponse.json(result, { status: statusFor(result.error) });
    }
  }

  if ("pinnedWheelId" in body) {
    const result = await setCampaignPinnedWheel(id, body.pinnedWheelId ?? null);
    if ("error" in result) {
      return NextResponse.json(result, { status: statusFor(result.error) });
    }
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
  if ("error" in result) {
    return NextResponse.json(result, { status: statusFor(result.error) });
  }
  return NextResponse.json({ ok: true });
}
