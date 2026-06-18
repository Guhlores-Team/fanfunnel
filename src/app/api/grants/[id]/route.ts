import { NextResponse } from "next/server";
import { editGrant } from "@/lib/data";

// Edit an existing grant (spins / $ / campaign) after the fact.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { spins?: number; amountCents?: number; campaignId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const validBoundedInt = (n: unknown, max: number) =>
    typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= max;
  if (body.spins !== undefined && !validBoundedInt(body.spins, 1_000_000)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.amountCents !== undefined && !validBoundedInt(body.amountCents, 100_000_000)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await editGrant(id, body);
  if ("error" in result) {
    const status =
      result.error === "unauthorized" ? 401 : result.error === "not_found" ? 404 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
