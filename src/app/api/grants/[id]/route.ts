import { NextResponse } from "next/server";
import { isUuid } from "@/lib/data/shared";
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
    requestId?: unknown;
    spins?: unknown;
    amountCents?: unknown;
    campaignId?: unknown;
  }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || Array.isArray(body)) return badRequest();
  if (body.requestId === undefined) return badRequest("upgrade_required");
  if (typeof body.requestId !== "string" || !isUuid(body.requestId) || body.requestId !== body.requestId.toLowerCase()) return badRequest();

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

  const result = await editGrant(id, patch, body.requestId);
  if ("error" in result) return result.error === "edit_pending" ? NextResponse.json({ error: "edit_pending", requestId: body.requestId }, { status: 503, headers: { "Cache-Control": "no-store" } }) : errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
