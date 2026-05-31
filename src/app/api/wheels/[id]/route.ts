import { NextResponse } from "next/server";
import {
  getWheelById,
  setActiveWheel,
  setWheelSchedule,
  archiveWheel,
} from "@/lib/data";

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

function statusForError(error: string): number {
  if (error === "unauthorized") return 401;
  if (error === "not_found") return 404;
  return 400;
}

// Activate and/or schedule a wheel. Both can be applied in one PATCH; the first
// error (if any) is returned, else { ok: true }.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: {
    isActive?: boolean;
    activeFrom?: string | null;
    activeUntil?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.isActive === true) {
    const result = await setActiveWheel(id);
    if ("error" in result) {
      return NextResponse.json(result, { status: statusForError(result.error) });
    }
  }

  if ("activeFrom" in body || "activeUntil" in body) {
    const result = await setWheelSchedule(id, {
      activeFrom: body.activeFrom ?? null,
      activeUntil: body.activeUntil ?? null,
    });
    if ("error" in result) {
      return NextResponse.json(result, { status: statusForError(result.error) });
    }
  }

  return NextResponse.json({ ok: true });
}

// Archive a wheel.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await archiveWheel(id);
  if ("error" in result) {
    return NextResponse.json(result, { status: statusForError(result.error) });
  }
  return NextResponse.json({ ok: true });
}
