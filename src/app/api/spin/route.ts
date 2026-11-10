import { NextResponse } from "next/server";
import { spin } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { validSpinIntent } from "@/lib/data/spinAttempts";
import { withClaimCode } from "@/lib/rewards/claimCode";
import { statusForError } from "@/lib/api/handler";

/**
 * RS-02: the HTTP status of a refused spin. A server-side fault (`db_error`,
 * `unavailable`) or an answer the ledger could not settle (`spin_pending`) is
 * a 503 with Retry-After, never a 409 the fan would read as "you did this".
 * The remaining codes keep the shared convention (statusForError), with the
 * two pre-attempt refusals that are not in it mapped here: no spins / no
 * prizes are 409 (the page's out-of-spins moment), an unknown link 404.
 */
export const RETRY_LATER: ReadonlySet<string> = new Set(["db_error", "unavailable", "spin_pending"]);
export function spinErrorStatus(code: string): number {
  if (RETRY_LATER.has(code)) return 503;
  if (code === "no_spins" || code === "no_prizes") return 409;
  if (code === "unauthorized") return 401;
  const shared = statusForError(code);
  return shared === 400 && code !== "bad_request" && code !== "invalid" ? 409 : shared;
}

export async function POST(req: Request) {
  const response = await withFanToken<{ token?: unknown; requestId?: unknown; clientSeed?: unknown; publishedSeedHash?: unknown }>(req,
    { scope: "spin", limit: 10, windowMs: 10_000 }, async (token, body) => {
      // Browser identity must exist BEFORE the request. Never mint an unknown winner identity here.
      if (body.requestId == null) return NextResponse.json({ error: "upgrade_required" }, { status: 400 });
      if (!validSpinIntent(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      const result = await spin(token, body.clientSeed, body.requestId, body.publishedSeedHash);
      if ("error" in result) return NextResponse.json({ error: result.error }, { status: spinErrorStatus(result.error), ...(RETRY_LATER.has(result.error) ? { headers: { "Retry-After": "5" } } : {}) });
      return NextResponse.json(withClaimCode(result));
    });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
