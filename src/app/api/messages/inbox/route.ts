import { NextResponse } from "next/server";
import { listThreads } from "@/lib/data";

// The creator's inbox: one thread per fan, with unread counts (RLS-scoped).
export async function GET() {
  const threads = await listThreads();
  return NextResponse.json({ threads });
}
