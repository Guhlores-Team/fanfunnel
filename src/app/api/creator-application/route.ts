import { NextResponse } from "next/server";
import { submitCreatorApplication } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";

// A signed-in, pending user submits their creator details for vetting.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    displayName?: string;
    socials?: string;
    audienceSize?: string;
    note?: string;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  // Reject over-long free-text instead of silently truncating (caps mirror the
  // data layer's column limits).
  let input: {
    displayName?: string;
    socials?: string;
    audienceSize?: string;
    note?: string;
  };
  try {
    input = {
      displayName: str(body.displayName, { max: 120 }),
      socials: str(body.socials, { max: 600 }),
      audienceSize: str(body.audienceSize, { max: 120 }),
      note: str(body.note, { max: 1000 }),
    };
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  const result = await submitCreatorApplication(input);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
