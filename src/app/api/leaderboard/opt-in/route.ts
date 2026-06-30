import { NextResponse } from "next/server";
import { setFanLeaderboardOptIn } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A fan opts in/out of the public leaderboard and (optionally) sets their handle.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: string; optIn?: boolean; handle?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string" || !body.token) {
    return badRequest();
  }
  const limited = await rateLimitOr429("lb-optin:" + body.token, 10, 60_000);
  if (limited) return limited;
  const handle =
    typeof body.handle === "string"
      ? body.handle.trim().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40)
      : undefined;
  const result = await setFanLeaderboardOptIn(body.token, Boolean(body.optIn), handle);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
