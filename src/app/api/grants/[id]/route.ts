import { NextResponse } from "next/server";
import { editGrant } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, int, str } from "@/lib/api/validate";

// Edit an existing grant (spins / $ / campaign) after the fact.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await parseJsonBody<{
    spins?: unknown;
    amountCents?: unknown;
    campaignId?: unknown;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  let patch: { spins?: number; amountCents?: number; campaignId?: string | null };
  try {
    patch = {};
    if ("spins" in body) {
      patch.spins = int(body.spins, { min: 0, max: 1_000_000, required: true });
    }
    if ("amountCents" in body) {
      patch.amountCents = int(body.amountCents, { min: 0, max: 100_000_000, required: true });
    }
    if ("campaignId" in body) {
      // Explicit null clears the campaign link; a string must be a sane id.
      patch.campaignId =
        body.campaignId === null ? null : (str(body.campaignId, { max: 200, required: true }) ?? null);
    }
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  const result = await editGrant(id, patch);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
