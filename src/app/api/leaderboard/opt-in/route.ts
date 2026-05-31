import { NextResponse } from "next/server";
import { setFanLeaderboardOptIn } from "@/lib/data";

// A fan opts in/out of the public leaderboard and (optionally) sets their handle.
export async function POST(req: Request) {
  let body: { token?: string; optIn?: boolean; handle?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await setFanLeaderboardOptIn(body.token, Boolean(body.optIn), body.handle);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
