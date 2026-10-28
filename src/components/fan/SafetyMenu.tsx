"use client";

import { useState } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useLinkPause } from "./LinkPauseProvider";
import { PAUSED_CONFIRMATION, pauseErrorMessage } from "./linkPause";
import { FAN_DELETED_CONFIRMATION, FanDeleteFlow, downloadFanData } from "./FanDataControls";

/**
 * A discreet safety menu on the fan page: report the creator (predatory /
 * rule-breaking), pause your own link (self-exclusion), download your data or
 * delete it. NOT a spend limit — a way out, a way to flag abuse, and the fan's
 * privacy rights.
 */
export default function SafetyMenu({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | "report" | "exclude" | "delete">(null);
  // After "Delete my data" the link is dead: closing the dialog reloads the
  // page, which then explains that the data was deleted.
  const [deleted, setDeleted] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { markPaused } = useLinkPause();
  // Inline failure on the pause confirm step so the fan can retry in place.
  const [pauseError, setPauseError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    if (deleted) window.location.reload();
  };
  const panelRef = useFocusTrap<HTMLDivElement>({
    active: open,
    onEscape: close,
  });

  const exportData = async () => {
    setBusy(true);
    setExportNote(null);
    const r = await downloadFanData(token);
    setBusy(false);
    if ("error" in r) setExportNote(r.error);
    else setDone("Your data is downloading. It's a JSON file you can open in any text editor.");
  };

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
    setPauseError(null);
    try {
      const res = await fetch("/api/self-exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setPauseError(pauseErrorMessage(typeof body.error === "string" ? body.error : undefined));
        return;
      }
      // Flip the page to its paused state now (SPIN off, balance chip and
      // button say so) instead of making the fan refresh to find out.
      markPaused();
      setDone(PAUSED_CONFIRMATION);
    } catch {
      setPauseError(pauseErrorMessage("network"));
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
          setPauseError(null);
          setExportNote(null);
        }}
        className="text-[11px] text-muted/60 underline-offset-4 transition hover:text-muted hover:underline"
      >
        Safety &amp; privacy
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
          onClick={close}
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
                <p role="status" className="text-sm text-ink">{done}</p>
                <button
                  onClick={close}
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
                  onClick={exportData}
                  disabled={busy}
                  className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand)] disabled:opacity-50"
                >
                  ⬇️ {busy ? "Preparing your data…" : "Download my data"}
                  <span className="mt-0.5 block text-xs text-muted">
                    A copy of everything stored about you here.
                  </span>
                </button>
                <button
                  onClick={() => setMode("delete")}
                  className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[#ef4444]"
                >
                  🗑️ Delete my data
                  <span className="mt-0.5 block text-xs text-muted">
                    Erase your profile, links, chat and wishlist for good.
                  </span>
                </button>
                {exportNote && (
                  <p role="alert" className="mt-2 text-center text-xs text-amber-300">
                    {exportNote}
                  </p>
                )}
                <button
                  onClick={close}
                  className="mt-4 w-full text-center text-xs text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </>
            ) : mode === "delete" ? (
              <FanDeleteFlow
                token={token}
                onBack={() => setMode(null)}
                onDeleted={() => {
                  setDeleted(true);
                  markPaused();
                  setDone(FAN_DELETED_CONFIRMATION);
                }}
              />
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
                {pauseError && (
                  <p role="alert" className="mt-2 text-center text-xs text-amber-300">
                    {pauseError}
                  </p>
                )}
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
