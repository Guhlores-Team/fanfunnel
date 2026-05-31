import { NextResponse } from "next/server";
import { listCampaignPacks, createCampaignPack } from "@/lib/data";

// The creator's spin packs. `?campaignId=` scopes to one campaign (plus globals).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("campaignId") ?? undefined;
  const packs = await listCampaignPacks(campaignId);
  return NextResponse.json({ packs });
}

// Create a spin pack.
export async function POST(req: Request) {
  let body: {
    campaignId?: string | null;
    label?: string;
    spins?: number;
    amountCents?: number;
    bonusSpins?: number;
    sortOrder?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const label = String(body.label ?? "").trim();
  if (!label || body.spins == null || body.amountCents == null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
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
    const status = message === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
