"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";
import { parseRewardHistoryPage, rewardViewError, type InstantRewardHistoryWin, type InstantWinRef } from "./instantReward";

/** Explicit, paginated access to rewards older than the recent-wins gallery. */
export default function InstantRewardHistory({ token, onView, autoOpen = false }: {
  token: string;
  onView: (win: InstantWinRef, label: string) => void;
  autoOpen?: boolean;
}) {
  const panelId = useId();
  const now = useNow(15_000);
  const [open, setOpen] = useState(autoOpen);
  const [loaded, setLoaded] = useState(false);
  const [wins, setWins] = useState<InstantRewardHistoryWin[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(autoOpen);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const attemptedCursor = useRef<string | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const loadPage = useCallback(async (cursor: string | null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    attemptedCursor.current = cursor;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/fan/reward/history", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(cursor ? { cursor } : {}) }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(rewardViewError(response.status));
        return;
      }
      const raw: unknown = await response.json();
      if (controller.signal.aborted) return;
      const page = parseRewardHistoryPage(raw);
      if (!page) {
        setError("We couldn't load your rewards. Please try again.");
        return;
      }
      setWins((previous) => {
        // A new win between page requests must not duplicate an existing row.
        const unique = new Map((cursor ? previous : []).map((win) => [win.shareId, win]));
        for (const win of page.wins) unique.set(win.shareId, win);
        return [...unique.values()];
      });
      setNextCursor(page.nextCursor);
      setLoaded(true);
    } catch {
      if (!controller.signal.aborted) setError("We couldn't load your rewards. Check your connection and try again.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (!autoOpen) return;
    const timer = setTimeout(() => void loadPage(null), 0);
    return () => clearTimeout(timer);
  }, [autoOpen, loadPage]);

  const toggle = () => {
    if (open) {
      request.current?.abort();
      request.current = null;
      setLoading(false);
      setOpen(false);
    } else {
      setOpen(true);
      if (!loaded) void loadPage(null);
    }
  };

  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface/50" data-testid="instant-reward-history">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        data-testid="reward-history-toggle"
      >
        All instant rewards <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-line p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 basis-40 text-xs text-muted">Browse all the instant rewards you&apos;ve won, including earlier wins.</p>
            <button type="button" onClick={() => void loadPage(null)} disabled={loading} data-testid="reward-history-refresh" className="min-h-11 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:opacity-60">Refresh rewards</button>
          </div>
          {wins.length > 0 && (
            <ul className="space-y-2">
              {wins.map((win) => (
                <li key={win.shareId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3" data-testid="reward-history-win">
                  <div className="min-w-0 flex-1 basis-32">
                    <p className="break-words text-sm font-semibold text-ink">{win.label}</p>
                    <p className="mt-0.5 text-xs text-muted">{now === null ? "Saved win" : timeAgo(win.at, { invalid: "Saved win", absoluteAfterDays: 7, now })}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onView(win, win.label)}
                    className="min-h-11 rounded-xl border border-line px-3 py-2 text-xs font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                    data-testid="reward-history-view"
                  >
                    View reward<span className="sr-only"> for {win.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {loading && <p className="mt-3 text-sm text-muted" role="status">Loading your rewards…</p>}
          {!loading && !error && loaded && wins.length === 0 && <p className="text-sm text-muted" role="status">You haven&apos;t won an instant reward yet.</p>}
          {error && (
            <div className="mt-3">
              <p className="text-sm text-muted" role="alert">{error}</p>
              <button type="button" onClick={() => void loadPage(attemptedCursor.current)} className="mt-2 min-h-11 rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]">Try again</button>
            </div>
          )}
          {!loading && !error && nextCursor && (
            <button type="button" onClick={() => void loadPage(nextCursor)} data-testid="reward-history-more" className="mt-3 min-h-11 w-full rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]">
              Load older rewards
            </button>
          )}
        </div>
      )}
    </section>
  );
}
