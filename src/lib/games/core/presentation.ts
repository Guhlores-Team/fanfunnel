import { visibleIdentity as visible } from "./visibleIdentity";
/** Validate committed network presentation before acknowledging a paid request.
 * This module is client-safe: no crypto, data, routes, auth or randomness. */
import type { GamePresentation } from "./play";
import { SCRATCH_DECORATIONS, type ScratchCell } from "../scratch/engine";
import { BINGO_FULL_MASK, BINGO_LINE_MASKS, completedLines } from "../bingo/engine";
import { parseBingoState } from "../bingo/state";

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (o: Record<string, unknown>, expected: string[]) => Object.keys(o).length === expected.length && expected.every((k) => Object.hasOwn(o, k));
export interface ExpectedGamePresentation { kind: "scratch" | "bingo"; prizeId: string; label?: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function parseGamePresentation(raw: unknown, expected?: ExpectedGamePresentation): GamePresentation | null {
  if (!obj(raw) || (expected && raw.kind !== expected.kind)) return null;
  if (raw.kind === "scratch") {
    if (!keys(raw, ["kind", "cells"]) || !Array.isArray(raw.cells) || raw.cells.length !== 9) return null;
    const cells: ScratchCell[] = [];
    for (const c of raw.cells) {
      if (!obj(c) || !keys(c, ["kind", "id", "label", "emoji"]) || !["prize", "decoration"].includes(c.kind as string) ||
          typeof c.id !== "string" || !c.id || c.id.length > 256 || typeof c.label !== "string" || c.label.length > 1000 ||
          (c.emoji !== null && (typeof c.emoji !== "string" || c.emoji.length > 200))) return null;
      if (c.kind === "decoration" && !SCRATCH_DECORATIONS.some(([id, label, emoji]) => c.id === `scratch-v1:${id}` && c.label === `Decorative ${visible(label)}` && c.emoji === emoji)) return null;
      cells.push({ kind: c.kind as ScratchCell["kind"], id: c.id, label: c.label, emoji: c.emoji });
    }
    const byId = new Map<string, ScratchCell[]>();
    for (const c of cells) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
    const winners = [...byId.values()].filter((group) => group.length === 3);
    if (winners.length !== 1 || byId.size !== 7 || [...byId.values()].some((group) => group.length !== 1 && group.length !== 3)) return null;
    const winner = winners[0][0];
    if (winner.kind !== "prize" || winners[0].some((c) => !same(c, winner)) ||
        (expected && (winner.id !== expected.prizeId || (expected.label !== undefined && winner.label !== expected.label)))) return null;
    const labels = new Set([visible(winner.label)]);
    const symbols = new Set([visible(winner.emoji ?? "◇")]);
    for (const c of cells.filter((c) => c.id !== winner.id)) {
      if (!c.emoji || !visible(c.emoji) || labels.has(visible(c.label)) || symbols.has(visible(c.emoji))) return null;
      labels.add(visible(c.label)); symbols.add(visible(c.emoji));
    }
    return { kind: "scratch", cells };
  }
  if (raw.kind !== "bingo" || !keys(raw, ["kind", "before", "after", "newCard", "markedIndex", "newLines"]) ||
      typeof raw.newCard !== "boolean" || (raw.markedIndex !== null && (!Number.isInteger(raw.markedIndex) || (raw.markedIndex as number) < 0 || (raw.markedIndex as number) > 8)) ||
      !Array.isArray(raw.newLines) || raw.newLines.length > 4 || !raw.newLines.every((line) => Number.isInteger(line) && line >= 0 && line < 8)) return null;
  const before = raw.before === null ? null : parseBingoState(raw.before);
  const after = parseBingoState(raw.after);
  if ((raw.before !== null && !before) || !after) return null;
  const newCard = before === null || before.markedMask === BINGO_FULL_MASK;
  if (raw.newCard !== newCard || after.version !== (newCard ? 1 : before.version + 1) || (!newCard && !same(after.cells, before.cells))) return null;
  const markedIndex = raw.markedIndex as number | null;
  if (expected) {
    const actualIndex = after.cells.findIndex((p) => p.id === expected.prizeId);
    if (markedIndex !== (actualIndex < 0 ? null : actualIndex)) return null;
  }
  const oldMask = newCard ? 0 : before.markedMask;
  if (after.markedMask !== (oldMask | (markedIndex === null ? 0 : 1 << markedIndex))) return null;
  const newLines = BINGO_LINE_MASKS.flatMap((_, index) => (completedLines(after.markedMask) & ~(newCard ? 0 : before.awardedLinesMask) & (1 << index)) ? [index] : []);
  if (!same(newLines, raw.newLines)) return null;
  return { kind: "bingo", before, after, newCard, markedIndex, newLines };
}
