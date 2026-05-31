import { NextResponse } from "next/server";
import { updateCampaignPack, deleteCampaignPack } from "@/lib/data";

// Patch a spin pack's fields.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: Partial<{
    campaignId: string | null;
    label: string;
    spins: number;
    amountCents: number;
    bonusSpins: number;
    sortOrder: number;
  }>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const patch: Partial<{
    campaignId: string | null;
    label: string;
    spins: number;
    amountCents: number;
    bonusSpins: number;
    sortOrder: number;
  }> = {};
  if ("campaignId" in body) patch.campaignId = body.campaignId ?? null;
  if (body.label !== undefined) patch.label = String(body.label);
  if (body.spins !== undefined) patch.spins = Number(body.spins);
  if (body.amountCents !== undefined) patch.amountCents = Number(body.amountCents);
  if (body.bonusSpins !== undefined) patch.bonusSpins = Number(body.bonusSpins);
  if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder);

  const result = await updateCampaignPack(id, patch);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json({ ok: true });
}

// Delete a spin pack.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteCampaignPack(id);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json({ ok: true });
}
