// Data layer — fulfilment: redemption (won prize) status and notes.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { RedemptionStatus } from "./types";
import { mockSetRedemptionStatus, mockSetRedemptionMeta, mockIsInstantRedemption } from "./mock";
import { demoActingCreator, resolveActingCreator } from "./seatScope";

// A19: `creatorId` (untrusted input) lets a staff seat fulfil for a creator in
// its agency; it needs can_act_for(creatorId, 'fulfil'), checked here on the
// caller's session before the write, and the redemptions RLS checks it again.

export async function setRedemptionStatus(
  id: string,
  status: RedemptionStatus,
  creatorId?: unknown,
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    const refused = demoActingCreator(creatorId);
    if (refused) return refused;
    if (status !== "fulfilled" && mockIsInstantRedemption(id)) return { error: "already_delivered" };
    return mockSetRedemptionStatus(id, status)
      ? { ok: true }
      : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const acting = await resolveActingCreator(sb, user.id, creatorId, "fulfil");
  if ("error" in acting) return acting;

  const { data, error } = await sb
    .from("redemptions")
    .update({
      status,
      fulfilled_at: status === "fulfilled" ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .eq("creator_id", acting.creatorId)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.code === "23514" && /already delivered/.test(error.message) ? "already_delivered" : "db_error" };
  return data ? { ok: true } : { error: "not_found" };
}

// Update a redemption's notes and/or due date, leaving its status untouched.
export async function setRedemptionMeta(
  id: string,
  patch: { notes?: string | null; dueAt?: string | null },
  creatorId?: unknown,
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) {
    const refused = demoActingCreator(creatorId);
    if (refused) return refused;
    if (patch.dueAt != null && mockIsInstantRedemption(id)) return { error: "already_delivered" };
    return mockSetRedemptionMeta(id, patch)
      ? { ok: true }
      : { error: "not_found" };
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const acting = await resolveActingCreator(sb, user.id, creatorId, "fulfil");
  if ("error" in acting) return acting;

  const update: { notes?: string | null; due_at?: string | null } = {};
  if ("notes" in patch) update.notes = patch.notes ?? null;
  if ("dueAt" in patch) update.due_at = patch.dueAt ?? null;
  if (Object.keys(update).length === 0) return { ok: true };

  const { data, error } = await sb
    .from("redemptions")
    .update(update)
    .eq("id", id)
    .eq("creator_id", acting.creatorId)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.code === "23514" && /already delivered/.test(error.message) ? "already_delivered" : "db_error" };
  return data ? { ok: true } : { error: "not_found" };
}
