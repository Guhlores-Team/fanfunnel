import { NextResponse } from "next/server";
import { getSpinAttemptStatus } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { validSpinIntent } from "@/lib/data/spinAttempts";

export async function POST(req: Request) {
  const response = await withFanToken<{ token?: unknown; requestId?: unknown; clientSeed?: unknown; publishedSeedHash?: unknown }>(req,
    { scope: "spin-status", limit: 60, windowMs: 60_000 }, async (token, body) => {
      if (!validSpinIntent(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      const result = await getSpinAttemptStatus(token, body);
      return NextResponse.json(result, { status: result.status === "conflict" ? 409 : result.status === "unavailable" ? 503 : 200 });
    });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
