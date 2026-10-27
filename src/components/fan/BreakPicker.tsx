"use client";

import { useId, useState } from "react";
import { BREAK_OPTIONS, type BreakOptionId } from "@/lib/play/config";

const choiceBtn =
  "inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-line bg-surface/70 px-3 text-sm font-semibold text-ink transition-colors hover:border-[var(--brand)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:opacity-50";

/** Fan-facing copy for a failed break request. Never the raw server code. */
export function breakErrorMessage(code: unknown): string {
  switch (code) {
    case "rate_limited":
      return "Too many tries. Wait a moment, then try again.";
    case "not_found":
    case "blocked":
      return "This link isn't active, so there's nothing to pause.";
    default:
      return "Couldn't start your break. Please try again.";
  }
}

/**
 * RM-6: pick a break length (24 hours / 7 days / 30 days), confirm, start it.
 * Shared by the "Your play" card and the reminder card. A break can't be
 * shortened once taken, so the confirm step says so plainly.
 */
export default function BreakPicker({
  token,
  onTaken,
  onCancel,
}: {
  token: string;
  onTaken: (breakUntil: string) => void;
  /** Shown as "Back" on the first step when given (the reminder card). */
  onCancel?: () => void;
}) {
  const [choice, setChoice] = useState<BreakOptionId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const picked = BREAK_OPTIONS.find((o) => o.id === choice) ?? null;

  const start = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fan/break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, duration: picked.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.breakUntil !== "string") {
        setError(breakErrorMessage(body.error));
        return;
      }
      onTaken(body.breakUntil);
    } catch {
      setError(breakErrorMessage("network"));
    } finally {
      setBusy(false);
    }
  };

  if (picked) {
    return (
      <div data-testid="break-confirm">
        <p className="text-sm font-bold text-ink">Take a break for {picked.label}?</p>
        <p className="mt-1 text-sm text-muted text-pretty">
          SPIN stays off until it ends, and it can&rsquo;t be ended early. Your spins and prizes are safe.
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={start} disabled={busy} className={choiceBtn}>
            {busy ? "Starting…" : "Start my break"}
          </button>
          <button
            type="button"
            onClick={() => {
              setChoice(null);
              setError(null);
            }}
            disabled={busy}
            className={choiceBtn}
          >
            Back
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-amber-300">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby={labelId}>
      <p id={labelId} className="text-sm font-bold text-ink">
        Take a break
      </p>
      <div className="mt-2 flex gap-2">
        {BREAK_OPTIONS.map((o) => (
          <button key={o.id} type="button" onClick={() => setChoice(o.id)} className={choiceBtn}>
            {o.label}
          </button>
        ))}
      </div>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 w-full text-center text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Back
        </button>
      )}
    </div>
  );
}
