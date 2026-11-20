import { NextResponse } from "next/server";
import { getShareCard } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Public, non-secret share card for a single win. No fan identity ever returned.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ shareId: string }> }
) {
  const rateLimited = await limitRoute(req, "share-cards/[shareId]:GET", "public");
  if (rateLimited) return rateLimited;
  const { shareId } = await params;
  const card = await getShareCard(shareId);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(card);
}
