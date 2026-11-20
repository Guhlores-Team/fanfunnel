/** Fan display boundary for already-committed outcomes. Never draws or mutates a game. */
import type { PublicPrize } from "@/lib/games/wheel/types";
import type { GamePresentation } from "@/lib/games/core/play";
import { parseGamePresentation } from "@/lib/games/core/presentation";
import { parseDeliveredReward } from "./instantReward";
import type { BonusWinView } from "./BonusWins";

export type FanGameKind = "wheel" | "scratch" | "bingo";
export interface CommittedGameView { gameKind: FanGameKind; presentation: GamePresentation | null; bonusWins: BonusWinView[] }
export function readFanGameKind(value: unknown): FanGameKind | null {
  return value === undefined || value === "wheel" ? "wheel" : value === "scratch" || value === "bingo" ? value : null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const shareId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function bonusView(value: unknown): BonusWinView | null {
  if (!object(value) || !Number.isInteger(value.line) || (value.line as number) < 0 || (value.line as number) > 7 || !shareId(value.shareId) || !object(value.prize)) return null;
  const prize = value.prize;
  if (typeof prize.id !== "string" || !prize.id || typeof prize.label !== "string" || !prize.label || !["common","uncommon","rare","epic","legendary"].includes(prize.rarity as string)
    || !Number.isSafeInteger(prize.weight) || (prize.weight as number) < 0 || (value.instant !== undefined && typeof value.instant !== "boolean")
    || ["description", "emoji", "color"].some(key => prize[key] !== undefined && typeof prize[key] !== "string")
    || (prize.imageUrl !== undefined && prize.imageUrl !== null && typeof prize.imageUrl !== "string")
    || (value.awardedAt !== undefined && (typeof value.awardedAt !== "string" || !Number.isFinite(Date.parse(value.awardedAt))))) return null;
  const reward = value.reward === undefined ? null : parseDeliveredReward(value.reward);
  if (value.reward !== undefined && !reward) return null;
  return { line: value.line as number, shareId: value.shareId, prize: prize as unknown as PublicPrize,
    ...(value.instant === true ? { instant: true } : {}), ...(reward ? { reward } : {}), ...(typeof value.awardedAt === "string" ? { awardedAt: value.awardedAt } : {}) };
}
/** A malformed presentation keeps recovery pending; it must not be acknowledged as a new play. */
export function readCommittedGame(result: unknown, expectedKind: FanGameKind = "wheel"): CommittedGameView | null {
  if (!object(result) || !object(result.prize) || typeof result.prize.id !== "string" || !result.prize.id || typeof result.prize.label !== "string") return null;
  const raw = result;
  if (raw.gameKind === undefined && expectedKind !== "wheel") return null;
  const gameKind = readFanGameKind(raw.gameKind);
  if (!gameKind || gameKind !== expectedKind) return null;
  if (gameKind === "wheel") {
    if ((raw.presentation !== undefined && raw.presentation !== null) || (raw.bonusWins !== undefined && (!Array.isArray(raw.bonusWins) || raw.bonusWins.length))) return null;
    return { gameKind, presentation: null, bonusWins: [] };
  }
  const presentation = parseGamePresentation(raw.presentation, { kind: gameKind, prizeId: result.prize.id, label: result.prize.label });
  if (!presentation || !Array.isArray(raw.bonusWins)) return null;
  if (gameKind === "scratch") return raw.bonusWins.length === 0 ? { gameKind, presentation, bonusWins: [] } : null;
  if (presentation.kind !== "bingo" || raw.bonusWins.length !== presentation.newLines.length) return null;
  const bonuses = raw.bonusWins.map(bonusView);
  if (bonuses.some((bonus, index) => !bonus || bonus.line !== presentation.newLines[index] || bonus.shareId === raw.shareId) || new Set(bonuses.map(bonus => bonus!.shareId)).size !== bonuses.length) return null;
  return { gameKind, presentation, bonusWins: bonuses as BonusWinView[] };
}

import { parseBingoState } from "@/lib/games/bingo/state";
import type { BingoState } from "@/lib/games/bingo/engine";
/** Current card is token-scoped display state; a missing card is a legitimate first play. */
export function readCardSource(value: unknown): unknown {
  return object(value) ? value.bingoCard : undefined;
}
export function readGameCard(value: unknown): { card: BingoState | null; readable: boolean } {
  const raw = readCardSource(value);
  if (raw === undefined || raw === null) return { card: null, readable: true };
  const card = parseBingoState(raw);
  return { card, readable: card !== null };
}
/** A receipt patch belongs only to the exact server card source it replaced. */
export function currentGameCard(value: unknown, patch: { base: unknown; card: BingoState | null } | null): { card: BingoState | null; readable: boolean } {
  return patch && patch.base === readCardSource(value) ? { card: patch.card, readable: true } : readGameCard(value);
}
export function readPassGameKind(value: unknown): FanGameKind | null {
  return object(value) && object(value.wheel) ? readFanGameKind(value.wheel.gameKind) : null;
}
