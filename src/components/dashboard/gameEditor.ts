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
    return saved.id === wheel.id && creatorGameKind(saved) === kind;
  } catch { return false; }
}
export const creatorGameKind = (wheel: CreatorGameWheel): GameKind => wheel.gameKind ?? "wheel";
export const creatorGameSettings = (wheel: CreatorGameWheel) => parseGameSettings(creatorGameKind(wheel), wheel.gameConfig ?? {});
export function editableGamePayload(wheel: CreatorGameWheel): CreatorGameWheel {
  const value = { ...wheel };
  delete value.gameKindLocked;
  delete value.gameReady;
  return value;
}

export function gameDraftError(wheel: CreatorGameWheel): string | null {
  const settings = creatorGameSettings(wheel);
  if (!settings) return "Choose valid game settings before saving.";
  if (settings.gameKind !== "bingo") return null;
  const cells = wheel.prizes.filter(bingoEligible);
  if (new Set(cells.map((prize) => prize.id)).size < BINGO_CELL_COUNT) return `Bingo needs at least ${BINGO_CELL_COUNT} distinct unlimited prizes with positive tickets and manual, text or link delivery. Code lists cannot be card squares.`;
  if (!cells.some(isRareBonus)) return "Keep at least one unlimited rare, epic or legendary prize with positive tickets as the line-bonus fallback.";
  if (!wheel.prizes.some((prize) => prize.id === settings.gameConfig.linePrizeId)) return "Choose a saved line prize from this game. Its normal tickets may be zero.";
  return null;
}

const REFUSALS: Record<string, string> = {
  game_unavailable: "This game type is not available yet. Your current game and draft are kept.",
  game_not_ready: "Finish and save this game before making it available to fans.",
  feature_disabled: "This game type is no longer enabled for your account. Existing fan links keep working. Ask your admin to enable it before creating or changing to this type.",
  game_kind_locked: "This game already has credited plays. Keep its type to preserve those plays, or create a new game.",
  invalid_game_config: "These game settings are not valid. Review the type and line prize; your draft is still here.",
  bingo_needs_cells: "Bingo needs nine distinct unlimited, non-code prizes with positive tickets. Your draft is still here.",
  bingo_needs_fallback: "Bingo needs an unlimited rare-or-better fallback with positive tickets. Your draft is still here.",
  bingo_active_card: "An active bingo card still needs one of these prizes. Keep its prize, unlimited stock, non-code delivery and positive tickets so paid progress remains markable. Your draft is still here.",
  game_in_use: "This game still has active bingo progress. It cannot be removed or reset while those promises are owed.",
};
export const gameRefusalMessage = (code: unknown): string | null => typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : null;
