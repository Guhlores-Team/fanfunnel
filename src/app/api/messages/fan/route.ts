import { NextResponse } from "next/server";
import { sendFanMessage } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";

// A fan sends a message to the creator. Token-gated; sending requires ≥1 spin
// (the data layer enforces the "locked" gate). Reading the thread is
// POST /api/messages/fan/thread (0068: the token never travels in a URL).
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
