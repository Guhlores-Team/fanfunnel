import { NextResponse } from "next/server";
import { listCampaignPacks, createCampaignPack } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// The creator's spin packs. `?campaignId=` scopes to one campaign (plus globals).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("campaignId") ?? undefined;
  const packs = await listCampaignPacks(campaignId);
  return NextResponse.json({ packs });
}

// Create a spin pack.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    campaignId?: string | null;
    label?: string;
    spins?: number;
    amountCents?: number;
    bonusSpins?: number;
    sortOrder?: number;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const label = String(body.label ?? "").trim();
  if (!label || body.spins == null || body.amountCents == null) {
    return badRequest();
  }

  try {
    const pack = await createCampaignPack({
      campaignId: body.campaignId ?? null,
      label,
      spins: Number(body.spins),
      amountCents: Number(body.amountCents),
      bonusSpins: body.bonusSpins != null ? Number(body.bonusSpins) : undefined,
      sortOrder: body.sortOrder != null ? Number(body.sortOrder) : undefined,
    });
    return NextResponse.json({ pack });
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    return errorResponse(message);
  }
}
