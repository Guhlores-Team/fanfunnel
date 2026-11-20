import { NextResponse } from "next/server";
import { getFanFocusState } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
export async function POST(req: Request) {
  const response = await withFanToken(req, { scope: "fan-focus", limit: 60, windowMs: 60_000 }, async token => {
    const result = await getFanFocusState(token);
    return NextResponse.json(result, { status: "error" in result ? result.error === "not_found" ? 404 : result.error === "blocked" ? 403 : 503 : 200 });
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
