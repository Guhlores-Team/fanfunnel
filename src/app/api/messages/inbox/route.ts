import { NextResponse } from "next/server";
import { hasThreadWith, listThreads } from "@/lib/data";
import { badRequest } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// The creator's inbox: one thread per fan, with unread counts (RLS-scoped),
// newest activity first. `?before=<cursor>` reads the next (older) page;
// `?fanId=<id>` only answers whether that fan has a conversation.
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
  const page = await listThreads(before);
  if ("error" in page) return badRequest();
  return NextResponse.json(page);
}
