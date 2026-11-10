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
import { revalidateMyPublicPage } from "@/lib/api/publicPage";
import { limitRoute } from "@/lib/api/limit";

// Load one wheel's full config.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "wheels/[id]:GET");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const wheel = await getWheelById(id);
  if (!wheel) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ wheel });
}

// The fields PATCH understands. Anything else is refused with 400 rather than
// answered 200 while nothing changes.
const PATCH_FIELDS = new Set(["isActive", "archived", "activeFrom", "activeUntil"]);
const isScheduleValue = (v: unknown) =>
  v === null || (typeof v === "string" && !Number.isNaN(new Date(v).getTime()));

// Activate, schedule, archive or restore a wheel. Activate, schedule and
// restore can be combined in one PATCH; the first error (if any) is returned,
// else { ok: true }. `archived: true` archives exactly as DELETE (no ?hard=1)
// does and must be sent alone.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "wheels/[id]:PATCH");
  if (rateLimited) return rateLimited;
  const { id } = await params;

  const body = await parseJsonBody<{
    isActive?: boolean;
    archived?: boolean;
    activeFrom?: string | null;
    activeUntil?: string | null;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  // Validate the payload up front so a malformed or no-op request returns 400
  // cleanly. Only `isActive: true` exists (a wheel stops being active when
  // another one is activated), so `isActive: false` would change nothing.
  const fields = Object.keys(body);
  if (fields.length === 0) return errorResponse("nothing_to_change");
  if (fields.some((field) => !PATCH_FIELDS.has(field))) return errorResponse("unsupported_field");
  if (
    (body.isActive !== undefined && body.isActive !== true) ||
    (body.archived !== undefined && typeof body.archived !== "boolean") ||
    ("activeFrom" in body && !isScheduleValue(body.activeFrom)) ||
    ("activeUntil" in body && !isScheduleValue(body.activeUntil))
  ) {
    return badRequest();
  }

  // Archive: the same data-layer call (and authorization) as DELETE without
  // ?hard=1. It takes the game off fans, so it is never mixed with activation
  // or scheduling in one request.
  if (body.archived === true) {
    if (fields.length > 1) return errorResponse("conflicting_fields");
    const result = await archiveWheel(id);
    if ("error" in result) return errorResponse(result.error);
    await revalidateMyPublicPage();
    return NextResponse.json({ ok: true });
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

  // Activation, schedule and restore all change which wheel /c/<slug> shows.
  await revalidateMyPublicPage();
  return NextResponse.json({ ok: true });
}

// Archive a wheel — or permanently delete it with `?hard=1` (only allowed when
// the wheel has no spin history and no fan link stored on it; otherwise
// returns 409 has_history).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "wheels/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const hard = query.get("hard") === "1";
  // WC-09: `empty=1` deletes only a game that still has no prize, play or
  // bingo card (409 not_empty otherwise), decided inside the database.
  const result = hard ? await deleteWheel(id, { onlyIfEmpty: query.get("empty") === "1" }) : await archiveWheel(id);
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyPublicPage();
  return NextResponse.json({ ok: true });
}
