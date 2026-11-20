import { NextResponse } from "next/server";
import { setLeaderboardEnabled } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Creator toggles their public leaderboard on/off.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "leaderboard/enable:POST");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ enabled?: boolean }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.enabled !== "boolean") return badRequest();
  const result = await setLeaderboardEnabled(body.enabled);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
