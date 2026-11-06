import type { CampaignPack } from "@/lib/data/types";
import { DEFAULT_CHASE_WITHIN, DEFAULT_FOCUS_MULTIPLIER, DEFAULT_FOCUS_SPINS, MIN_FOCUS_SPINS, MAX_FOCUS_SPINS, MIN_FOCUS_MULTIPLIER, MAX_COMBINED_BOOST, isFocusLength, isFocusMultiplier } from "@/lib/focus/config";

export type PackKind = "spins" | "focus" | "chase";
export interface PackFormDraft { label: string; spins: string; amount: string; bonus: string; kind: PackKind; multiplier: string; duration: string }
export function packFormDraft(pack?: CampaignPack): PackFormDraft {
  return { label: pack?.label ?? "", spins: pack ? String(pack.spins) : "", amount: pack ? (pack.amountCents / 100).toFixed(2) : "", bonus: pack ? String(pack.bonusSpins) : "", kind: pack?.packKind ?? "spins", multiplier: String(pack?.focusMultiplier ?? DEFAULT_FOCUS_MULTIPLIER), duration: String(pack?.packKind === "chase" ? pack.chaseWithin ?? DEFAULT_CHASE_WITHIN : pack?.focusSpins ?? DEFAULT_FOCUS_SPINS) };
}
export function parsePackForm(draft: PackFormDraft): { value: Pick<CampaignPack, "label" | "spins" | "amountCents" | "bonusSpins" | "packKind" | "focusMultiplier" | "focusSpins" | "chaseWithin"> } | { error: string } {
  const label = draft.label.trim();
  const amountCents = Math.round(Number(draft.amount) * 100);
  if (!label || !draft.amount.trim() || !Number.isSafeInteger(amountCents) || amountCents < 0) return { error: "Enter a label and a valid non-negative price." };
  if (draft.kind !== "spins") {
    const duration = Number(draft.duration);
    const multiplier = Number(draft.multiplier);
    if (!isFocusLength(duration)) return { error: `Choose a whole duration from ${MIN_FOCUS_SPINS} to ${MAX_FOCUS_SPINS} spins.` };
    if (draft.kind === "focus" && !isFocusMultiplier(multiplier)) return { error: `Choose a Focus multiplier from ${MIN_FOCUS_MULTIPLIER} to ${MAX_COMBINED_BOOST}.` };
    return { value: { label, spins: duration, amountCents, bonusSpins: 0, packKind: draft.kind, ...(draft.kind === "focus" ? { focusSpins: duration, focusMultiplier: multiplier } : { chaseWithin: duration }) } };
  }
  const spins = Number(draft.spins), bonusSpins = Number(draft.bonus || 0);
  if (!Number.isSafeInteger(spins) || spins <= 0 || !Number.isSafeInteger(bonusSpins) || bonusSpins < 0) return { error: "Spins must be positive whole numbers; bonus spins must be non-negative whole numbers." };
  return { value: { label, spins, amountCents, bonusSpins, packKind: "spins" } };
}
