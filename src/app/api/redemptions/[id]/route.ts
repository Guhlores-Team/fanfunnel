import { NextResponse } from "next/server";
import { setRedemptionStatus, setRedemptionMeta } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
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

  // Validate every field up front, before any write, so an invalid input
  // can never persist one part of the patch while rejecting another (the
  // partial-update / inconsistent-state failure mode this guards against).
  if (body.status !== undefined && !VALID.includes(body.status)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const hasMeta = "notes" in body || "dueAt" in body;
  if (hasMeta) {
    // Cap notes and require dueAt (when present) to be a valid date.
    if (typeof body.notes === "string" && body.notes.length > 2000) {
      return NextResponse.json({ error: "notes_too_long" }, { status: 400 });
    }
    if (typeof body.dueAt === "string" && Number.isNaN(new Date(body.dueAt).getTime())) {
      return NextResponse.json({ error: "bad_due_date" }, { status: 400 });
    }
  }

  // Mock/in-memory path: no DB transactions exist here, so keep the original
  // per-field data-layer calls unchanged.
  if (!isSupabaseConfigured()) {
    if (body.status !== undefined) {
      const result = await setRedemptionStatus(id, body.status);
      if ("error" in result) {
        return NextResponse.json(result, { status: mapError(result.error) });
      }
    }

    if (hasMeta) {
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

  // Configured path: apply the status change and the notes/due-date change
  // together in a single atomic UPDATE so a failure cannot leave the redemption
  // half-updated (e.g. status changed but notes/due date stale, or vice versa).
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const update: {
    status?: RedemptionStatus;
    fulfilled_at?: string | null;
    notes?: string | null;
    due_at?: string | null;
  } = {};
  if (body.status !== undefined) {
    update.status = body.status;
    update.fulfilled_at =
      body.status === "fulfilled" ? new Date().toISOString() : null;
  }
  if ("notes" in body) update.notes = body.notes ?? null;
  if ("dueAt" in body) update.due_at = body.dueAt ?? null;

  // Nothing to change — preserve the original no-op success response.
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { data: updated, error } = await sb
    .from("redemptions")
    .update(update)
    .eq("id", id)
    .eq("creator_id", user.id)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "db_error" }, { status: 400 });
  }
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
