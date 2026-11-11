import { NextResponse } from "next/server";
import { getThreadPage, markThreadRead } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";
import { badRequest, errorResponse } from "@/lib/api/handler";

// One page of the conversation with one fan, from the creator's side
// (RLS-scoped): the newest 200, or `?before=<ISO>` for the ones older than
// that (RD-19); `?limit=1..500` sizes the page. Answers { messages, more }.
// `?creatorId=<id>` (A19): a seat with can_act_for 'chat' for that creator.
// Reading never changes anything (I3); marking read is the POST below.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const rateLimited = await limitRoute(req, "messages/thread/[fanId]:GET");
  if (rateLimited) return rateLimited;
  const { fanId } = await params;
  const url = new URL(req.url);
  const creatorId = url.searchParams.get("creatorId");
  const before = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if ((creatorId !== null && creatorId.length > 64) || (before !== null && before.length > 40)) return badRequest();
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) return badRequest();
  const page = await getThreadPage(fanId, creatorId ?? undefined, { before, limit });
  if ("error" in page) return errorResponse(page.error);
  return NextResponse.json(page);
}

// I3: mark the fan's messages read by the creator (the Inbox calls this after
// showing unread messages). Same scoping as GET; no body.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const rateLimited = await limitRoute(req, "messages/thread/[fanId]:POST");
  if (rateLimited) return rateLimited;
  const { fanId } = await params;
  const creatorId = new URL(req.url).searchParams.get("creatorId");
  if (creatorId !== null && creatorId.length > 64) return badRequest();
  const result = await markThreadRead(fanId, creatorId ?? undefined);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
