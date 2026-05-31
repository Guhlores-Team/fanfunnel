import { NextResponse } from "next/server";
import { ensureChatIntro } from "@/lib/data";

// Auto-send the creator's greeting when a fan opens chat (token-gated, service
// role). Idempotent: no-op once the thread has any message.
export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await ensureChatIntro(body.token);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
