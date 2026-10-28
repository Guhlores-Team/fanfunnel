import { NextResponse } from "next/server";
import { spin } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { validSpinIntent } from "@/lib/data/spinAttempts";

export async function POST(req: Request) {
  const response = await withFanToken<{ token?: unknown; requestId?: unknown; clientSeed?: unknown; publishedSeedHash?: unknown }>(req,
    { scope: "spin", limit: 10, windowMs: 10_000 }, async (token, body) => {
      // Browser identity must exist BEFORE the request. Never mint an unknown winner identity here.
      if (body.requestId == null) return NextResponse.json({ error: "upgrade_required" }, { status: 400 });
      if (!validSpinIntent(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      const result = await spin(token, body.clientSeed, body.requestId, body.publishedSeedHash);
      if ("error" in result) {
        const status = result.error === "not_found" ? 404 : result.error === "rate_limited" ? 429
          : result.error === "blocked" || result.error === "needs_ack" || result.error === "on_break" ? 403 : 409;
        return NextResponse.json({ error: result.error }, { status });
      }
      return NextResponse.json(result);
    });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
