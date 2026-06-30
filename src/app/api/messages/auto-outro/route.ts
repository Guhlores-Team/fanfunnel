import { NextResponse } from "next/server";
import { sendChatOutro } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Auto-send the creator's out-of-spins nudge when a fan runs dry (token-gated,
// service role). Guarded against spamming the same outro twice in a row.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.token) {
    return badRequest();
  }
  const result = await sendChatOutro(body.token);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
