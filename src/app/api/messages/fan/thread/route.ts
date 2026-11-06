import { NextResponse } from "next/server";
import { getFanMessages } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";

// A fan's chat thread with the creator. POST like every other fan endpoint
// (withFanToken): the link token travels in the body, never in a URL that
// browser history, proxies or server logs would keep. Polled by ChatPanel.
// A fan the creator blocked gets 403 blocked (I7).
export async function POST(req: Request) {
  return withFanToken(req, { scope: "msgread", limit: 60, windowMs: 60_000 }, async (token) => {
    const messages = await getFanMessages(token);
    // I7: a blocked fan can't read the thread (403 blocked).
    if ("error" in messages) return NextResponse.json({ error: messages.error }, { status: 403, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } });
  });
}
