import { NextResponse } from "next/server";
import { getWishlistDemand } from "@/lib/data";

// Aggregated wishlist demand for the creator (RLS-scoped).
export async function GET() {
  const demand = await getWishlistDemand();
  return NextResponse.json({ demand });
}
