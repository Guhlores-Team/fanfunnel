import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { listFansPage } from "@/lib/data";
import { badRequest } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// One page of the creator's fan accounts (PA-03): `?q=` searches name,
// handle and tags on the server; `?cursor=` is the previous page's
// nextCursor; `?limit=` is clamped to 1..200 (default 50). The response is
// { fans, nextCursor, total } and never refuses for the size of the account.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "fans:GET");
  if (rateLimited) return rateLimited;
  const params = new URL(req.url).searchParams;
  const q = params.get("q");
  const cursor = params.get("cursor");
  const limitRaw = params.get("limit");
  if ((q !== null && q.length > 80) || (cursor !== null && cursor.length > 120)) return badRequest();
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limitRaw !== null && !Number.isInteger(limit)) return badRequest();
  return completeReadResponse(async () => {
    const page = await listFansPage({ query: q, cursor, limit });
    return NextResponse.json(page);
  });
}
