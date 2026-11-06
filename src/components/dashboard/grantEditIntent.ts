"use client";

import { completeCreatorIntent, durableCreatorIntent, readCreatorIntent, type IntentStorage } from "./creatorIntent";
import { grantSaveAmount, MAX_GRANT_AMOUNT_CENTS, parseSpins, perSpinText } from "./grantImpact";

export interface GrantEditBaseline { id: string; spins: number; amountCents: number; campaignId: string | null }
export interface GrantEditFields { spins: string; perSpin: string; campaignId: string }
export interface GrantEditPatch { spins?: number; amountCents?: number; campaignId?: string | null }
export const grantEditScope = (id: string) => `grant-edit:${id}`;
export const grantEditFields = (grant: GrantEditBaseline): GrantEditFields => ({ spins: String(grant.spins), perSpin: perSpinText(grant.spins, grant.amountCents), campaignId: grant.campaignId ?? "" });

/** Omission preserves unrelated saved terms. Explicit null clears campaign. */
export function buildGrantEditPatch(grant: GrantEditBaseline, fields: GrantEditFields): GrantEditPatch {
  const spins = parseSpins(fields.spins);
  const amountCents = grantSaveAmount({ grant, spinsInput: fields.spins, perSpinInput: fields.perSpin });
  const campaignId = fields.campaignId || null;
  return { ...(spins !== grant.spins ? { spins } : {}), ...(amountCents !== grant.amountCents ? { amountCents } : {}), ...(campaignId !== grant.campaignId ? { campaignId } : {}) };
}

/** Preserve explicitly edited fields while reviewing newer server terms. */
export function rebaseGrantEditFields(previous: GrantEditBaseline, current: GrantEditBaseline, fields: GrantEditFields): GrantEditFields {
  const priceChanged = grantSaveAmount({ grant: previous, spinsInput: String(previous.spins), perSpinInput: fields.perSpin }) !== previous.amountCents;
  return { spins: parseSpins(fields.spins) === previous.spins ? String(current.spins) : fields.spins, perSpin: priceChanged ? fields.perSpin : perSpinText(current.spins, current.amountCents), campaignId: (fields.campaignId || null) === previous.campaignId ? current.campaignId ?? "" : fields.campaignId };
}

function exactPatch(patch: GrantEditPatch): GrantEditPatch {
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !["spins", "amountCents", "campaignId"].includes(key))) throw new Error("invalid_patch");
  const value: GrantEditPatch = {};
  if (Object.hasOwn(patch, "spins")) {
    if (!Number.isSafeInteger(patch.spins) || patch.spins! < 0 || patch.spins! > 1_000_000) throw new Error("invalid_patch");
    value.spins = patch.spins;
  }
  if (Object.hasOwn(patch, "amountCents")) {
    if (!Number.isSafeInteger(patch.amountCents) || patch.amountCents! < 0 || patch.amountCents! > MAX_GRANT_AMOUNT_CENTS) throw new Error("invalid_patch");
    value.amountCents = patch.amountCents;
  }
  if (Object.hasOwn(patch, "campaignId")) {
    if (patch.campaignId !== null && (typeof patch.campaignId !== "string" || !patch.campaignId || patch.campaignId.length > 200)) throw new Error("invalid_patch");
    value.campaignId = patch.campaignId;
  }
  return Object.freeze(value);
}

export type GrantEditSubmission = { status: "confirmed"; replayed: boolean } | { status: "pending"; error?: string } | { status: "not_sent"; reason: "invalid_patch" | "intent_pending" | "storage_unavailable" };
type Reply = { ok: boolean; json: () => Promise<unknown> };
/** The return value deliberately omits grant terms: refetch current detail. */
export async function submitGrantEdit(storage: IntentStorage, grantId: string, proposed: GrantEditPatch, send: (body: GrantEditPatch & { requestId: string }) => Promise<Reply>): Promise<GrantEditSubmission> {
  let patch: GrantEditPatch;
  try { patch = exactPatch(proposed); } catch { return { status: "not_sent", reason: "invalid_patch" }; }
  let requestId: string;
  try { requestId = await durableCreatorIntent(storage, grantEditScope(grantId), { grantId, patch }); }
  catch (error) { return { status: "not_sent", reason: error instanceof Error && error.message === "intent_pending" ? "intent_pending" : "storage_unavailable" }; }
  try {
    const response = await send({ ...patch, requestId });
    const raw = await response.json();
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    if (!response.ok || !body || body.ok !== true || body.requestId !== requestId || body.grantId !== grantId || typeof body.replayed !== "boolean") return { status: "pending", ...(typeof body?.error === "string" ? { error: body.error } : {}) };
    if (readCreatorIntent(storage, grantEditScope(grantId))?.id !== requestId) return { status: "pending" };
    completeCreatorIntent(storage, grantEditScope(grantId), requestId);
    return { status: "confirmed", replayed: body.replayed };
  } catch { return { status: "pending" }; }
}
