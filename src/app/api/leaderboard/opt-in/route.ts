import { NextResponse } from "next/server";
import { setFanLeaderboardOptIn } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

/** Allow-list for a public board name: ASCII letters/digits plus `_ . -`. */
const HANDLE_ALLOWED = /^[a-zA-Z0-9_.-]+$/;
const HANDLE_MIN = 2;
const HANDLE_MAX = 40;

/**
 * Validate a board name exactly as typed (surrounding whitespace trimmed).
 * Returns the handle, or an error code. A name that would need sanitising is
 * rejected rather than silently mangled ("Ålïcé" must not become "lc").
 */
export function validateHandle(
  raw: unknown
): { handle: string } | { error: "handle_required" | "handle_invalid" } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "handle_required" };
  const handle = raw.trim();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) return { error: "handle_invalid" };
  if (!HANDLE_ALLOWED.test(handle)) return { error: "handle_invalid" };
  if (!/[a-zA-Z0-9]/.test(handle)) return { error: "handle_invalid" };
  return { handle };
}

// A fan opts in/out of the public leaderboard and (when opting in) sets their
// board name. Token-gated (fans aren't authed).
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: unknown; optIn?: unknown; handle?: unknown }>(req);
  // `null`, arrays and scalars parse as valid JSON but aren't a request body.
  if (body === BAD_REQUEST || typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest();
  }
  if (typeof body.token !== "string" || !body.token) {
    return badRequest();
  }
  // Only a literal boolean counts; the string "false" is truthy and must never
  // read as consent.
  if (typeof body.optIn !== "boolean") return badRequest();
  const optIn = body.optIn === true;

  const limited = await rateLimitOr429("lb-optin:" + body.token, 10, 60_000);
  if (limited) return limited;

  // Opting IN requires a board name: without one the only thing the public
  // board could show is the fan's real name, which it must never do. Opting
  // OUT needs nothing and changes nothing else.
  let handle: string | undefined;
  if (optIn) {
    const v = validateHandle(body.handle);
    if ("error" in v) return badRequest(v.error);
    handle = v.handle;
  }
  const result = await setFanLeaderboardOptIn(body.token, optIn, handle);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
