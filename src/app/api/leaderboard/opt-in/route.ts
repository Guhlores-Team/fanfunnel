import { NextResponse } from "next/server";
import { setFanLeaderboardOptIn } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";

// A fan opts in/out of the public leaderboard and (optionally) sets their handle.
export async function POST(req: Request) {
  let body: { token?: string; optIn?: boolean; handle?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const limited = rateLimitOr429("lb-optin:" + body.token, 10, 60_000);
  if (limited) return limited;
  const handle =
    typeof body.handle === "string"
      ? body.handle.trim().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40)
      : undefined;
  const result = await setFanLeaderboardOptIn(body.token, Boolean(body.optIn), handle);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
