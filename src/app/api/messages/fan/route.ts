import { NextResponse } from "next/server";
import { getFanMessages, sendFanMessage } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";

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
  if (typeof body.token !== "string" || typeof body.body !== "string" || !body.token || !body.body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Per-fan send cap to stop inbox flooding.
  const limited = rateLimitOr429("msg:" + body.token, 10, 60_000);
  if (limited) return limited;
  const result = await sendFanMessage(body.token, body.body);
  if ("error" in result) {
    const status =
      result.error === "not_found" ? 404 : result.error === "locked" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
