import { NextResponse } from "next/server";
import { recordCheckin } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { CHECKIN_RATE_LIMIT } from "@/lib/glow/config";

// RM-3: a fan's visit, for the visit glow. Body: { token, localDate }.
// The link token is the only credential (fans have no session); the fan and
// creator come from the token's active pass server-side, never from the body.
// The page sends this after hydration while it is visible, so link-preview
// bots that only fetch HTML never record a visit. It never grants spins.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: unknown; localDate?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object") return badRequest();
  const token = body.token;
  if (typeof token !== "string" || !token || token.length > 200) return badRequest();

  const limited = await rateLimitOr429(
    `checkin:${clientIp(req)}:${token}`,
    CHECKIN_RATE_LIMIT.limit,
    CHECKIN_RATE_LIMIT.windowMs,
  );
  if (limited) return limited;

  const result = await recordCheckin(token, body.localDate);
  const noStore = { headers: { "Cache-Control": "no-store" } };
  // A closed engagement gate (blocked; RM-6: on a break) is an ordinary state
  // for a link that still opens, not a failure: nothing is recorded and there
  // is simply no glow.
  if ("error" in result && result.error === "not_allowed") {
    return NextResponse.json({ glow: null, milestone: null }, noStore);
  }
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ glow: result.glow, milestone: result.milestone }, noStore);
}
