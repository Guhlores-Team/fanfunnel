import { NextResponse } from "next/server";
import { acceptMyTerms, getMyTermsStatus } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// The signed-in creator's acceptance of the Terms of Service and Privacy Policy
// (migration 0055). GET reads it; POST { accept: true } records it.
//
// The body is a confirmation and nothing else: any user id, version or date in
// it is ignored. The account is the session user, the version is the server's
// LEGAL.version and the time is the database's now(), so a client can neither
// accept for someone else nor forge or backdate an acceptance.
export async function GET() {
  const result = await getMyTermsStatus();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const limited = await rateLimitOr429("terms:" + clientIp(req), 10, 60_000);
  if (limited) return limited;
  const body = await parseJsonBody<{ accept?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  // Only a literal `true` counts as agreement.
  if (body.accept !== true) return badRequest("terms_required");
  const result = await acceptMyTerms();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
