import { NextResponse } from "next/server";
import { setFanLinkGame } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// "Change game for this fan only" (0065): sets the game one fan link plays,
// or follows its campaign and the live game again. Body: { token, wheelId }.
// The data layer checks the session, can_act_for(creator, 'grant') and that
// the game is the creator's own and playable before the service RPC.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const body = await parseJsonBody<{ token?: unknown; wheelId?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string" || !(body.wheelId === null || typeof body.wheelId === "string")) return badRequest();
  const result = await setFanLinkGame(fanId, body.token, body.wheelId);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
