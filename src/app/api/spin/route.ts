import { NextResponse } from "next/server";
import { spin } from "@/lib/data";
import { rateLimitShared } from "@/lib/rateLimit";
import { clientIp } from "@/lib/api/clientIp";

// The ONLY place a spin outcome is decided. The browser sends just a token;
// the server validates spins remaining, picks the weighted prize, logs it,
// and returns the result for the wheel to animate to.
export async function POST(req: Request) {
  let token: string | undefined;
  let clientSeed: unknown;
  try {
    const body = await req.json();
    token = body?.token;
    clientSeed = body?.clientSeed;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // clientSeed is optional, but when present it must be a bounded string before
  // it reaches the provably-fair spin logic.
  if (clientSeed != null && (typeof clientSeed !== "string" || clientSeed.length > 256)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Key on the platform-supplied client IP (see clientIp for the precedence)
  // so the per-IP spin limit on this abuse-sensitive endpoint can't be
  // rotated away by a client-sent header.
  const key = token + ":" + clientIp(req);
  const { ok, retryAfter } = await rateLimitShared(key, 10, 10000);
  if (!ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(retryAfter / 1000)) },
      },
    );
  }

  const result = await spin(token, clientSeed);

  if ("error" in result) {
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "rate_limited"
          ? 429
          : result.error === "blocked" || result.error === "needs_ack" || result.error === "on_break"
            ? 403
            : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  // #26: a spin response can carry the winner's instant reward; never cache it.
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
