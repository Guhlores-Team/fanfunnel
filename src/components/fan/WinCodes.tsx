"use client";

import type { WonPrize } from "@/lib/data/types";
import { LocalWinDate } from "./WinDeliveryList";

/**
 * WF-01 / PR-08: every win with a claim code, listed under "Your wins" with
 * its code and verify link, so an accidentally closed card loses nothing.
 * The code is the server's HMAC of the share id (never derived here).
 */
export default function WinCodes({ history }: { history: WonPrize[] }) {
  const rows = history.filter((w) => w.shareId && (w.claimCode || !w.instant));
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 w-full rounded-2xl border border-line bg-surface/40 px-3 text-sm" open data-testid="win-codes">
      <summary className="min-h-11 cursor-pointer py-3 font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ui)]">
        Claim codes and proof
      </summary>
      <ul className="space-y-2 pb-3">
        {rows.map((w, i) => (
          <li key={w.shareId ?? `${w.label}-${w.at}-${i}`} data-testid="win-code-row" data-share-id={w.shareId}
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 break-words text-ink">
              {w.label}
              <span className="block text-xs text-muted">Won <LocalWinDate iso={w.at} /></span>
            </span>
            <span className="flex shrink-0 items-center gap-3 text-xs">
              {w.claimCode && <span className="text-muted">Code <span className="font-mono font-semibold text-ink" data-testid="win-code">{w.claimCode}</span></span>}
              <a href={`/verify/${encodeURIComponent(w.shareId!)}`} className="inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4" data-testid="win-verify-link">
                Verify<span className="sr-only"> {w.label}</span>
              </a>
            </span>
          </li>
        ))}
      </ul>
      <p className="pb-3 text-xs text-muted">Show the code to your creator when you claim. The verify link proves the result was decided fairly.</p>
    </details>
  );
}
