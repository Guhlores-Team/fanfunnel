import { NextResponse } from "next/server";
import { patchRedemption, type RedemptionPatch } from "@/lib/data/fulfilment";
import type { RedemptionStatus } from "@/lib/data/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

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
  const rateLimited = await limitRoute(req, "redemptions/[id]:PATCH");
  if (rateLimited) return rateLimited;
  const { id } = await params;

  const body = await parseJsonBody<{
    status?: RedemptionStatus;
    notes?: string | null;
    dueAt?: string | null;
    /** A19: fulfil for a creator the caller's seat may fulfil for. */
    creatorId?: unknown;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  // Validate every field up front, before any write, so an invalid input
  // can never persist one part of the patch while rejecting another (the
  // partial-update / inconsistent-state failure mode this guards against).
  if (body.status !== undefined && !VALID.includes(body.status)) {
    return badRequest();
  }

  const hasMeta = "notes" in body || "dueAt" in body;
  if (hasMeta) {
    // Reject non-string, non-null notes/dueAt so a stray number/object can't
    // slip past the length/date checks and corrupt the stored meta.
    if ("notes" in body && body.notes !== null && typeof body.notes !== "string") {
      return badRequest();
    }
    if ("dueAt" in body && body.dueAt !== null && typeof body.dueAt !== "string") {
      return badRequest();
    }
    // Cap notes and require dueAt (when present) to be a valid date.
    if (typeof body.notes === "string" && body.notes.length > 2000) {
      return badRequest("notes_too_long");
    }
    if (typeof body.dueAt === "string" && Number.isNaN(new Date(body.dueAt).getTime())) {
      return badRequest("bad_due_date");
    }
  }

  // One write for the status and the notes/due-date change, so a failure
  // cannot leave the redemption half-updated. Connected, it is the atomic
  // set_redemption_state on the caller's session (0067), which also returns a cancelled prize's limited unit to
  // stock exactly once (and takes it again on reopen).
  const patch: RedemptionPatch = {};
  if (body.status !== undefined) patch.status = body.status;
  if ("notes" in body) patch.notes = body.notes ?? null;
  if ("dueAt" in body) patch.dueAt = body.dueAt ?? null;
  const result = await patchRedemption(id, patch, body.creatorId);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
