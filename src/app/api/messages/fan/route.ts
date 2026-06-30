import { NextResponse } from "next/server";
import { getFanMessages, sendFanMessage } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";

// A fan's chat thread with the creator. Token-gated; sending requires ≥1 spin
// (the data layer enforces the "locked" gate).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) return badRequest();
  // Throttle thread reads (enumeration / polling) on client IP.
  const limited = await rateLimitOr429("msgread:" + clientIp(req), 60, 60_000);
  if (limited) return limited;
  const messages = await getFanMessages(token);
  return NextResponse.json({ messages });
}

export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: string; body?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  let token: string;
  let text: string;
  try {
    token = str(body.token, { max: 200, required: true })!;
    // Cap free-text at the data-layer limit so over-long bodies are rejected,
    // not silently truncated.
    text = str(body.body, { max: 2000, required: true })!;
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  // Per-fan send cap to stop inbox flooding.
  const limited = await rateLimitOr429("msg:" + token, 10, 60_000);
  if (limited) return limited;
  const result = await sendFanMessage(token, text);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
