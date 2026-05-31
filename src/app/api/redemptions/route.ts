import { NextResponse } from "next/server";
import { setRedemptionStatus } from "@/lib/data";
import type { RedemptionStatus } from "@/lib/data/types";

const VALID: RedemptionStatus[] = ["pending", "fulfilled", "cancelled"];

// Mark a won prize as fulfilled / cancelled / pending.
export async function POST(req: Request) {
  let body: { id?: string; status?: RedemptionStatus };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.id || !body.status || !VALID.includes(body.status)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await setRedemptionStatus(body.id, body.status);
  if ("error" in result) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
