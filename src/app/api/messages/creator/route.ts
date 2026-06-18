import { NextResponse } from "next/server";
import { sendCreatorMessage } from "@/lib/data";

// The creator replies to a fan in the drawer/inbox (RLS-scoped).
export async function POST(req: Request) {
  let body: { fanId?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.fanId || !body.body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Cap message length to prevent storage bloat and expensive reads (matches fan messages).
  if (typeof body.body !== "string" || body.body.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await sendCreatorMessage(body.fanId, body.body);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
