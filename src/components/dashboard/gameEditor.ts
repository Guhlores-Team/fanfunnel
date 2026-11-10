import type { WheelConfig } from "@/lib/games/wheel/types";
import { parseGameSettings, type BingoDraftSettings, type GameKind, type GameSettings } from "@/lib/games/core/gameProof";
import { bingoEligible, isRareBonus } from "@/lib/games/bingo/engine";

/** Optional fields keep historical wheel records compatible. Server owns locks. */
export type CreatorGameWheel = WheelConfig & { gameKind?: GameKind; gameConfig?: GameSettings["gameConfig"] | BingoDraftSettings; gameKindLocked?: boolean; gameReady?: boolean };
export interface GameFeatures { wheel: true; scratch: boolean; bingo: boolean }
export const GAME_LABEL: Record<GameKind, string> = { wheel: "Wheel", scratch: "Scratch ticket", bingo: "Bingo" };
export const BINGO_CELL_COUNT = 9;

/** Presentation only; feature authorization is repeated in APIs and SQL. */
export function readGameFeatures(value: unknown): GameFeatures | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const features = (value as { features?: unknown }).features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return null;
  const raw = features as Record<string, unknown>;
  return { wheel: true, scratch: raw.scratch === true, bingo: raw.bingo === true };
}
export const canCreateGame = (kind: GameKind, features: GameFeatures | null) => kind === "wheel" || features?.[kind] === true;
/** Feature removal prevents new/conversion games while preserving safe edits. */
export function gameSaveFeatureAllowed(wheel: CreatorGameWheel, savedJson: string, features: GameFeatures | null): boolean {
  const kind = creatorGameKind(wheel);
  if (canCreateGame(kind, features)) return true;
  try {
    const saved = JSON.parse(savedJson) as CreatorGameWheel;
    return saved.id === wheel.id && creatorGameKind(saved) === kind && (kind !== "bingo" || saved.gameReady !== false);
  } catch { return false; }
}
export const creatorGameKind = (wheel: CreatorGameWheel): GameKind => wheel.gameKind ?? "wheel";
export const creatorGameSettings = (wheel: CreatorGameWheel) => parseGameSettings(creatorGameKind(wheel), wheel.gameConfig ?? {});
export function editableGamePayload(wheel: CreatorGameWheel): CreatorGameWheel {
  const value = { ...wheel };
  delete value.gameKindLocked;
  delete value.gameReady;
  // The version travels beside the game as `expectedUpdatedAt`, never in it.
  delete value.updatedAt;
  return value;
}

/** Distinct prizes that can be bingo card squares. */
export function bingoSquareCount(wheel: CreatorGameWheel): number {
  return new Set(wheel.prizes.filter(bingoEligible).map((prize) => prize.id)).size;
}

/**
 * Exactly what a bingo draft still lacks, in plain words (QA b5 m3: a new
 * draft only said "Choose valid game settings"). Empty when it can be saved.
 */
export function bingoMissing(wheel: CreatorGameWheel): string[] {
  const missing: string[] = [];
  const squares = bingoSquareCount(wheel);
  if (squares < BINGO_CELL_COUNT) {
    const more = BINGO_CELL_COUNT - squares;
    missing.push(`${more} more card-square prize${more === 1 ? "" : "s"} (Bingo needs ${BINGO_CELL_COUNT} distinct unlimited prizes with more than 0 tickets; a code list can't be a square)`);
  }
  if (!wheel.prizes.filter(bingoEligible).some(isRareBonus)) missing.push("an unlimited rare, epic or legendary prize with more than 0 tickets, used as the line-bonus fallback");
  const config = wheel.gameConfig as { linePrizeId?: unknown } | undefined;
  const linePrizeId = typeof config?.linePrizeId === "string" && config.linePrizeId ? config.linePrizeId : null;
  if (!linePrizeId) missing.push("a line prize: choose it under Line prize (its normal tickets may be zero)");
  else if (!wheel.prizes.some((prize) => prize.id === linePrizeId)) missing.push("a line prize from this game: Choose a saved line prize, the one chosen is no longer in this game");
  return missing;
}

/**
 * WC-11: the three things a bingo game needs before fans can play it, each
 * with a tick, so the rules read as a checklist instead of one long sentence.
 */
export function bingoChecklist(wheel: CreatorGameWheel): { key: "squares" | "fallback" | "linePrize"; label: string; done: boolean }[] {
  const squares = Math.min(bingoSquareCount(wheel), BINGO_CELL_COUNT);
  const config = wheel.gameConfig as { linePrizeId?: unknown } | undefined;
  const linePrizeId = typeof config?.linePrizeId === "string" && config.linePrizeId ? config.linePrizeId : null;
  return [
    { key: "squares", label: `${BINGO_CELL_COUNT} card-square prizes (${squares} of ${BINGO_CELL_COUNT})`, done: squares >= BINGO_CELL_COUNT },
    { key: "fallback", label: "A rare, epic or legendary prize with unlimited stock", done: wheel.prizes.filter(bingoEligible).some(isRareBonus) },
    { key: "linePrize", label: "A line prize", done: !!linePrizeId && wheel.prizes.some((prize) => prize.id === linePrizeId) },
  ];
}

/**
 * WC-11: a bingo game that was never published can be saved unfinished (an
 * inactive draft) when the only open items are the bingo checklist. The
 * base prize rules (two named prizes, tickets) still have to pass.
 */
export function canSaveBingoDraft(wheel: CreatorGameWheel, savedJson: string, baseIssues: readonly unknown[]): boolean {
  if (creatorGameKind(wheel) !== "bingo" || baseIssues.length > 0 || bingoMissing(wheel).length === 0) return false;
  try {
    const saved = JSON.parse(savedJson) as CreatorGameWheel;
    return saved.id === wheel.id && saved.gameReady === false;
  } catch { return false; }
}

function listText(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join("; ")}; and ${items.at(-1)}`;
}

export function gameDraftError(wheel: CreatorGameWheel): string | null {
  if (creatorGameKind(wheel) === "bingo") {
    const missing = bingoMissing(wheel);
    if (missing.length) return `Bingo still needs ${listText(missing)}.`;
  }
  const settings = creatorGameSettings(wheel);
  if (!settings) return "Choose valid game settings before saving.";
  return null;
}

/**
 * C15: the editor's "N things to fix" list, one entry per thing to do. Each
 * missing bingo piece is its own issue (the count matches the list shown),
 * and bingo's nine squares already cover the base "at least 2 prizes" rule,
 * so that one is not counted twice.
 */
export function gameDraftIssues<T extends { key: string; message: string }>(wheel: CreatorGameWheel, base: readonly T[]): { key: string; message: string }[] {
  if (creatorGameKind(wheel) === "bingo") {
    const missing = bingoMissing(wheel);
    if (missing.length) {
      const own = missing.map((item) => ({ key: "gameSettings", message: `Bingo still needs ${item}.` }));
      return [...own, ...base.filter((issue) => !(issue.key === "prizeCount" && missing.some((item) => /card-square/.test(item))))];
    }
  }
  const error = gameDraftError(wheel);
  return [...(error ? [{ key: "gameSettings", message: error }] : []), ...base];
}

const REFUSALS: Record<string, string> = {
  game_unavailable: "This game type is not available yet. Your current game and draft are kept.",
  game_not_ready: "Finish and save this game before making it available to fans.",
  feature_disabled: "This game type is no longer enabled for your account. Existing fan links keep working. Ask your admin to enable this type before publishing a draft, creating another game or changing type.",
  game_kind_locked: "This game already has credited plays. Keep its type to preserve those plays, or create a new game.",
  invalid_game_config: "These game settings are not valid. Review the type and line prize; your draft is still here.",
  bingo_needs_cells: "Bingo needs nine distinct unlimited, non-code prizes with positive tickets. Your draft is still here.",
  bingo_needs_fallback: "Bingo needs an unlimited rare-or-better fallback with positive tickets. Your draft is still here.",
  bingo_active_card: "An active bingo card still needs one of these prizes. Keep its prize, unlimited stock, non-code delivery and positive tickets so paid progress remains markable. Your draft is still here.",
  game_in_use: "This game still has active bingo progress. It cannot be removed or reset while those promises are owed.",
  stock_changed: "Stock changed while you were editing (fans kept playing). Reload this game to see the current stock, then save again. Your draft is still here.",
  game_busy: "Fans are playing this game right now, so nothing changed. Try again in a moment.",
  has_history: "This game has plays or fan links made for it, so it can't be deleted. Archive it instead: its history and every fan's link and balance are kept.",
};
export const gameRefusalMessage = (code: unknown): string | null => typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : null;
