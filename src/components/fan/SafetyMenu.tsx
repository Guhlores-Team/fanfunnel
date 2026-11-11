"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useLinkPause } from "./LinkPauseProvider";
import { PAUSED_CONFIRMATION, PAUSE_WARNING, pauseErrorMessage } from "./linkPause";
import LegalLinks from "@/components/LegalLinks";
import { FAN_DELETED_CONFIRMATION, FanDataInline, FanDeleteFlow, downloadFanData, fanDataNeedsInline, fetchFanData, type FanDataFile } from "./FanDataControls";
import { REPORT_REASONS } from "@/lib/reports/config";
import { muteDoneMessage, muteErrorMessage, muteMenuExplanation, muteMenuLabel } from "@/lib/fan/chatMute";

/**
 * A discreet safety menu on the fan page: report the creator (predatory /
 * rule-breaking), mute the creator's messages and undo it (TS-17), pause your
 * own link (self-exclusion), download your data or delete it. NOT a spend
 * limit — a way out, a way to flag abuse, and the fan's privacy rights.
 */
export default function SafetyMenu({
  token,
  paused = false,
  creatorTitle = "this creator",
  chatMuted = false,
}: {
  token: string;
  paused?: boolean;
  /** The creator's public name, for the mute item. */
  creatorTitle?: string;
  /** TS-17: whether this fan has muted the creator's messages (from the page's read). */
  chatMuted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | "report" | "exclude" | "delete">(null);
  // After "Delete my data" the link is dead: closing the dialog reloads the
  // page, which then explains that the data was deleted.
  const [deleted, setDeleted] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  // FD-7: an export shown on the page where a download can't start.
  const [inlineData, setInlineData] = useState<FanDataFile | null>(null);
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  // RF-05: a failed report stays on the form (the typed detail is kept).
  const [reportError, setReportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { markPaused } = useLinkPause();
  // Inline failure on the pause confirm step so the fan can retry in place.
  const [pauseError, setPauseError] = useState<string | null>(null);
  // TS-17: the fan's mute choice, starting from the page's read.
  const [muted, setMuted] = useState(chatMuted);
  const [muteError, setMuteError] = useState<string | null>(null);
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

  // FD-7: in an app's browser a blob download silently does nothing, so the
  // data is shown instead of claiming a download that never starts.
  const exportOrShow = async () => {
    if (!fanDataNeedsInline()) return exportData();
    setBusy(true);
    setExportNote(null);
    const file = await fetchFanData(token);
    setBusy(false);
    if ("error" in file) setExportNote(file.error);
    else setInlineData(file);
  };

  const report = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    setReportError(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, reason, detail }),
      });
      if (res.ok) setDone("Thanks — your report was sent to FanFunnel.");
      else setReportError(res.status === 429 ? "Too many reports from your network right now. Try again in a minute." : "Couldn't send. Try again.");
    } catch {
      setReportError("Couldn't send — check your connection and try again.");
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

  const toggleMute = async () => {
    const next = !muted;
    setBusy(true);
    setMuteError(null);
    try {
      const res = await fetch("/api/fan/mute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, muted: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { muted?: unknown; message?: unknown };
      if (!res.ok) {
        setMuteError(muteErrorMessage(res.status, typeof body.message === "string" ? body.message : undefined));
        return;
      }
      const now = body.muted === true;
      setMuted(now);
      setDone(muteDoneMessage(creatorTitle, now));
    } catch {
      setMuteError(muteErrorMessage("network"));
    } finally {
      setBusy(false);
    }
  };

  // The sheet is rendered into the page's <main>: there it keeps the creator's
  // brand variables and paints above the game (the footer this button lives
  // in sits below the game's layer so the age gate can cover it).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<Element | null>(null);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => {
          setHost(triggerRef.current?.closest("main") ?? document.body);
          setOpen(true);
          setMode(null);
          setDone(null);
          setPauseError(null);
          setMuteError(null);
          setExportNote(null);
          setInlineData(null);
        }}
        className="inline-flex min-h-11 items-center px-2 text-xs text-muted underline-offset-4 transition hover:text-muted hover:underline"
      >
        Safety &amp; privacy
      </button>

      {open && host && createPortal(
        <div
          className="fixed inset-0 z-[65] flex overflow-y-auto overscroll-contain bg-black/70 p-4 text-left backdrop-blur-sm"
          onClick={close}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Safety and privacy"
            className="card mx-auto mt-auto w-full max-w-sm rounded-2xl p-6 [overflow-wrap:anywhere] sm:mb-auto"
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
            ) : inlineData ? (
              <FanDataInline file={inlineData} onBack={() => setInlineData(null)} />
            ) : mode === null ? (
              <>
                <p className="text-sm font-bold text-ink">Safety &amp; privacy</p>
                <button
                  onClick={() => setMode("report")}
                  className="mt-4 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand-ui)]"
                >
                  🚩 Report this creator
                  <span className="mt-0.5 block text-xs text-muted">
                    Predatory behaviour, scams, or breaking the rules.
                  </span>
                </button>
                {!paused && (
                  <button
                    onClick={toggleMute}
                    disabled={busy}
                    data-testid="mute-messages"
                    className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand-ui)] disabled:opacity-50"
                  >
                    {muted ? "🔔" : "🔕"} {muteMenuLabel(creatorTitle, muted)}
                    <span className="mt-0.5 block text-xs text-muted">
                      {muteMenuExplanation(creatorTitle, muted)}
                    </span>
                  </button>
                )}
                {muteError && (
                  <p role="alert" data-testid="mute-error" className="mt-2 text-center text-xs text-amber-300">
                    {muteError}
                  </p>
                )}
                {!paused && (
                  <button
                    onClick={() => setMode("exclude")}
                    className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand-ui)]"
                  >
                    ⏸️ Pause my link
                    <span className="mt-0.5 block text-xs text-muted">
                      Stop this link for good. This can&rsquo;t be undone.
                    </span>
                  </button>
                )}
                <button
                  onClick={exportOrShow}
                  disabled={busy}
                  className="mt-2 w-full rounded-xl border border-line px-4 py-3 text-left text-sm text-ink transition hover:border-[var(--brand-ui)] disabled:opacity-50"
                >
                  ⬇️ {busy ? "Preparing your data…" : "Download my data"}
                  <span className="mt-0.5 block text-xs text-muted">
                    A copy of your records with this creator. Private creator notes and won codes are not included.
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
                <LegalLinks className="mt-3" landmark={false} />
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
                  {REPORT_REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <textarea
                  aria-label="Additional details (optional)"
                  className="ff-input mt-2 w-full"
                  rows={3}
                  placeholder="Anything else we should know (optional)"
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                />
                {reportError && (
                  <p role="alert" data-testid="report-error" className="mt-3 text-center text-xs text-amber-300">
                    {reportError}
                  </p>
                )}
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
                  {PAUSE_WARNING}
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
        </div>,
        host,
      )}
    </>
  );
}
