"use client";

import { useEffect, useState } from "react";

interface Entry {
  rank: number;
  handle: string;
  spins: number;
  spentCents: number;
  rareWins: number;
}
interface View {
  enabled: boolean;
  creatorTitle: string;
  entries: Entry[];
}

const MEDAL = ["🥇", "🥈", "🥉"];

/**
 * A compact, fan-facing leaderboard embedded right in the spin page — fans see
 * the competition without ever leaving (or touching any creator UI). Shows the
 * top few ranked by spins/rare wins. Self-fetches; renders nothing if off/empty.
 */
export default function FanLeaderboard({ creatorId }: { creatorId: string }) {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/leaderboard/${creatorId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setView(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [creatorId]);

  if (!view || !view.enabled || view.entries.length === 0) return null;
  const top = view.entries.slice(0, 5);

  return (
    <div className="w-full">
      <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        🏆 Top spinners
      </p>
      <ul className="space-y-1.5">
        {top.map((e) => (
          <li
            key={e.rank}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface/60 px-3 py-2"
          >
            <span className="w-6 shrink-0 text-center text-sm font-extrabold">
              {MEDAL[e.rank - 1] ?? e.rank}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {e.handle}
            </span>
            <span className="shrink-0 text-xs text-muted">
              {e.spins} spins
              {e.rareWins > 0 && <> · {e.rareWins}✨</>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-center text-[11px] text-muted/70">
        Keep spinning to climb the board.
      </p>
    </div>
  );
}
