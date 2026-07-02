"use client";

import { useState } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";

/**
 * A discreet safety menu on the fan page: report the creator (predatory /
 * rule-breaking) or pause your own link (self-exclusion). NOT a spend limit —
 * just a way out and a way to flag abuse.
 */
export default function SafetyMenu({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | "report" | "exclude">(null);
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useFocusTrap<HTMLDivElement>({
    active: open,
    onEscape: () => setOpen(false),
  });

  const report = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, reason, detail }),
      });
      setDone(res.ok ? "Thanks — your report was sent to FanFunnel." : "Couldn't send. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const exclude = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/self-exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setDone(res.ok ? "Your link is paused. Refresh to confirm." : "Couldn't pause. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          setMode(null);
          setDone(null);
        }}
        className="text-[11px] text-muted/60 underline-offset-4 transition hover:text-muted hover:underline"
      >
        Safety &amp; privacy
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
          onClick={() => setOpen(false)}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Safety and privacy"
            className="card w-full max-w-sm rounded-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {done ? (
              <div className="text-center">
                <p className="text-sm text-ink">{done}</p>
                <button
                  onClick={() => setOpen(false)}
                  className="btn-brand mt-5 w-full rounded-xl py-2.5 text-sm font-bold"
                >
                  Close
                </button>
              </div>
            ) : mode === null ? (
              <>
                <p className="text-sm font-bold text-ink">Safety &amp; privacy</p>
                <button
                  onClick={() => setMode("report")}
                  className="mt-4 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand)]"
                >
                  🚩 Report this creator
                  <span className="mt-0.5 block text-xs text-muted">
                    Predatory behaviour, scams, or breaking the rules.
                  </span>
                </button>
                <button
                  onClick={() => setMode("exclude")}
                  className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand)]"
                >
                  ⏸️ Pause my link
                  <span className="mt-0.5 block text-xs text-muted">
                    Stop this link from working for you.
                  </span>
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="mt-4 w-full text-center text-xs text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </>
            ) : mode === "report" ? (
              <>
                <p className="text-sm font-bold text-ink">Report this creator</p>
                <select
                  aria-label="Reason for report"
                  className="ff-input mt-3 w-full"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  <option value="">Pick a reason…</option>
                  <option>Predatory / pressuring behaviour</option>
                  <option>Not delivering won prizes</option>
                  <option>Harassment or abuse</option>
                  <option>Illegal content or activity</option>
                  <option>Other</option>
                </select>
                <textarea
                  aria-label="Additional details (optional)"
                  className="ff-input mt-2 w-full"
                  rows={3}
                  placeholder="Anything else we should know (optional)"
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                />
                <button
                  onClick={report}
                  disabled={busy || !reason}
                  className="btn-brand mt-4 w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
                >
                  {busy ? "Sending…" : "Send report"}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-ink">Pause my link?</p>
                <p className="mt-2 text-sm text-muted">
                  This stops your spin link from working. You&rsquo;ll need to ask the
                  creator for a new link to play again.
                </p>
                <button
                  onClick={exclude}
                  disabled={busy}
                  className="mt-4 w-full rounded-xl border border-[#ef4444] py-2.5 text-sm font-bold text-[#ef4444] transition hover:bg-[#ef4444]/10 disabled:opacity-50"
                >
                  {busy ? "Pausing…" : "Yes, pause my link"}
                </button>
                <button
                  onClick={() => setMode(null)}
                  className="mt-2 w-full text-center text-xs text-muted hover:text-ink"
                >
                  Back
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
