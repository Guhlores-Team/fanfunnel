import { NextResponse } from "next/server";
import { setLeaderboardEnabled } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Creator toggles their public leaderboard on/off.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ enabled?: boolean }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.enabled !== "boolean") return badRequest();
  const result = await setLeaderboardEnabled(body.enabled);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
