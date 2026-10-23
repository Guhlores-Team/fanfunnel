import { NextResponse } from "next/server";
import {
  getWheelById,
  setActiveWheel,
  setWheelSchedule,
  archiveWheel,
  unarchiveWheel,
  deleteWheel,
} from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Load one wheel's full config.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const wheel = await getWheelById(id);
  if (!wheel) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ wheel });
}

// Activate and/or schedule a wheel. Both can be applied in one PATCH; the first
// error (if any) is returned, else { ok: true }.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await parseJsonBody<{
    isActive?: boolean;
    archived?: boolean;
    activeFrom?: string | null;
    activeUntil?: string | null;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  // Validate field types up front so a malformed payload returns 400 cleanly.
  if (
    (body.isActive !== undefined && typeof body.isActive !== "boolean") ||
    (body.archived !== undefined && typeof body.archived !== "boolean") ||
    (typeof body.activeFrom === "string" &&
      Number.isNaN(new Date(body.activeFrom).getTime())) ||
    (typeof body.activeUntil === "string" &&
      Number.isNaN(new Date(body.activeUntil).getTime()))
  ) {
    return badRequest();
  }

  // The writes below run as separate calls, so a failure partway through could
  // otherwise leave the wheel half-updated (e.g. unarchived but never made
  // active). Lacking a DB transaction at this layer, we make the operation
  // effectively atomic by running every check that can fail *before* any write:
  // resolve the wheel once (getWheelById is creator-scoped, so a null result is
  // not-found/unauthorized) and validate the schedule window up front. After
  // these guards the remaining calls only fail on transient DB errors.
  const existing = await getWheelById(id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const scheduleChanged = "activeFrom" in body || "activeUntil" in body;
  const nextFrom = body.activeFrom ?? null;
  const nextUntil = body.activeUntil ?? null;
  if (
    scheduleChanged &&
    nextFrom &&
    nextUntil &&
    new Date(nextUntil).getTime() <= new Date(nextFrom).getTime()
  ) {
    return NextResponse.json({ error: "invalid_window" }, { status: 400 });
  }

  // Restore an archived wheel.
  if (body.archived === false) {
    const result = await unarchiveWheel(id);
    if ("error" in result) return errorResponse(result.error);
  }

  if (body.isActive === true) {
    const result = await setActiveWheel(id);
    if ("error" in result) return errorResponse(result.error);
  }

  if (scheduleChanged) {
    const result = await setWheelSchedule(id, {
      activeFrom: nextFrom,
      activeUntil: nextUntil,
    });
    if ("error" in result) return errorResponse(result.error);
  }

  return NextResponse.json({ ok: true });
}

// Archive a wheel — or permanently delete it with `?hard=1` (only allowed when
// the wheel has no spin history; otherwise returns 409 has_history).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const hard = new URL(req.url).searchParams.get("hard") === "1";
  const result = hard ? await deleteWheel(id) : await archiveWheel(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
