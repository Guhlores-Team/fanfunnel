// WC-09: "Create game" stores the game at once, so walking away from the editor
// used to leave an unplayable "New wheel" behind for good. When a creator
// leaves a game they just created and never gave a prize, the dashboard now
// says so and offers to remove it. Pure decision logic, unit-tested.

export interface EmptyGameRow {
  id: string;
  title: string;
  prizeCount: number;
  isActive: boolean;
  archivedAt: string | null;
}

/**
 * The just-created game to offer for removal, or null. `currentId` is the
 * game still open in the editor (null once the Games section is left). The
 * list must be fresh from the server: a game that gained prizes, went live,
 * was archived or is already gone is never offered.
 */
export function abandonedEmptyGame(freshId: string | null, currentId: string | null, games: readonly EmptyGameRow[]): EmptyGameRow | null {
  if (!freshId || freshId === currentId) return null;
  const game = games.find((g) => g.id === freshId);
  if (!game || game.prizeCount > 0 || game.isActive || game.archivedAt !== null) return null;
  return game;
}

export function emptyGameNotice(title: string): string {
  return `"${title}" has no prizes yet, so fans can't play it. It stays in your games as an empty draft.`;
}

/**
 * What to say when a game change (set live, schedule, archive, restore) is
 * refused. `set_active_wheel` (0073) answers ok | not_found | forbidden |
 * game_not_ready; the other changes share the codes.
 */
export function gameChangeRefusal(code: unknown, change: Record<string, unknown> = {}): string {
  const settingLive = change.isActive === true;
  switch (code) {
    case "game_not_ready":
      return "Finish and save this game before making it available to fans.";
    case "forbidden":
      return settingLive ? "This account can't change which game is live right now. Nothing changed." : "This account can't change this game right now. Nothing changed.";
    case "not_found":
      return settingLive ? "That game was deleted or archived, so it can't be made live. The list is up to date now." : "That game no longer exists. The list is up to date now.";
    case "game_busy":
      return "Fans are playing this game right now, so nothing changed. Try again in a moment.";
    case "game_in_use":
      return "This game still has active bingo progress. It cannot be removed or reset while those promises are owed.";
    case "has_history":
      return "This game has plays or fan links made for it, so it can't be deleted. Archive it instead: its history and every fan's link and balance are kept.";
    case "invalid_window":
      return "That schedule ends before it starts. Fix the dates and save again.";
    default:
      return "Couldn't update this game. Your settings are still here.";
  }
}
