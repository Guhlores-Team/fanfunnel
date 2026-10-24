import { NextResponse } from "next/server";
import { getRecentWins } from "@/lib/data";

// Every fan on a spin page polls this (RecentWinsTicker), so let the CDN share
// one response per creator for a few seconds. Safe because the payload depends
// only on the creatorId path param: no cookies, auth or token are read, and it
// is the same opt-in, handle-only list every viewer sees. Route handlers are
// uncached by default in Next 16, so this header is the only caching layer.
// Kept short (<=20s total) so a fan who opts out drops off the ticker quickly.
const CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=10";

// Recent rare+ wins for a creator (handle-only, opt-in fans only). Empty when
// the creator's leaderboard is off.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  const { creatorId } = await params;
  const wins = await getRecentWins(creatorId);
  return NextResponse.json({ wins }, { headers: { "Cache-Control": CACHE_CONTROL } });
}
