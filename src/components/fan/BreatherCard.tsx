"use client";

import { useId, useState } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import BreakPicker from "./BreakPicker";
import { breatherTitle } from "./yourPlay";

// Keep playing and Take a break carry exactly the same weight (RM-6 copy rule).
const equalBtn =
  "inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-line bg-surface/70 px-4 text-sm font-bold text-ink transition-colors hover:border-[var(--brand)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]";

/**
 * RM-6 reminder card: once today's spins reach the fan's own reminder, the next
 * SPIN tap opens this instead of spinning. Soft by design: one tap on Keep
 * playing continues (and spins); Take a break offers 24h / 7d / 30d. Shown
 * once per threshold per day. Escape closes it without spinning.
 */
export default function BreatherCard({
  token,
  today,
  onKeepPlaying,
  onBreakTaken,
  onClose,
}: {
  token: string;
  today: number;
  onKeepPlaying: () => void;
  onBreakTaken: (breakUntil: string) => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const titleId = useId();
  const dialogRef = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });
  // Switching steps unmounts the focused button: keep focus inside the card.
  const step = (next: boolean) => {
    setPicking(next);
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button")?.focus());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="breather-card"
        className="card lift-in w-full max-w-sm rounded-[1.5rem] p-6"
      >
        <h2 id={titleId} className="font-[family-name:var(--font-display)] text-lg font-extrabold text-ink text-balance">
          {breatherTitle(today)} <span aria-hidden="true">💖</span>
        </h2>
        <p className="mt-2 text-sm text-muted text-pretty">Your prizes are saved. Want a breather?</p>
        <div className="mt-5">
          {picking ? (
            <BreakPicker token={token} onTaken={onBreakTaken} onCancel={() => step(false)} />
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={onKeepPlaying} className={equalBtn}>
                Keep playing
              </button>
              <button type="button" onClick={() => step(true)} className={equalBtn}>
                Take a break
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
