import { NextResponse } from "next/server";
import { isUuid } from "@/lib/data/shared";
import { createPass } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Creates a unique, working fan pass and returns its token. The creator's
// dashboard calls this so every generated link genuinely opens and spins.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "passes:POST");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{
    name?: string;
    spins?: number;
    fanId?: string;
    wheelId?: string;
    campaignId?: string;
    amountDollars?: number;
    packId?: string;
    packUnits?: number;
    bonusSpins?: number;
    requestId?: string;
  }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object" || Array.isArray(body)) return badRequest();

  if (body.requestId === undefined) return badRequest("upgrade_required");
  if (typeof body.requestId !== "string" || !isUuid(body.requestId) || body.requestId !== body.requestId.toLowerCase()) return badRequest();

  if (body.packUnits !== undefined && (!Number.isInteger(body.packUnits) || body.packUnits < 1 || body.packUnits > 1_000_000)) return badRequest();

  // WC-01: a new fan needs a real handle; a nameless live link cannot be told
  // apart from another. Top-ups (fanId) carry no name.
  const name = String(body.name ?? "").trim();
  if (!body.fanId && !name) return badRequest("name_required");
  if (name.length > 80) return badRequest("name_too_long");

  const spins = Number(body.spins ?? 0);
  if (!Number.isInteger(spins) || spins < 0 || spins > 1_000_000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const amountDollars = body.amountDollars != null ? Number(body.amountDollars) : 0;
  if (!Number.isFinite(amountDollars) || amountDollars < 0 || amountDollars > 1_000_000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let bonusSpins: number | undefined;
  if (body.bonusSpins != null) {
    bonusSpins = Number(body.bonusSpins);
    if (!Number.isInteger(bonusSpins) || bonusSpins < 0 || bonusSpins > 1_000_000) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  const result = await createPass({
    name,
    spins,
    fanId: body.fanId,
    wheelId: body.wheelId,
    campaignId: body.campaignId,
    amountCents: Math.round(amountDollars * 100),
    packId: body.packId,
    packUnits: body.packUnits,
    bonusSpins,
    requestId: body.requestId,
  });

  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
