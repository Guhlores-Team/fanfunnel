// A duplicated game gets a title no other game of the creator has, so the
// game pickers (Games, Campaigns, the fan drawer, happy hours) never show two
// identical entries: "Spin to Win" → "Spin to Win (copy)" → "(copy 2)" …
// Pure; the demo store and the database path both use it.

const COPY_SUFFIX = / \(copy(?: (\d+))?\)$/;
export const MAX_GAME_TITLE = 120;

export function copyTitle(title: string, existing: Iterable<string>): string {
  const taken = new Set(Array.from(existing, (t) => t.trim().toLowerCase()));
  const base = title.trim().replace(COPY_SUFFIX, "") || "Game";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = base.slice(0, MAX_GAME_TITLE - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
