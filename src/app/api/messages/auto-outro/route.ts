import { NextResponse } from "next/server";
import { sendChatOutro } from "@/lib/data";

// Auto-send the creator's out-of-spins nudge when a fan runs dry (token-gated,
// service role). Guarded against spamming the same outro twice in a row.
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
  const result = await sendChatOutro(body.token);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
