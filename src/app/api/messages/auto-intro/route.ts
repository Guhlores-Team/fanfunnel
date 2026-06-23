import { NextResponse } from "next/server";
import { ensureChatIntro } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Auto-send the creator's greeting when a fan opens chat (token-gated, service
// role). Idempotent: no-op once the thread has any message.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.token) {
    return badRequest();
  }
  const result = await ensureChatIntro(body.token);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
