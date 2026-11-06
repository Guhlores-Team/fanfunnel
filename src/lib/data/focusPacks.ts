import { DEFAULT_CHASE_WITHIN, DEFAULT_FOCUS_MULTIPLIER, DEFAULT_FOCUS_SPINS, isFocusLength, isFocusMultiplier } from "@/lib/focus/config";
export interface FocusPackTerms {
  packKind?: "spins" | "focus" | "chase";
  focusMultiplier?: number;
  focusSpins?: number;
  chaseWithin?: number;
}
export function focusPackTerms(input: FocusPackTerms & { spins: number; bonusSpins?: number }): Required<FocusPackTerms> | null {
  if ((["packKind", "focusMultiplier", "focusSpins", "chaseWithin"] as const).some(key => input[key] === null)) return null;
  const kind = input.packKind ?? "spins";
  if (kind !== "spins" && kind !== "focus" && kind !== "chase") return null;
  const multiplier = input.focusMultiplier ?? DEFAULT_FOCUS_MULTIPLIER;
  const length = input.focusSpins ?? DEFAULT_FOCUS_SPINS;
  const within = input.chaseWithin ?? DEFAULT_CHASE_WITHIN;
  if (!isFocusMultiplier(multiplier) || !isFocusLength(length) || !isFocusLength(within)) return null;
  const credits = input.spins + (input.bonusSpins ?? 0);
  if (kind !== "spins" && (!Number.isSafeInteger(credits) || credits < (kind === "focus" ? length : within))) return null;
  return { packKind: kind, focusMultiplier: multiplier, focusSpins: length, chaseWithin: within };
}
