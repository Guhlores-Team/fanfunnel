import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";

// Creates a unique, working fan pass and returns its token. The creator's
// dashboard calls this so every generated link genuinely opens and spins.
export async function POST(req: Request) {
  let body: {
    name?: string;
    spins?: number;
    fanId?: string;
    wheelId?: string;
    campaignId?: string;
    amountDollars?: number;
    packId?: string;
    bonusSpins?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

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
    name: String(body.name ?? "").slice(0, 80),
    spins,
    fanId: body.fanId,
    wheelId: body.wheelId,
    campaignId: body.campaignId,
    amountCents: Math.round(amountDollars * 100),
    packId: body.packId,
    bonusSpins,
  });

  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
