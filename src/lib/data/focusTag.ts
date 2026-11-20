import type { RedemptionItem } from "./types";
/** Read only the public modifier proof, never a reservation or an encrypted receipt. */
export function focusTag(snapshot: unknown, trace?: unknown): Pick<RedemptionItem, "focusKind" | "chaseAwarded"> {
  if (!snapshot || typeof snapshot !== "object") return {};
  const modifiers = (snapshot as { modifiers?: unknown }).modifiers;
  if (!modifiers || typeof modifiers !== "object") return {};
  const { focus, chase } = modifiers as { focus?: { applied?: unknown; prizeId?: unknown }; chase?: { eligible?: unknown; counter?: unknown; within?: unknown } };
  if (focus?.applied === true) {
    const excluded = trace && typeof trace === "object" && Array.isArray((trace as { excluded?: unknown }).excluded) ? (trace as { excluded: unknown[] }).excluded : [];
    const prizes = (snapshot as { prizes?: unknown }).prizes;
    const remaining = Array.isArray(prizes) ? prizes.filter(p => p && typeof p === "object" && !excluded.includes(p.id) && p.baseW > 0) : [];
    if (!excluded.includes(focus.prizeId) && remaining.length > 1) return { focusKind: "focus" };
  }
  if (chase?.eligible === true) return { focusKind: "chase", chaseAwarded: typeof chase.counter === "number" && typeof chase.within === "number" && chase.counter + 1 >= chase.within };
  return {};
}
