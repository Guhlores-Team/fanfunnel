// Creator-facing answers to "which game do my fans get, and why?". Pure: it
// wraps the resolver the server runs (src/lib/games/liveGame.ts) so the
// Games, Campaigns and Fans screens all explain the same decision.
import type { WheelSummary } from "@/lib/data/types";
import type { GameKind } from "@/lib/games/core/gameProof";
import { MIN_WHEEL_PRIZES } from "@/lib/games/wheel/validate";
import { byAge, isPlayableGame, pickLiveGame, playReasonText, resolvePlayingGame, type LiveReason } from "@/lib/games/liveGame";

export type ChoiceGame = Pick<WheelSummary, "id" | "title" | "isActive" | "archivedAt" | "activeFrom" | "activeUntil" | "createdAt" | "gameKind" | "gameReady"> & { prizeCount?: number };
export type ChoiceCampaign = { id: string; name: string; pinnedWheelId?: string | null };

/** Short visible kind names (badges and option text). */
export const KIND_SHORT: Record<GameKind, string> = { wheel: "Wheel", scratch: "Scratch", bingo: "Bingo" };
export const kindOf = (game: { gameKind?: GameKind }): GameKind => game.gameKind ?? "wheel";

/** Why a campaign can't be set to play this game, or null when it can. */
export function pinUnavailableReason(game: ChoiceGame): string | null {
  if (game.archivedAt) return "archived";
  if (game.gameReady !== true) return "draft: finish and save it first";
  if (!isPlayableGame(game)) return "it can't be played";
  // The server would serve it, but every play is refused (no_prizes) until it has prizes.
  return game.prizeCount !== undefined && game.prizeCount < MIN_WHEEL_PRIZES ? `add at least ${MIN_WHEEL_PRIZES} prizes first` : null;
}

/** "Spin to Win · Wheel", plus why it can't be chosen when it can't. */
export function gameOptionLabel(game: ChoiceGame): string {
  const why = pinUnavailableReason(game);
  return `${game.title} · ${KIND_SHORT[kindOf(game)]}${why ? ` (${why})` : ""}`;
}

export interface LiveExplanation<T extends ChoiceGame = ChoiceGame> {
  game: T;
  reason: LiveReason;
  /** "because …" in plain words. */
  because: string;
  /** The game flagged active that a schedule is currently overriding. */
  overriddenActive: T | null;
}

/** What fans on a link without a campaign game get right now. */
export function liveExplanation<T extends ChoiceGame>(games: readonly T[], now: Date): LiveExplanation<T> | null {
  const live = pickLiveGame(games, now);
  if (!live) return null;
  const overriddenActive = live.reason.kind === "scheduled"
    ? games.filter((game) => game.isActive && game.id !== live.game.id && isPlayableGame(game)).sort(byAge)[0] ?? null
    : null;
  return { game: live.game, reason: live.reason, because: playReasonText(live.reason), overriddenActive };
}

export type CampaignGame<T extends ChoiceGame = ChoiceGame> =
  | { mode: "pinned"; game: T }
  | { mode: "follows"; live: T | null; because: string | null; ignored: { title: string | null; why: string } | null };

/** What a campaign's links play: its chosen game, or the live game. */
export function campaignGame<T extends ChoiceGame>(campaign: { pinnedWheelId?: string | null }, games: readonly T[], now: Date): CampaignGame<T> {
  const playing = resolvePlayingGame(games, { pinnedWheelId: campaign.pinnedWheelId ?? null }, now);
  if (playing?.reason.kind === "pinned") return { mode: "pinned", game: playing.game };
  return {
    mode: "follows",
    live: playing?.game ?? null,
    because: playing ? playReasonText(playing.reason) : null,
    ignored: ignoredPinText(playing?.ignoredPin ?? (campaign.pinnedWheelId ? "missing" : undefined)),
  };
}

export interface LinkGame<T extends ChoiceGame = ChoiceGame> {
  game: T;
  via: "link" | "campaign" | "live" | "stored";
  campaign: ChoiceCampaign | null;
  because: string;
  /** The campaign chose a game that can't be played, so the link falls through to the live game. */
  ignored: { title: string | null; why: string } | null;
  /** The link's own chosen game can't be played, so it falls through (0065). */
  ignoredLinkPin: { title: string | null; why: string } | null;
}

/** Why a chosen game is being skipped, in the words the campaign card uses. */
function ignoredPinText<T extends ChoiceGame>(ignoredPin: T | "missing" | undefined): { title: string | null; why: string } | null {
  if (ignoredPin === undefined) return null;
  if (ignoredPin === "missing") return { title: null, why: "it was deleted" };
  // Read in "is set to play X, but <why>, so …": a full clause, not the picker's short tag.
  const reason = pinUnavailableReason(ignoredPin);
  const why = reason === "archived" ? "it's archived" : ignoredPin.gameReady !== true ? "it's an unfinished draft" : "it can't be played";
  return { title: ignoredPin.title, why };
}

/**
 * The game one fan link plays now. `pass.wheelId` is only the last fallback
 * (and the top-up target); the link's own chosen game (0065), the campaign's
 * game and the live game come first, in that order.
 */
export function linkGame<T extends ChoiceGame>(pass: { wheelId: string; campaignId?: string | null; pinnedWheelId?: string | null }, campaigns: readonly ChoiceCampaign[], games: readonly T[], now: Date): LinkGame<T> | null {
  const campaign = pass.campaignId ? campaigns.find((c) => c.id === pass.campaignId) ?? null : null;
  const playing = resolvePlayingGame(games, { linkPinnedWheelId: pass.pinnedWheelId ?? null, pinnedWheelId: campaign?.pinnedWheelId ?? null, storedWheelId: pass.wheelId }, now);
  if (!playing) return null;
  const via = playing.reason.kind === "link_pinned" ? "link" : playing.reason.kind === "pinned" ? "campaign" : playing.reason.kind === "stored" ? "stored" : "live";
  return { game: playing.game, via, campaign, because: playReasonText(playing.reason, campaign?.name), ignored: ignoredPinText(playing.ignoredPin), ignoredLinkPin: ignoredPinText(playing.ignoredLinkPin) };
}

/** Campaigns set to play this game. */
export function campaignsUsing(gameId: string, campaigns: readonly ChoiceCampaign[]): ChoiceCampaign[] {
  return campaigns.filter((campaign) => campaign.pinnedWheelId === gameId);
}

/** Default game for a new campaign: whatever fans get right now. */
export function defaultCampaignGameId(games: readonly ChoiceGame[], now: Date): string {
  return pickLiveGame(games, now)?.game.id ?? "";
}

/** Why a link minted now plays its game, for the mint form's "This link will play" line. */
export function mintPlaysReason(plays: Pick<LinkGame, "via" | "campaign" | "ignored">): string {
  if (plays.via === "campaign" && plays.campaign) return `(the game chosen for “${plays.campaign.name}”)`;
  // The campaign chose a game that can't be played (archived, a draft or
  // deleted): say so, rather than claiming the campaign follows the live game.
  if (plays.campaign && plays.ignored) return `(your live game: “${plays.campaign.name}” is set to play ${plays.ignored.title ?? "a game"}, but ${plays.ignored.why})`;
  return `(your live game${plays.campaign ? `, because “${plays.campaign.name}” follows it` : ""})`;
}
