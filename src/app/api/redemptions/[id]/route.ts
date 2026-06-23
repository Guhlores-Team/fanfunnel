import { NextResponse } from "next/server";
import { setRedemptionStatus, setRedemptionMeta } from "@/lib/data";
import type { RedemptionStatus } from "@/lib/data/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

const VALID: RedemptionStatus[] = [
  "pending",
  "in_progress",
  "fulfilled",
  "cancelled",
];

// Patch a won prize: change its status and/or its notes / due date.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await parseJsonBody<{
    status?: RedemptionStatus;
    notes?: string | null;
    dueAt?: string | null;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  if (body.status !== undefined && !VALID.includes(body.status)) {
    return badRequest();
  }

  if (body.status !== undefined) {
    const result = await setRedemptionStatus(id, body.status);
    if ("error" in result) return errorResponse(result.error);
  }

  if ("notes" in body || "dueAt" in body) {
    // Cap notes and require dueAt (when present) to be a valid date.
    if (typeof body.notes === "string" && body.notes.length > 2000) {
      return badRequest("notes_too_long");
    }
    if (typeof body.dueAt === "string" && Number.isNaN(new Date(body.dueAt).getTime())) {
      return badRequest("bad_due_date");
    }
    const patch: { notes?: string | null; dueAt?: string | null } = {};
    if ("notes" in body) patch.notes = body.notes ?? null;
    if ("dueAt" in body) patch.dueAt = body.dueAt ?? null;
    const result = await setRedemptionMeta(id, patch);
    if ("error" in result) return errorResponse(result.error);
  }

  return NextResponse.json({ ok: true });
}
