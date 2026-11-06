import type { WonPrize } from "@/lib/data/types";

/** Server refreshes can include a win already presented locally; retain one historical event. */
export function mergeFanWins(server: readonly WonPrize[], local: readonly WonPrize[]): WonPrize[] {
  const key = (win: WonPrize) => win.shareId ?? JSON.stringify([win.at, win.label, win.rarity]);
  const byWin = new Map(local.map(win => [key(win), win]));
  for (const win of server) byWin.set(key(win), win);
  return [...byWin.values()].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, 50);
}
