import { NextResponse } from "next/server";
import { getThread } from "@/lib/data";

// Full message history for one fan, from the creator's side (RLS-scoped).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const messages = await getThread(fanId);
  return NextResponse.json({ messages });
}
