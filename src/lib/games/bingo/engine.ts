import type { Prize, Rarity } from "../core/types";
import { RARITY_ORDER } from "../core/types";
import { randomFloat, shuffled } from "../core/random";

export const BINGO_FULL_MASK = 511;
/** Rows, columns, then diagonals; this order also fixes bonus order. */
export const BINGO_LINE_MASKS = [7, 56, 448, 73, 146, 292, 273, 84] as const;
export interface BingoCell { id: string; label: string; emoji: string | null; rarity: Rarity }
export interface BingoState { cells: BingoCell[]; markedMask: number; awardedLinesMask: number; version: number }
export interface BonusPrize extends BingoCell { w: number; unlimited: boolean }
export interface BonusPool { selected: BonusPrize | null; fallback: BonusPrize[] }
export interface BonusTrace { line: number; excluded: string[]; won: string }
export interface BingoPresentation {
  kind: "bingo"; before: BingoState | null; after: BingoState;
  newCard: boolean; markedIndex: number | null; newLines: number[];
}

export function completedLines(markedMask: number): number {
  if (!Number.isSafeInteger(markedMask) || markedMask < 0 || markedMask > BINGO_FULL_MASK) throw new Error("Invalid bingo marks");
  return BINGO_LINE_MASKS.reduce((result, mask, index) => result | ((markedMask & mask) === mask ? 1 << index : 0), 0);
}

/** Codes always have finite inventory, regardless of their scalar stock field. */
export function bingoEligible(prize: Prize): boolean {
  return (prize.stock === null || prize.stock === undefined) && prize.delivery !== "codes" && Number.isSafeInteger(prize.weight) && prize.weight > 0;
}
export const safeCell = (p: Pick<Prize, "id" | "label" | "rarity"> & { emoji?: string | null }): BingoCell => ({
  id: p.id, label: p.label, emoji: p.emoji ?? null, rarity: p.rarity,
});

export function advanceBingo(catalog: readonly BingoCell[], before: BingoState | null, prizeId: string, rng: () => number): BingoPresentation {
  if (catalog.length < 9 || new Set(catalog.map((p) => p.id)).size !== catalog.length) throw new Error("Bingo requires nine distinct eligible prizes");
  const newCard = before === null || before.markedMask === BINGO_FULL_MASK;
  if (!newCard && !Number.isSafeInteger(before.version + 1)) throw new Error("Bingo version exhausted");
  const cells = (newCard ? shuffled(catalog, rng).slice(0, 9) : before.cells).map((p) => ({ ...p }));
  const markedIndex = cells.findIndex((p) => p.id === prizeId);
  const markedMask = (newCard ? 0 : before.markedMask) | (markedIndex >= 0 ? 1 << markedIndex : 0);
  const oldLines = newCard ? 0 : before.awardedLinesMask;
  const lines = completedLines(markedMask);
  const newLines = BINGO_LINE_MASKS.flatMap((_, index) => (lines & ~oldLines & (1 << index)) ? [index] : []);
  return {
    kind: "bingo", before: before ? { ...before, cells: before.cells.map((p) => ({ ...p })) } : null, newCard, markedIndex: markedIndex < 0 ? null : markedIndex, newLines,
    after: { cells, markedMask, awardedLinesMask: lines, version: newCard ? 1 : before.version + 1 },
  };
}

/** Selected bonus first; fallback uses base tickets, no primary modifiers. */
export function pickLineBonus(pool: BonusPool, excluded: ReadonlySet<string>, rng: () => number): BonusPrize {
  if (pool.selected && !excluded.has(pool.selected.id)) return pool.selected;
  const available = pool.fallback.filter((p) => !excluded.has(p.id));
  const total = available.reduce((sum, p) => sum + p.w, 0);
  if (!available.length || !Number.isSafeInteger(total) || total <= 0) throw new Error("No guaranteed bingo bonus fallback");
  let roll = randomFloat(rng) * total;
  for (const p of available) {
    roll -= p.w;
    if (roll < 0) return p;
  }
  return available[available.length - 1];
}

export function isRareBonus(prize: { rarity: Rarity }): boolean {
  return RARITY_ORDER.indexOf(prize.rarity) >= RARITY_ORDER.indexOf("rare");
}
