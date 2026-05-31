import { NextResponse } from "next/server";
import { setCampaignPinnedWheel } from "@/lib/data";

// Pin (or unpin) a campaign's default wheel.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { pinnedWheelId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await setCampaignPinnedWheel(id, body.pinnedWheelId ?? null);
  if ("error" in result) {
    const status =
      result.error === "unauthorized"
        ? 401
        : result.error === "not_found"
          ? 404
          : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json({ ok: true });
}
