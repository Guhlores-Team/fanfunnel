import { NextResponse } from "next/server";
import { hasThreadWith, listThreads } from "@/lib/data";
import { badRequest, errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// The creator's inbox: one thread per fan, with unread counts (RLS-scoped),
// newest activity first. `?before=<cursor>` reads the next (older) page;
// `?fanId=<id>` only answers whether that fan has a conversation.
// `?creatorId=<id>` (A19) reads the inbox of a creator the caller's agency seat
// may chat for (can_act_for 'chat'); anything else is refused (403).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "messages/inbox:GET");
  if (rateLimited) return rateLimited;
  const params = new URL(req.url).searchParams;
  const fanId = params.get("fanId");
  if (fanId !== null) {
    if (!fanId || fanId.length > 64) return badRequest();
    return NextResponse.json({ hasThread: await hasThreadWith(fanId) });
  }
  const before = params.get("before");
  if (before !== null && before.length > 120) return badRequest();
  const creatorId = params.get("creatorId");
  if (creatorId !== null && creatorId.length > 64) return badRequest();
  const page = await listThreads(before, undefined, creatorId ?? undefined);
  if ("error" in page) return page.error === "forbidden" ? errorResponse("forbidden") : badRequest();
  return NextResponse.json(page);
}
