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

  // Require finite, non-negative integers within explicit max bounds.
  const asBoundedInt = (value: unknown, max: number): number | null => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > max) return null;
    return n;
  };

  const spins = asBoundedInt(body.spins, 1_000_000);
  const amountCents = asBoundedInt(body.amountCents, 100_000_000);
  const bonusSpins = body.bonusSpins != null ? asBoundedInt(body.bonusSpins, 1_000_000) : undefined;
  const sortOrder = body.sortOrder != null ? asBoundedInt(body.sortOrder, 1_000_000) : undefined;

  if (spins == null || amountCents == null || bonusSpins === null || sortOrder === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const pack = await createCampaignPack({
      campaignId: body.campaignId ?? null,
      label,
      spins,
      amountCents,
      bonusSpins,
      sortOrder,
    });
    return NextResponse.json({ pack });
  } catch (err) {
    // Only surface controlled error codes (lowercase_snake). Never reflect an
    // unexpected error's raw message — it can leak internals to the client.
    const raw = err instanceof Error ? err.message : "";
    return errorResponse(/^[a-z][a-z0-9_]*$/.test(raw) ? raw : "db_error");
  }
}
