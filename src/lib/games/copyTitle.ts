import { hasOwn } from "@/lib/fan/uuid";
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

const NEW_GAME_TITLE = { wheel: "New wheel", scratch: "New scratch card", bingo: "New bingo card" } as const;
/** C15: a blank game is named for its kind, not "New wheel" for every game.
 *  WC-10: with `existing`, the name is unique among the creator's games
 *  ("New wheel", "New wheel 2", …) so pickers never list two identical entries. */
export function newGameTitle(kind: unknown, existing: Iterable<string> = []): string {
  const base = typeof kind === "string" && hasOwn(NEW_GAME_TITLE, kind) ? NEW_GAME_TITLE[kind as keyof typeof NEW_GAME_TITLE] : NEW_GAME_TITLE.wheel;
  const taken = new Set(Array.from(existing, (t) => t.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
