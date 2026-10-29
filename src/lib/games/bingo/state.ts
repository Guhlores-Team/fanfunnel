/** Client-safe strict card schemas, with no database or cryptographic imports. */
import type { Rarity } from "../core/types";
import { RARITY_ORDER, MAX_WHEEL_PRIZES } from "../core/types";
import { completedLines, BINGO_FULL_MASK, type BingoCell, type BingoState } from "./engine";
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;

export function parseBingoCell(raw: unknown): BingoCell | null {
  if (!obj(raw) || !keys(raw, ["id", "label", "emoji", "rarity"]) || !id(raw.id) || typeof raw.label !== "string" || raw.label.length > 1000 ||
    (raw.emoji !== null && (typeof raw.emoji !== "string" || raw.emoji.length > 200)) || !RARITY_ORDER.includes(raw.rarity as Rarity)) return null;
  return { id: raw.id, label: raw.label, emoji: raw.emoji, rarity: raw.rarity as Rarity };
}
export function parseBingoCells(raw: unknown): BingoCell[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_WHEEL_PRIZES) return null;
  const parsed = raw.map(parseBingoCell);
  if (parsed.some((p) => p === null) || new Set(parsed.map((p) => p!.id)).size !== parsed.length) return null;
  return parsed as BingoCell[];
}
export function parseBingoState(raw: unknown): BingoState | null {
  if (!obj(raw) || !keys(raw, ["cells", "markedMask", "awardedLinesMask", "version"]) || !count(raw.markedMask) || raw.markedMask > BINGO_FULL_MASK ||
      !count(raw.awardedLinesMask) || raw.awardedLinesMask > 255 || !count(raw.version)) return null;
  const parsed = parseBingoCells(raw.cells);
  if (!parsed || parsed.length !== 9 || raw.awardedLinesMask !== completedLines(raw.markedMask)) return null;
  // Each committed play can mark at most one square. A fresh stored card is version0.
  const marks = raw.markedMask.toString(2).replaceAll("0", "").length;
  if (raw.version < marks || (raw.version === 0 && raw.markedMask !== 0)) return null;
  return { cells: parsed, markedMask: raw.markedMask, awardedLinesMask: raw.awardedLinesMask, version: raw.version };
}
