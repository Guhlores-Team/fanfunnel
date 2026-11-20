"use client";

import { useId, useState } from "react";
import type { ThemeMedia } from "@/lib/creatorTheme/config";
import { PUBLIC_PHOTO_NOTE_MAX } from "@/lib/reports/config";

/**
 * A31: "Report a photo" under the public /c/<slug> gallery. No spin link is
 * needed; the report goes to FanFunnel's safety team (Admin › Reports), not
 * the creator, and nothing about the visitor is stored with it.
 */
export default function ReportPhoto({ slug, media }: { slug: string; media: ThemeMedia[] }) {
  const [open, setOpen] = useState(false);
  const [mediaId, setMediaId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const panelId = useId();
  const pickId = useId();
  const noteId = useId();
  if (media.length === 0) return null;

  async function send() {
    if (busy || !mediaId) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/report/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, mediaId, note: note.trim() || null }),
      });
      if (res.ok) {
        setResult({ ok: true, text: "Thanks. Your report was sent to FanFunnel's safety team." });
        setNote("");
        setMediaId("");
      } else if (res.status === 429) {
        setResult({ ok: false, text: "Too many reports from here just now. Wait a few minutes, then try again." });
      } else if (res.status === 404) {
        setResult({ ok: false, text: "That photo isn't on this page any more." });
      } else {
        setResult({ ok: false, text: "Couldn't send the report. Try again." });
      }
    } catch {
      setResult({ ok: false, text: "Couldn't send the report. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 text-left" data-testid="report-photo">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-10 items-center text-xs text-muted underline underline-offset-2 hover:text-ink"
      >
        Report a photo
      </button>
      {open && (
        <form
          id={panelId}
          aria-label="Report a photo"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="mt-2 rounded-2xl border border-line bg-surface/80 p-4"
        >
          <p className="text-xs text-muted text-pretty">
            Reports go to FanFunnel&rsquo;s safety team, not to the creator. We don&rsquo;t record who sent one.
          </p>
          <label htmlFor={pickId} className="mt-3 block text-xs font-semibold text-ink">
            Which photo?
          </label>
          <select id={pickId} className="ff-input mt-1 w-full" value={mediaId} onChange={(e) => setMediaId(e.target.value)} required>
            <option value="">Pick a photo…</option>
            {media.map((m, i) => (
              <option key={m.id} value={m.id}>
                {m.caption ? `Photo ${i + 1}: ${m.caption}` : `Photo ${i + 1}`}
              </option>
            ))}
          </select>
          <label htmlFor={noteId} className="mt-3 block text-xs font-semibold text-ink">
            What&rsquo;s wrong with it? (optional)
          </label>
          <textarea
            id={noteId}
            className="ff-input mt-1 w-full"
            rows={2}
            maxLength={PUBLIC_PHOTO_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {/* aria-disabled, not disabled: after a send clears the form the
              button keeps keyboard focus; an empty pick is caught by `required`. */}
          <button type="submit" aria-disabled={busy || !mediaId || undefined} className="btn-brand mt-3 w-full rounded-xl py-2.5 text-sm font-bold aria-disabled:opacity-50">
            {busy ? "Sending…" : "Send report"}
          </button>
          <p role="status" className={`mt-2 min-h-4 text-xs ${result?.ok === false ? "text-amber-200" : "text-muted"}`}>
            {result?.text ?? ""}
          </p>
        </form>
      )}
    </div>
  );
}
