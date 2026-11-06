// Data layer — fulfilment: redemption (won prize) status and notes.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { RedemptionStatus } from "./types";
import { mockSetRedemptionStatus, mockSetRedemptionMeta, mockIsInstantRedemption } from "./mock";
import { demoActingCreator, resolveActingCreator } from "./seatScope";
import { isUuid } from "./shared";

// A19: `creatorId` (untrusted input) lets a staff seat fulfil for a creator in
// its agency; it needs can_act_for(creatorId, 'fulfil'), checked here on the
// caller's session before the write, and set_redemption_state checks it again.

export type RedemptionPatch = { status?: RedemptionStatus; notes?: string | null; dueAt?: string | null };
/** `stock` (0067): a limited unit went back to stock ("returned", on cancel) or was taken again ("taken", on reopen). */
export type RedemptionWriteResult = { ok: true; stock?: "returned" | "taken" } | { error: string };

/**
 * One atomic write of a won prize's status, notes and/or due date (0067).
 * It goes through set_redemption_state on the caller's session, which applies
 * the redemptions RLS check (can_act_for 'fulfil' or admin) and moves a
 * limited unit exactly once: a cancel returns the unit the win took, a reopen
 * takes it again (or answers sold_out and changes nothing).
 */
export async function patchRedemption(id: string, patch: RedemptionPatch, creatorId?: unknown): Promise<RedemptionWriteResult> {
  if (!isSupabaseConfigured()) {
    const refused = demoActingCreator(creatorId);
    if (refused) return refused;
    if (mockIsInstantRedemption(id) && ((patch.status !== undefined && patch.status !== "fulfilled") || patch.dueAt != null)) return { error: "already_delivered" };
    let stock: "returned" | "taken" | undefined;
    if (patch.status !== undefined) {
      const moved = mockSetRedemptionStatus(id, patch.status);
      if ("error" in moved) return moved;
      stock = moved.stock;
    }
    if ("notes" in patch || "dueAt" in patch) {
      const meta: { notes?: string | null; dueAt?: string | null } = {};
      if ("notes" in patch) meta.notes = patch.notes ?? null;
      if ("dueAt" in patch) meta.dueAt = patch.dueAt ?? null;
      if (!mockSetRedemptionMeta(id, meta)) return { error: "not_found" };
    }
    return stock ? { ok: true, stock } : { ok: true };
  }

  const body: Record<string, unknown> = {};
  if (patch.status !== undefined) body.status = patch.status;
  if ("notes" in patch) body.notes = patch.notes ?? null;
  if ("dueAt" in patch) body.due_at = patch.dueAt ?? null;
  if (Object.keys(body).length === 0) return { ok: true };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const acting = await resolveActingCreator(sb, user.id, creatorId, "fulfil");
  if ("error" in acting) return acting;
  if (!isUuid(id)) return { error: "not_found" };

  const { data, error } = await sb.rpc("set_redemption_state", { p_redemption: id, p_creator: acting.creatorId, p_patch: body });
  if (error) {
    // The instant-reward trigger refuses reopening or re-dating a win that was
    // already delivered; say so (409) so the queue can explain the rollback.
    if (error.code === "23514" && /already delivered/.test(error.message ?? "")) return { error: "already_delivered" };
    if (["22023", "22P02", "22007", "22008"].includes(error.code ?? "")) return { error: "bad_request" };
    return { error: "db_error" };
  }
  const result = data as { status?: unknown; stock?: unknown } | null;
  if (result?.status === "ok") return result.stock === "returned" || result.stock === "taken" ? { ok: true, stock: result.stock } : { ok: true };
  if (result?.status === "forbidden" || result?.status === "not_found" || result?.status === "sold_out") return { error: result.status };
  return { error: "db_error" };
}

export async function setRedemptionStatus(
  id: string,
  status: RedemptionStatus,
  creatorId?: unknown,
): Promise<RedemptionWriteResult> {
  return patchRedemption(id, { status }, creatorId);
}

// Update a redemption's notes and/or due date, leaving its status untouched.
export async function setRedemptionMeta(
  id: string,
  patch: { notes?: string | null; dueAt?: string | null },
  creatorId?: unknown,
): Promise<RedemptionWriteResult> {
  const meta: RedemptionPatch = {};
  if ("notes" in patch) meta.notes = patch.notes ?? null;
  if ("dueAt" in patch) meta.dueAt = patch.dueAt ?? null;
  return patchRedemption(id, meta, creatorId);
}
