import { NextResponse } from "next/server";
import { requestGameUnlock } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// PR-04: "Ask to enable" from the New game dialog. { game: "scratch" | "bingo" }
// → { ok, recorded, already }. The admins see it in their bell and by e-mail.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "me/game-unlock:POST");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ game?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  const result = await requestGameUnlock(body.game);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
