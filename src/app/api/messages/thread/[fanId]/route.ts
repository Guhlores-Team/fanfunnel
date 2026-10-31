import { NextResponse } from "next/server";
import { getThread } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Full message history for one fan, from the creator's side (RLS-scoped).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const rateLimited = await limitRoute(req, "messages/thread/[fanId]:GET");
  if (rateLimited) return rateLimited;
  const { fanId } = await params;
  const messages = await getThread(fanId);
  return NextResponse.json({ messages });
}
