"use client";

import { useEffect, useState } from "react";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { Rarity } from "@/lib/games/wheel/types";

interface Win {
  handle: string;
  prizeLabel: string;
  rarity: Rarity;
  at: string;
}

/**
 * A quiet, auto-scrolling strip of recent rare+ wins — honest social proof
 * ("@nova just won Signed Polaroid"). Handle-only, opt-in fans only. Pauses for
 * reduced-motion users (shows a static list instead). Renders nothing if empty.
 */
export default function RecentWinsTicker({
  creatorId,
  refreshKey = 0,
}: {
  creatorId: string;
  /** Bump to refetch immediately (e.g. right after the fan's own spin). */
  refreshKey?: number;
}) {
  const [wins, setWins] = useState<Win[]>([]);

  // Fetch on mount + refreshKey, then keep polling so other fans' wins appear
  // without a reload — the ticker is social proof, it should feel alive.
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/recent-wins/${creatorId}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (live && d?.wins) setWins(d.wins);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [creatorId, refreshKey]);

  if (wins.length === 0) return null;

  // Duplicate the list so the marquee loops seamlessly.
  const loop = wins.length >= 3 ? [...wins, ...wins] : wins;

  return (
    <div
      className="reveal w-full overflow-hidden rounded-full border border-line bg-surface/60 py-2"
      style={{ animationDelay: "0.1s" }}
      aria-label="Recent wins from other fans"
    >
      <div
        className="ticker-track flex w-max gap-6 px-4 motion-reduce:animate-none motion-reduce:flex-wrap motion-reduce:justify-center"
        // Speed scales with how many wins there are (~3.5s per item) so it reads
        // at a brisk but legible pace instead of crawling when the list is long.
        style={{ animationDuration: `${Math.max(14, wins.length * 3.5)}s` }}
      >
        {loop.map((w, i) => {
          const c = RARITY_COLORS[w.rarity];
          return (
            <span key={i} className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
              <span className="font-semibold text-ink">@{w.handle}</span>
              <span>won</span>
              <span className="font-medium" style={{ color: c }}>
                {w.prizeLabel}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
