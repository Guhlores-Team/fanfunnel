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
  // Validate a supplied numeric field: must be a finite, non-negative,
  // whole number within range. Returns the number, or null if invalid.
  const MAX_VALUE = 1_000_000_000;
  const validNumber = (value: unknown): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_VALUE) {
      return null;
    }
    return n;
  };

  if ("campaignId" in body) patch.campaignId = body.campaignId ?? null;
  if (body.label !== undefined) patch.label = String(body.label);
  if (body.spins !== undefined) {
    const spins = validNumber(body.spins);
    if (spins === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch.spins = spins;
  }
  if (body.amountCents !== undefined) {
    const amountCents = validNumber(body.amountCents);
    if (amountCents === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch.amountCents = amountCents;
  }
  if (body.bonusSpins !== undefined) {
    const bonusSpins = validNumber(body.bonusSpins);
    if (bonusSpins === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch.bonusSpins = bonusSpins;
  }
  if (body.sortOrder !== undefined) {
    const sortOrder = validNumber(body.sortOrder);
    if (sortOrder === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    patch.sortOrder = sortOrder;
  }

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
