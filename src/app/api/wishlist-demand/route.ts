import { NextResponse } from "next/server";
import { getWishlistDemand } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Aggregated wishlist demand for the creator (RLS-scoped).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "wishlist-demand:GET");
  if (rateLimited) return rateLimited;
  const demand = await getWishlistDemand();
  return NextResponse.json({ demand });
}
