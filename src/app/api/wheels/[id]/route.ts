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

  // Restore an archived wheel.
  if (body.archived === false) {
    const result = await unarchiveWheel(id);
    if ("error" in result) return errorResponse(result.error);
  }

  if (body.isActive === true) {
    const result = await setActiveWheel(id);
    if ("error" in result) return errorResponse(result.error);
  }

  if ("activeFrom" in body || "activeUntil" in body) {
    const result = await setWheelSchedule(id, {
      activeFrom: body.activeFrom ?? null,
      activeUntil: body.activeUntil ?? null,
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
