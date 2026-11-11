import { NextResponse } from "next/server";
import { acceptMyTerms, submitCreatorApplication, updateMyCreatorApplication } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";
import { limitRoute } from "@/lib/api/limit";

type Body = {
  displayName?: string;
  socials?: string;
  audienceSize?: string;
  note?: string;
  acceptTerms?: unknown;
};

// Reject over-long free-text instead of silently truncating (caps mirror the
// data layer's column limits).
function readInput(body: Body) {
  return {
    displayName: str(body.displayName, { max: 120 }),
    socials: str(body.socials, { max: 600 }),
    audienceSize: str(body.audienceSize, { max: 120 }),
    note: str(body.note, { max: 1000 }),
  };
}

// A signed-in, pending user submits their creator details for vetting. The form
// carries the Terms clickwrap: `acceptTerms` must be literally true, and the
// acceptance is recorded server-side (session user, LEGAL.version, now()).
// One request per account: a second POST answers 409 already_submitted.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "creator-application:POST", "costly");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<Body>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  if (body.acceptTerms !== true) return badRequest("terms_required");

  let input: ReturnType<typeof readInput>;
  try {
    input = readInput(body);
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  const accepted = await acceptMyTerms();
  if ("error" in accepted) return errorResponse(accepted.error);

  const result = await submitCreatorApplication(input);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}

// C21: the applicant edits their own still-pending request (never another
// account's, never a decided one: the data layer pins both). The Terms were
// accepted with the first submit.
export async function PATCH(req: Request) {
  const rateLimited = await limitRoute(req, "creator-application:PATCH", "costly");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<Body>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  let input: ReturnType<typeof readInput>;
  try {
    input = readInput(body);
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }
  const result = await updateMyCreatorApplication(input);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
