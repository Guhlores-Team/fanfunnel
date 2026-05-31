import { NextResponse } from "next/server";
import { getPublicWheelTeaser } from "@/lib/data";

// A public, identity-free teaser of a creator's active wheel (for share/landing).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  const { creatorId } = await params;
  const teaser = await getPublicWheelTeaser(creatorId);
  if (!teaser) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(teaser);
}
