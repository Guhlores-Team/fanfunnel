import { NextResponse } from "next/server";
import { getPublicWheelTeaser } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// A public, identity-free teaser of a creator's active wheel (for share/landing).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  const rateLimited = await limitRoute(req, "public/wheel/[creatorId]:GET", "public");
  if (rateLimited) return rateLimited;
  const { creatorId } = await params;
  const teaser = await getPublicWheelTeaser(creatorId);
  if (!teaser) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Identity-free and the same for every visitor: let the edge serve it for a
  // minute instead of reading the database on every hit (A22). Only the
  // success response is cacheable; a 404 or 429 never is.
  return NextResponse.json(teaser, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" } });
}
