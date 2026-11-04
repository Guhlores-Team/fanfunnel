import { NextResponse } from "next/server";
import { getThread } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";
import { badRequest, errorResponse } from "@/lib/api/handler";

// Full message history for one fan, from the creator's side (RLS-scoped).
// `?creatorId=<id>` (A19): a seat with can_act_for 'chat' for that creator.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const rateLimited = await limitRoute(req, "messages/thread/[fanId]:GET");
  if (rateLimited) return rateLimited;
  const { fanId } = await params;
  const creatorId = new URL(req.url).searchParams.get("creatorId");
  if (creatorId !== null && creatorId.length > 64) return badRequest();
  const messages = await getThread(fanId, creatorId ?? undefined);
  if ("error" in messages) return errorResponse(messages.error);
  return NextResponse.json({ messages });
}
