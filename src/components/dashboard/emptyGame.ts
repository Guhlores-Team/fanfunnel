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
