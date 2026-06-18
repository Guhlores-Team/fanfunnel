import { NextResponse } from "next/server";
import { setLeaderboardEnabled } from "@/lib/data";

// Creator toggles their public leaderboard on/off.
export async function POST(req: Request) {
  let body: { enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await setLeaderboardEnabled(body.enabled);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
