import type { WonPrize } from "@/lib/data/types";
import { deliveryLabel, winDate, type WinDeliveryStatus } from "@/lib/fan/delivery";

const TONE: Record<WinDeliveryStatus, string> = {
  waiting: "border-line text-muted",
  in_progress: "border-line text-ink",
  delivered: "border-emerald-500/50 text-ink",
  cancelled: "border-amber-400/60 text-ink",
};

/**
 * T5: each won prize's delivery state (waiting / in progress / delivered /
 * cancelled), newest first. Only wins with a redemption row are listed; the
 * creator's notes and due dates are never shown. Dates are UTC calendar days,
 * so the server and the browser render the same text.
 */
export default function WinDeliveryList({ history, open = false }: { history: WonPrize[]; open?: boolean }) {
  const rows = history.filter((w) => w.delivery);
  if (rows.length === 0) return null;
  const waiting = rows.filter((w) => w.delivery!.status === "waiting" || w.delivery!.status === "in_progress").length;
  return (
    <details className="mt-3 w-full rounded-2xl border border-line bg-surface/40 px-3 text-sm" open={open} data-testid="win-delivery">
      <summary className="min-h-11 cursor-pointer py-3 font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]">
        Prize delivery{waiting > 0 ? ` · ${waiting} not delivered yet` : ""}
      </summary>
      <ul className="space-y-2 pb-3">
        {rows.map((w, i) => (
          <li key={w.shareId ?? `${w.label}-${w.at}-${i}`} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 break-words text-ink">
              {w.label}
              <span className="block text-xs text-muted">Won {winDate(w.at)}</span>
            </span>
            <span data-testid="win-delivery-status" data-status={w.delivery!.status} className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${TONE[w.delivery!.status]}`}>
              {deliveryLabel(w.delivery!)}
            </span>
          </li>
        ))}
      </ul>
      <p className="pb-3 text-xs text-muted">
        Prizes come from the creator. If one you were promised never arrives, use Safety &amp; privacy to report it.
      </p>
    </details>
  );
}
