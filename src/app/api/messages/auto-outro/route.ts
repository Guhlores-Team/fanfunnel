import { NextResponse } from "next/server";
import { sendChatOutro } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { errorResponse } from "@/lib/api/handler";

// Auto-send the creator's out-of-spins nudge when a fan runs dry (token-gated,
// service role). Guarded against spamming the same outro twice in a row, and
// throttled per IP + token by withFanToken (A22).
export async function POST(req: Request) {
  return withFanToken<{ token?: unknown }>(req, { scope: "auto-outro", limit: 6, windowMs: 60_000 }, async (token) => {
    const result = await sendChatOutro(token);
    if ("error" in result) return errorResponse(result.error);
    return NextResponse.json(result);
  });
}
