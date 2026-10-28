"use client";

import { useEffect, useRef, useState } from "react";
import { RARITY_COLORS, RARITY_LABEL, RARITY_ORDER } from "@/lib/games/wheel/types";
import type { WonPrize } from "@/lib/data/types";
import type { DeliveredReward } from "@/lib/rewards/config";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { readableInk } from "@/lib/theme";
import InstantReward from "./InstantReward";
import InstantRewardHistory from "./InstantRewardHistory";
import { groupWonPrizes, parseDeliveredReward, rewardViewError, type InstantWinRef } from "./instantReward";

// Relative time for a win; older than a week falls back to an absolute date.
const ago = (iso: string, now: number) =>
  timeAgo(iso, { invalid: "", absoluteAfterDays: 7, now });

interface RewardView {
  label: string;
  win: InstantWinRef;
  loading: boolean;
  reward: DeliveredReward | null;
  error: string | null;
}

/**
 * The fan's wins as visual cards (grouped by prize) instead of flat pills. Each
 * card shows a rarity-tinted medallion, the rarity, how many times it's been won,
 * and how recently — turning a list into a collection worth showing off.
 */
export default function WinsGallery({ history, token, historyNonce = 0 }: { history: WonPrize[]; token?: string; historyNonce?: number }) {
  // Relative times depend on the clock (and the absolute fallback on the
  // viewer's locale), so they stay blank in the server HTML and fill in right
  // after hydration. Reading Date.now() during render caused React #418.
  const now = useNow(15_000);
  const [view, setView] = useState<RewardView | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const closeReward = () => {
    request.current?.abort();
    request.current = null;
    // Clear the decrypted value when the dialog closes; never cache it.
    setView(null);
  };

  const openReward = async (win: InstantWinRef, label: string) => {
    if (!token) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setView({ label, win, loading: true, reward: null, error: null });
    try {
      const response = await fetch("/api/fan/reward", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, shareId: win.shareId }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setView({ label, win, loading: false, reward: null, error: rewardViewError(response.status) });
        return;
      }
      const body: unknown = await response.json();
      if (controller.signal.aborted) return;
      const reward = parseDeliveredReward(body && typeof body === "object" ? (body as { reward?: unknown }).reward : null);
      setView({ label, win, loading: false, reward, error: reward ? null : rewardViewError(503) });
    } catch {
      if (!controller.signal.aborted) {
        setView({ label, win, loading: false, reward: null, error: rewardViewError(0) });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  };

  if (history.length === 0 && historyNonce === 0) return null;

  const groups = groupWonPrizes(history);

  const rareCount = history.filter(
    (w) => RARITY_ORDER.indexOf(w.rarity) >= RARITY_ORDER.indexOf("rare")
  ).length;

  return (
    <div className="w-full">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">Your wins</p>
        <p className="text-[11px] text-muted">
          {history.length} total{rareCount > 0 ? ` · ${rareCount} rare+` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {groups.map((g) => {
          const c = g.color ?? RARITY_COLORS[g.rarity];
          return (
            <div
              key={`${g.label}|${g.rarity}`}
              className="relative overflow-hidden rounded-2xl border p-3"
              style={{
                borderColor: `color-mix(in oklab, ${c} 45%, transparent)`,
                background: `linear-gradient(160deg, color-mix(in oklab, ${c} 14%, transparent), color-mix(in oklab, ${c} 4%, transparent))`,
              }}
            >
              {g.count > 1 && (
                <span
                  className="absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-extrabold"
                  style={{ backgroundColor: c, color: readableInk(c) }}
                >
                  ×{g.count}
                </span>
              )}
              <div
                className="grid h-12 w-12 place-items-center rounded-full text-2xl"
                style={{
                  background: `radial-gradient(circle at 50% 35%, color-mix(in oklab, ${c} 40%, transparent), color-mix(in oklab, ${c} 10%, transparent) 70%)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 45%, transparent)`,
                }}
              >
                {g.emoji ?? "🎁"}
              </div>
              <p className="mt-2 truncate text-sm font-bold text-ink" title={g.label}>
                {g.label}
              </p>
              <div className="mt-1 flex items-center justify-between gap-1">
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={{ color: c, backgroundColor: `color-mix(in oklab, ${c} 16%, transparent)` }}
                >
                  {RARITY_LABEL[g.rarity] ?? g.rarity}
                </span>
                <span className="shrink-0 text-[10px] text-muted">
                  {now === null ? "" : ago(g.latest, now)}
                </span>
              </div>
              {token && g.instantWins.length === 1 && (
                <button
                  type="button"
                  onClick={() => void openReward(g.instantWins[0], g.label)}
                  data-testid="view-reward"
                  className="mt-3 min-h-11 w-full rounded-xl border border-line bg-surface/60 px-2 py-2 text-xs font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                >
                  View reward<span className="sr-only"> for {g.label}</span>
                </button>
              )}
              {token && g.instantWins.length > 1 && (
                <details className="mt-3 text-xs">
                  <summary className="min-h-11 cursor-pointer rounded-xl py-3 font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]">
                    View rewards ({g.instantWins.length})<span className="sr-only"> for {g.label}</span>
                  </summary>
                  <ul className="space-y-2">
                    {g.instantWins.map((win, index) => (
                      <li key={win.shareId}>
                        <button
                          type="button"
                          onClick={() => void openReward(win, g.label)}
                          data-testid="view-reward"
                          className="min-h-11 w-full rounded-xl border border-line bg-surface/60 px-2 py-2 text-left font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                        >
                          View reward {index + 1}<span className="sr-only"> for {g.label}</span>
                          <span className="mt-0.5 block font-normal text-muted">{now === null ? "Saved win" : ago(win.at, now)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
      {token && <InstantRewardHistory key={historyNonce} token={token} autoOpen={historyNonce > 0} onView={(win, label) => void openReward(win, label)} />}
      {view && (
        <RewardDialog
          view={view}
          onClose={closeReward}
          onRetry={() => void openReward(view.win, view.label)}
        />
      )}
    </div>
  );
}

function RewardDialog({ view, onClose, onRetry }: { view: RewardView; onClose: () => void; onRetry: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose, initialFocus: closeRef });
  return (
    <div className="fixed inset-0 z-50 flex overflow-y-auto p-4" onClick={onClose}>
      <div className="fixed inset-0 bg-black/75 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Your reward for ${view.label}`}
        data-testid="saved-reward-dialog"
        className="card relative m-auto w-full min-w-0 max-w-lg rounded-3xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-lg font-extrabold text-ink">{view.label}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
          >
            Close
          </button>
        </div>
        {view.loading && <p className="mt-5 text-sm text-muted" role="status">Opening your reward…</p>}
        {view.reward && <InstantReward reward={view.reward} />}
        {view.error && (
          <div className="mt-5">
            <p className="text-sm text-muted" role="alert">{view.error}</p>
            <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]">Try again</button>
          </div>
        )}
        <p className="mt-4 text-xs text-muted">Each time you open a reward, your creator can see that it was viewed.</p>
      </div>
    </div>
  );
}
