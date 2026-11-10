import { NextResponse } from "next/server";
import { getSpinAttemptStatus } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { validSpinIntent } from "@/lib/data/spinAttempts";
import { withClaimCode } from "@/lib/rewards/claimCode";

// OPS3-02: each RPC on the spin path aborts after SPIN_RPC_TIMEOUT_MS (an
// aborted call is reported as spin_pending with the request id kept); this
// caps the whole invocation, retries included.
export const maxDuration = 30;

export async function POST(req: Request) {
  const response = await withFanToken<{ token?: unknown; requestId?: unknown; clientSeed?: unknown; publishedSeedHash?: unknown }>(req,
    { scope: "spin-status", limit: 60, windowMs: 60_000 }, async (token, body) => {
      if (!validSpinIntent(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      const result = await getSpinAttemptStatus(token, body);
      // RS-01: an unknown link is a 404 (counted by withFanMissLimit, C2), a
      // genuinely unreachable ledger a 503 with a retry hint.
      if (result.status === "not_found") return NextResponse.json({ error: "not_found", status: "not_found" }, { status: 404 });
      const withCode = "result" in result && result.result ? { ...result, result: withClaimCode(result.result) } : result;
      return NextResponse.json(withCode, { status: result.status === "conflict" ? 409 : result.status === "unavailable" ? 503 : 200,
        ...(result.status === "unavailable" ? { headers: { "Retry-After": "5" } } : {}) });
    });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
