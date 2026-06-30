import { NextResponse } from "next/server";
import { setRedemptionStatus } from "@/lib/data";
import type { RedemptionStatus } from "@/lib/data/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

const VALID: RedemptionStatus[] = ["pending", "in_progress", "fulfilled", "cancelled"];

// Mark a won prize as fulfilled / cancelled / pending.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ id?: string; status?: RedemptionStatus }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.id || !body.status || !VALID.includes(body.status)) {
    return badRequest();
  }

  const result = await setRedemptionStatus(body.id, body.status);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
