import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getRecentWins } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";

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
  req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  return completeReadResponse(async () => {
    // Most polls are served by the CDN; this caps what reaches the origin (e.g.
    // cache-busting query strings). Generous: one fan polls ~3x/min, and many
    // fans can share an IP. A 429 must never be shared-cached.
    const limited = await rateLimitOr429("wins:" + clientIp(req), 120, 60_000);
    if (limited) {
      limited.headers.set("Cache-Control", "no-store");
      return limited;
    }
    const { creatorId } = await params;
    const wins = await getRecentWins(creatorId);
    return NextResponse.json({ wins }, { headers: { "Cache-Control": CACHE_CONTROL } });
  });
}
