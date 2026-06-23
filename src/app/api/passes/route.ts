import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Creates a unique, working fan pass and returns its token. The creator's
// dashboard calls this so every generated link genuinely opens and spins.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    name?: string;
    spins?: number;
    fanId?: string;
    wheelId?: string;
    campaignId?: string;
    amountDollars?: number;
    packId?: string;
    bonusSpins?: number;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const result = await createPass({
    name: String(body.name ?? "").slice(0, 80),
    spins: Number(body.spins ?? 0),
    fanId: body.fanId,
    wheelId: body.wheelId,
    campaignId: body.campaignId,
    amountCents: Math.round(Math.max(0, body.amountDollars || 0) * 100),
    packId: body.packId,
    bonusSpins: body.bonusSpins != null ? Number(body.bonusSpins) : undefined,
  });

  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
