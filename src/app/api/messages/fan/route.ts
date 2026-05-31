import { NextResponse } from "next/server";
import { getFanMessages, sendFanMessage } from "@/lib/data";

// A fan's chat thread with the creator. Token-gated; sending requires ≥1 spin
// (the data layer enforces the "locked" gate).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const messages = await getFanMessages(token);
  return NextResponse.json({ messages });
}

export async function POST(req: Request) {
  let body: { token?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token || !body.body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await sendFanMessage(body.token, body.body);
  if ("error" in result) {
    const status =
      result.error === "not_found" ? 404 : result.error === "locked" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
