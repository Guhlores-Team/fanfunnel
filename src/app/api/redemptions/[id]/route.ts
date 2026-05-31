import { NextResponse } from "next/server";
import { setRedemptionStatus, setRedemptionMeta } from "@/lib/data";
import type { RedemptionStatus } from "@/lib/data/types";

const VALID: RedemptionStatus[] = [
  "pending",
  "in_progress",
  "fulfilled",
  "cancelled",
];

function mapError(error: string) {
  return error === "unauthorized" ? 401 : error === "not_found" ? 404 : 400;
}

// Patch a won prize: change its status and/or its notes / due date.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: {
    status?: RedemptionStatus;
    notes?: string | null;
    dueAt?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.status !== undefined && !VALID.includes(body.status)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.status !== undefined) {
    const result = await setRedemptionStatus(id, body.status);
    if ("error" in result) {
      return NextResponse.json(result, { status: mapError(result.error) });
    }
  }

  if ("notes" in body || "dueAt" in body) {
    const patch: { notes?: string | null; dueAt?: string | null } = {};
    if ("notes" in body) patch.notes = body.notes ?? null;
    if ("dueAt" in body) patch.dueAt = body.dueAt ?? null;
    const result = await setRedemptionMeta(id, patch);
    if ("error" in result) {
      return NextResponse.json(result, { status: mapError(result.error) });
    }
  }

  return NextResponse.json({ ok: true });
}
