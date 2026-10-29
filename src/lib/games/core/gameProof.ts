/** Explicit RM-7 versions. Historical wheel snapshot parsers stay untouched. */
import type { WheelConfig } from "./types";
import { MAX_WHEEL_PRIZES } from "./types";
import type { ModifierOptions } from "@/lib/focus/modifiers";
import { buildFocusPoolSnapshot, canonicalJson, parsePoolSnapshot, type PoolSnapshot } from "../wheel/fairnessV3";
import { sha256Hex } from "../wheel/fairness";
import { parseBingoCell as cell, parseBingoCells as cells, parseBingoState } from "../bingo/state";
export { parseBingoState } from "../bingo/state";
import { bingoEligible, isRareBonus, safeCell, BINGO_FULL_MASK, type BingoCell, type BingoState, type BonusPool, type BonusPrize } from "../bingo/engine";

export type GameKind = "wheel" | "scratch" | "bingo";
export interface ScratchConfig { style: "classic" }
export interface BingoConfig { size: 3; linePrizeId: string }
/** Creator-only inactive draft; never accepted by proof/build/play APIs. */
export interface BingoDraftSettings { size: 3; linePrizeId: null }
type GameBase = Omit<PoolSnapshot, "game">;
export type GamePoolSnapshot =
  | (GameBase & { game: "scratch"; gameRules: "scratch-v1"; gameConfig: ScratchConfig })
  | (GameBase & { game: "bingo"; gameRules: "bingo-v1"; gameConfig: BingoConfig; bingo: { catalog: BingoCell[]; before: BingoState | null; bonus: BonusPool } });

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const sorted = <T extends { id: string }>(values: T[]): T[] => values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);


export type GameSettings =
  | { gameKind: "wheel"; gameConfig: Record<string, never> }
  | { gameKind: "scratch"; gameConfig: ScratchConfig }
  | { gameKind: "bingo"; gameConfig: BingoConfig };
/** Exact untrusted editor/import settings; feature authorization is separate. */
export function parseGameSettings(kind: unknown, raw: unknown): GameSettings | null {
  if (!obj(raw)) return null;
  if (kind === "wheel" && keys(raw, [])) return { gameKind: kind, gameConfig: {} };
  if (kind === "scratch" && keys(raw, ["style"]) && raw.style === "classic") return { gameKind: kind, gameConfig: { style: "classic" } };
  if (kind === "bingo" && keys(raw, ["size", "linePrizeId"]) && raw.size === 3 && id(raw.linePrizeId)) return { gameKind: kind, gameConfig: { size: 3, linePrizeId: raw.linePrizeId } };
  return null;
}

function bonusPrize(raw: unknown, allowZero = false): BonusPrize | null {
  if (!obj(raw) || !keys(raw, ["id", "label", "emoji", "rarity", "w", "unlimited"]) || !count(raw.w) || (!allowZero && raw.w < 1) || typeof raw.unlimited !== "boolean") return null;
  const parsed = cell({ id: raw.id, label: raw.label, emoji: raw.emoji, rarity: raw.rarity });
  return parsed ? { ...parsed, w: raw.w, unlimited: raw.unlimited } : null;
}
function bonusPool(raw: unknown, linePrizeId: string): BonusPool | null {
  if (!obj(raw) || !keys(raw, ["selected", "fallback"]) || !Array.isArray(raw.fallback) || raw.fallback.length > MAX_WHEEL_PRIZES) return null;
  const selected = raw.selected === null ? null : bonusPrize(raw.selected, true);
  const fallback = raw.fallback.map((p) => bonusPrize(p));
  if ((raw.selected !== null && !selected) || (selected && selected.id !== linePrizeId) || fallback.some((p) => !p || !isRareBonus(p)) ||
      new Set(fallback.map((p) => p!.id)).size !== fallback.length || !fallback.some((p) => p?.unlimited) ||
      !Number.isSafeInteger(fallback.reduce((s, p) => s + (p?.w ?? 0), 0))) return null;
  const rows = fallback as BonusPrize[];
  const duplicate = selected && rows.find((p) => p.id === selected.id);
  if (duplicate && canonicalJson(duplicate) !== canonicalJson(selected)) return null;
  return { selected, fallback: sorted(rows) };
}

export type GameSnapshotParse = { ok: true; snapshot: GamePoolSnapshot } | { ok: false; reason: string };
export function parseGamePoolSnapshot(raw: unknown): GameSnapshotParse {
  const bad = (reason: string): GameSnapshotParse => ({ ok: false, reason });
  if (!obj(raw)) return bad("unreadable game snapshot");
  const scratch = raw.game === "scratch" && raw.gameRules === "scratch-v1";
  const bingo = raw.game === "bingo" && raw.gameRules === "bingo-v1";
  if ((!scratch && !bingo) || raw.rules !== "focus-v1" || !keys(raw, ["v", "rules", "game", "prizes", "modifiers", "gameRules", "gameConfig", ...(bingo ? ["bingo"] : [])])) return bad("unsupported game rules");
  const primary = parsePoolSnapshot({ v: raw.v, rules: raw.rules, game: "wheel", prizes: raw.prizes, modifiers: raw.modifiers });
  if (!primary.ok || primary.snapshot.prizes.length > MAX_WHEEL_PRIZES) return bad(primary.ok ? "too many prizes" : primary.reason);
  if (!Number.isSafeInteger(primary.snapshot.prizes.reduce((sum, p) => sum + p.w, 0)) ||
      !Number.isSafeInteger(primary.snapshot.prizes.reduce((sum, p) => sum + p.baseW!, 0))) return bad("unsafe ticket total");
  if (primary.snapshot.prizes.some((p) => !cell({ id: p.id, label: p.label, emoji: p.emoji, rarity: p.rarity }))) return bad("invalid public prize identity");
  const config = raw.gameConfig;
  if (!obj(config)) return bad("unreadable game config");
  if (scratch) {
    if (!keys(config, ["style"]) || config.style !== "classic") return bad("unsupported scratch config");
    return { ok: true, snapshot: { ...primary.snapshot, game: "scratch", gameRules: "scratch-v1", gameConfig: { style: "classic" } } };
  }
  if (!keys(config, ["size", "linePrizeId"]) || config.size !== 3 || !id(config.linePrizeId) || !obj(raw.bingo) || !keys(raw.bingo, ["catalog", "before", "bonus"])) return bad("unreadable bingo config");
  const catalog = cells(raw.bingo.catalog);
  const before = raw.bingo.before === null ? null : parseBingoState(raw.bingo.before);
  const bonus = bonusPool(raw.bingo.bonus, config.linePrizeId);
  if (!catalog || catalog.length < 9 || (raw.bingo.before !== null && !before) || !bonus) return bad("invalid card or bonus pool");
  const catalogIds = new Set(catalog.map((p) => p.id));
  if (before && before.markedMask !== BINGO_FULL_MASK && before.cells.some((p) => !catalogIds.has(p.id))) return bad("an active cell is no longer eligible");
  // Eligible catalog weights are positive ordinary tickets, not merely positive boosted odds.
  const primaryMap = new Map(primary.snapshot.prizes.map((p) => [p.id, p]));
  for (const c of catalog) {
    const p = primaryMap.get(c.id);
    if (!p || !p.baseW || canonicalJson(safeCell(p)) !== canonicalJson(c)) return bad("card catalog is not in the ordinary prize pool");
  }
  // Selected and fallback display/weights must match a current pool entry when present.
  // A paused reservation may include a finite target; authoritative delivery/stock still belongs to SQL.
  for (const p of [bonus.selected, ...bonus.fallback]) {
    if (!p) continue;
    const primaryPrize = primaryMap.get(p.id);
    if (!primaryPrize || primaryPrize.baseW !== p.w || canonicalJson(safeCell(primaryPrize)) !== canonicalJson(safeCell(p))) return bad("bonus catalog differs from base pool");
  }
  return { ok: true, snapshot: {
    ...primary.snapshot, game: "bingo", gameRules: "bingo-v1", gameConfig: { size: 3, linePrizeId: config.linePrizeId },
    bingo: { catalog: sorted(catalog), before, bonus },
  } };
}

export function primarySnapshot(snapshot: GamePoolSnapshot): PoolSnapshot {
  return { v: snapshot.v, rules: snapshot.rules, game: "wheel", prizes: snapshot.prizes, modifiers: snapshot.modifiers };
}
function checked(snapshot: GamePoolSnapshot): GamePoolSnapshot {
  const parsed = parseGamePoolSnapshot(snapshot);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.snapshot;
}
export function buildScratchPoolSnapshot(config: WheelConfig, options: ModifierOptions, gameConfig: ScratchConfig = { style: "classic" }): GamePoolSnapshot {
  return checked({ ...buildFocusPoolSnapshot(config, options), game: "scratch", gameRules: "scratch-v1", gameConfig });
}
export function buildBingoPoolSnapshot(config: WheelConfig, options: ModifierOptions, gameConfig: BingoConfig, before: BingoState | null): GamePoolSnapshot {
  if (!config.prizes.some((p) => p.id === gameConfig.linePrizeId)) throw new Error("Configured line prize does not exist");
  const pool = buildFocusPoolSnapshot(config, options);
  // A personal chase reservation may inject a stock0 primary target. It is
  // never ordinary/free inventory for a line bonus (nor another fan's pool).
  const available = new Set(config.prizes.filter((p) => p.delivery === "codes"
    ? typeof p.stock === "number" && p.stock > 0
    : p.stock === null || p.stock === undefined || p.stock > 0).map((p) => p.id));
  const toBonus = (p: PrizeLike): BonusPrize => ({ ...safeCell(p), w: p.weight, unlimited: p.delivery !== "codes" && (p.stock === null || p.stock === undefined) });
  const selected = config.prizes.find((p) => p.id === gameConfig.linePrizeId && available.has(p.id));
  const fallback = config.prizes.filter((p) => available.has(p.id) && p.weight > 0 && isRareBonus(p));
  return checked({ ...pool, game: "bingo", gameRules: "bingo-v1", gameConfig,
    bingo: { catalog: config.prizes.filter(bingoEligible).map(safeCell), before, bonus: { selected: selected ? toBonus(selected) : null, fallback: fallback.map(toBonus) } },
  });
}
type PrizeLike = WheelConfig["prizes"][number];
export async function hashGamePoolSnapshot(snapshot: GamePoolSnapshot): Promise<string> {
  return sha256Hex(canonicalJson(snapshot));
}
