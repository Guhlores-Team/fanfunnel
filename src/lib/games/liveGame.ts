// Which game a fan link plays right now, and why. Pure and client-safe: the
// server resolver (resolveActiveWheelId in src/lib/data/wheels.ts and the demo
// store) runs this same code, so what the dashboard explains is what fans get.
// SQL twin: _resolved_spin_wheel in supabase/migrations/0060_scratch_games.sql.
//
// Order: campaign's chosen game → a game whose schedule window is open → the
// game flagged active → the oldest game → the link's stored game. Only
// non-archived, finished (game_ready) wheel/scratch games can be played from a
// link; bingo never is.
import type { GameKind } from "./core/gameProof";

export interface LiveGameCandidate {
  id: string;
  gameKind?: GameKind;
  gameReady?: boolean;
  isActive: boolean;
  archivedAt: string | null;
  activeFrom: string | null;
  activeUntil: string | null;
  createdAt?: string;
}

/** Why a game is the creator's live game (no campaign involved). */
export type LiveReason =
  | { kind: "scheduled"; from: string | null; until: string | null }
  | { kind: "active" }
  | { kind: "oldest" };

/** Why a particular link plays the game it does. */
export type PlayReason = LiveReason | { kind: "pinned" } | { kind: "stored" };

/** A game a link can serve: not archived, saved and complete, not bingo. */
export function isPlayableGame(game: { archivedAt?: string | null; gameReady?: boolean; gameKind?: GameKind | string }): boolean {
  return !game.archivedAt && game.gameReady !== false && game.gameKind !== "bingo";
}

export function hasSchedule(game: Pick<LiveGameCandidate, "activeFrom" | "activeUntil">): boolean {
  return game.activeFrom != null || game.activeUntil != null;
}

export function scheduleOpen(game: Pick<LiveGameCandidate, "activeFrom" | "activeUntil">, now: Date): boolean {
  const nowMs = now.getTime();
  const fromOk = !game.activeFrom || new Date(game.activeFrom).getTime() <= nowMs;
  const untilOk = !game.activeUntil || new Date(game.activeUntil).getTime() > nowMs;
  return hasSchedule(game) && fromOk && untilOk;
}

/** The creator's live game for every link without a campaign game. */
export function pickLiveGame<T extends LiveGameCandidate>(games: readonly T[], now: Date): { game: T; reason: LiveReason } | null {
  const rows = games.filter(isPlayableGame);
  if (rows.length === 0) return null;

  const inWindow = rows.filter((game) => scheduleOpen(game, now));
  if (inWindow.length > 0) {
    const game = inWindow.slice().sort((a, b) => {
      // Latest start first (an open start sorts oldest), then newest created.
      const af = a.activeFrom ? new Date(a.activeFrom).getTime() : -Infinity;
      const bf = b.activeFrom ? new Date(b.activeFrom).getTime() : -Infinity;
      if (af !== bf) return bf - af;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id);
    })[0];
    return { game, reason: { kind: "scheduled", from: game.activeFrom, until: game.activeUntil } };
  }

  const active = rows.filter((game) => game.isActive).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (active) return { game: active, reason: { kind: "active" } };

  const oldest = rows
    .slice()
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id))[0];
  return { game: oldest, reason: { kind: "oldest" } };
}

export interface PlayingGame<T> {
  game: T;
  reason: PlayReason;
  /** The campaign named a game that cannot be played (archived, a draft or bingo). */
  ignoredPin?: T | "missing";
}

/**
 * The game one link plays now. `games` must be the owner's own games only
 * (the server never lets a campaign point at another creator's game).
 */
export function resolvePlayingGame<T extends LiveGameCandidate>(
  games: readonly T[],
  link: { pinnedWheelId?: string | null; storedWheelId?: string | null },
  now: Date,
): PlayingGame<T> | null {
  let ignoredPin: T | "missing" | undefined;
  if (link.pinnedWheelId) {
    const pinned = games.find((game) => game.id === link.pinnedWheelId);
    if (pinned && isPlayableGame(pinned)) return { game: pinned, reason: { kind: "pinned" } };
    ignoredPin = pinned ?? "missing";
  }
  const live = pickLiveGame(games, now);
  if (live) return { ...live, ...(ignoredPin ? { ignoredPin } : {}) };
  const stored = link.storedWheelId ? games.find((game) => game.id === link.storedWheelId) : undefined;
  if (stored && isPlayableGame(stored)) return { game: stored, reason: { kind: "stored" }, ...(ignoredPin ? { ignoredPin } : {}) };
  return null;
}

/**
 * What saving a schedule would do: the game it would replace for every link
 * without a campaign game, at the moment the window opens (now, if already
 * open). Null when the schedule takes nothing over.
 */
export function scheduleTakeover<T extends LiveGameCandidate>(
  games: readonly T[],
  targetId: string,
  next: { activeFrom: string | null; activeUntil: string | null },
  now: Date,
): { replaces: T; at: Date; startsNow: boolean } | null {
  const target = games.find((game) => game.id === targetId);
  if (!target || !isPlayableGame(target) || !hasSchedule(next)) return null;
  const fromMs = next.activeFrom ? new Date(next.activeFrom).getTime() : NaN;
  const startsNow = !Number.isFinite(fromMs) || fromMs <= now.getTime();
  const at = startsNow ? now : new Date(fromMs);
  if (!scheduleOpen(next, at)) return null;
  const without = games.map((game) => (game.id === targetId ? { ...game, activeFrom: null, activeUntil: null } : game));
  const withSchedule = games.map((game) => (game.id === targetId ? { ...game, ...next } : game));
  const before = pickLiveGame(without, at);
  const after = pickLiveGame(withSchedule, at);
  if (!before || !after || after.game.id !== targetId || before.game.id === targetId) return null;
  return { replaces: games.find((game) => game.id === before.game.id) as T, at, startsNow };
}

/** Short date + time for creator copy, e.g. "Oct 31, 9:00 PM". */
export function formatWhen(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "a date that couldn't be read";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Plain-language "because …" for a creator. */
export function playReasonText(reason: PlayReason, campaignName?: string): string {
  switch (reason.kind) {
    case "pinned":
      return campaignName ? `the campaign “${campaignName}” is set to play it` : "its campaign is set to play it";
    case "scheduled":
      return reason.until ? `it's scheduled until ${formatWhen(reason.until)}` : "it's scheduled with no end date";
    case "active":
      return "it's your active game";
    case "oldest":
      return "nothing is active or scheduled, so your oldest game is used";
    case "stored":
      return "it's the game this link was made for";
  }
}
