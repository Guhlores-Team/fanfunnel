import { NextResponse } from "next/server";
import { setOnboardingDismissed } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Persist the creator's Get-started checklist dismissal to their account, so it
// follows them across devices instead of living in one browser's localStorage.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ dismissed?: boolean }>(req);
  if (body === BAD_REQUEST) return badRequest();

  if (typeof body.dismissed !== "boolean") {
    return badRequest();
  }

  const result = await setOnboardingDismissed(body.dismissed);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
