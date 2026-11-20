import { NextResponse } from "next/server";
import { ensureChatIntro } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { errorResponse } from "@/lib/api/handler";

// Auto-send the creator's greeting when a fan opens chat (token-gated, service
// role). Idempotent: no-op once the thread has any message. withFanToken
// bounds the token and throttles per IP + token (A22): the client-side
// once-per-mount guard is not a limit.
export async function POST(req: Request) {
  return withFanToken<{ token?: unknown }>(req, { scope: "auto-intro", limit: 6, windowMs: 60_000 }, async (token) => {
    const result = await ensureChatIntro(token);
    if ("error" in result) return errorResponse(result.error);
    return NextResponse.json(result);
  });
}
