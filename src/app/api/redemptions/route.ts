import { NextResponse } from "next/server";
import { setRedemptionStatus } from "@/lib/data";
import type { RedemptionStatus } from "@/lib/data/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { listRedemptionQueue } from "@/lib/data/redemptionQueue";

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

// A5: GET ?status=<status>&q=<fan or prize>&before=<cursor> — one page of the
// creator's own prize queue, newest first, read on the caller's session (RLS).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || undefined;
  const q = url.searchParams.get("q") ?? "";
  const before = url.searchParams.get("before");
  if (status !== undefined && !VALID.includes(status as RedemptionStatus)) return badRequest();
  if (q.length > 100 || (before !== null && before.length > 120)) return badRequest();
  const page = await listRedemptionQueue({ status: status as RedemptionStatus | undefined, query: q, before });
  if ("error" in page) return page.error === "db_error" ? NextResponse.json({ error: "db_error" }, { status: 500 }) : errorResponse(page.error);
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
