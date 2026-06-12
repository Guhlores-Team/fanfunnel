"use client";

import { useEffect, useState } from "react";
import { formatCents } from "@/lib/format";

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
// How many to show before the "Show all" expander kicks in.
const PREVIEW = 10;

export default function FanLeaderboard({
  creatorId,
  youHandle,
  refreshKey = 0,
}: {
  creatorId: string;
  youHandle?: string | null;
  /** Bump to refetch (e.g. after the fan spins) so their new rank shows live. */
  refreshKey?: number;
}) {
  const [view, setView] = useState<View | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/leaderboard/${creatorId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setView(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [creatorId, refreshKey]);

  if (!view || !view.enabled) return null;

  // Enabled but nobody on the board yet: invite instead of hiding — the fan
  // shouldn't have to spin first to discover the leaderboard exists.
  if (view.entries.length === 0) {
    return (
      <div className="w-full">
        <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
          🏆 Top spinners
        </p>
        <p className="rounded-xl border border-line bg-surface/60 px-3 py-5 text-center text-sm text-muted">
          The board is empty — spin to claim the #1 spot! 👑
        </p>
      </div>
    );
  }

  // Find the viewing fan's own row (by their board handle) to highlight + chase.
  const you = youHandle
    ? view.entries.find((e) => e.handle.toLowerCase() === youHandle.toLowerCase()) ?? null
    : null;
  const nextUp = you ? view.entries.find((e) => e.rank === you.rank - 1) ?? null : null;
  const gap = nextUp ? Math.max(1, nextUp.spins - you!.spins) : 0;

  // Always include the fan's own row even if it's past the preview cutoff.
  let shown = expanded ? view.entries : view.entries.slice(0, PREVIEW);
  if (you && !shown.some((e) => e.rank === you.rank)) shown = [...shown, you];
  const hasMore = view.entries.length > PREVIEW;

  return (
    <div className="w-full">
      <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        🏆 Top spinners
      </p>
      {you && (
        <p className="mb-3 text-center text-sm font-semibold text-ink">
          You&rsquo;re <span className="text-[var(--brand)]">#{you.rank}</span>
          {nextUp ? (
            <span className="font-normal text-muted">
              {" "}
              · {gap} more {gap === 1 ? "spin" : "spins"} to catch{" "}
              {nextUp.handle} at #{nextUp.rank}
            </span>
          ) : (
            <span className="font-normal text-muted"> · you&rsquo;re in the lead 👑</span>
          )}
        </p>
      )}
      <ul className="space-y-1.5">
        {shown.map((e) => (
          <li
            key={e.rank}
            className="flex items-center gap-3 rounded-xl border bg-surface/60 px-3 py-2"
            style={
              you && e.rank === you.rank
                ? {
                    borderColor: "var(--brand)",
                    background: "color-mix(in oklab, var(--brand) 16%, transparent)",
                  }
                : e.rank <= 3
                  ? {
                      borderColor: "color-mix(in oklab, var(--brand) 45%, transparent)",
                      background: "color-mix(in oklab, var(--brand) 8%, transparent)",
                    }
                  : { borderColor: "var(--color-line)" }
            }
          >
            <span className="w-6 shrink-0 text-center text-sm font-extrabold">
              {MEDAL[e.rank - 1] ?? e.rank}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
              {e.handle}
              {you && e.rank === you.rank && (
                <span className="ml-1.5 rounded-full bg-[var(--brand)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                  You
                </span>
              )}
            </span>
            <span className="shrink-0 text-right text-xs text-muted">
              {e.spins} spins
              {e.rareWins > 0 && (
                <span title={`${e.rareWins} rare-or-better ${e.rareWins === 1 ? "win" : "wins"}`}>
                  {" "}· {e.rareWins}✨
                </span>
              )}
              {e.spentCents > 0 && (
                <span className="block text-[10px] text-muted/70">
                  {formatCents(e.spentCents)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 w-full rounded-xl border border-line py-2 text-xs font-semibold text-muted transition hover:text-ink"
        >
          {expanded
            ? "Show less"
            : `Show all ${view.entries.length} spinners`}
        </button>
      )}
      <p className="mt-2 text-center text-[11px] text-muted/70">
        Keep spinning to climb the board.
      </p>
    </div>
  );
}
