"use client";

import { useId, useRef, useState } from "react";

/** Optional account-row moderation control; authorization remains in the route. */
export default function RemoveCreatorPhotosButton({ accountId, displayName, disabled = false, onRemoved }: {
  accountId: string;
  displayName: string;
  disabled?: boolean;
  onRemoved?: (count: number) => void;
}) {
  const id = useId();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  async function remove() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/account/media", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: accountId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error("auth");
        throw new Error("failed");
      }
      if (!body || body.ok !== true || typeof body.removed !== "number") throw new Error("failed");
      setConfirm(false);
      setNotice(body.removed > 0 ? `${body.removed} photo${body.removed === 1 ? "" : "s"} removed.` : "This creator has no photos to remove.");
      onRemoved?.(body.removed);
    } catch (e) {
      setError(e instanceof Error && e.message === "auth"
        ? "Sign in as an admin and complete two-factor login before removing photos."
        : "Couldn’t remove the photos. Please retry; no success has been confirmed.");
    } finally { pending.current = false; setBusy(false); }
  }
  return (
    <div className="min-w-0 space-y-2" data-testid="admin-remove-photos">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled || busy} aria-describedby={confirm ? `${id}-confirm` : undefined} onClick={() => confirm ? void remove() : setConfirm(true)} className="min-h-11 rounded-lg border border-red-400/40 px-3 text-xs font-semibold text-red-300 hover:bg-red-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:opacity-50">
          {busy ? "Removing photos…" : confirm ? "Confirm remove all photos" : "Remove photos"}
        </button>
        {confirm && !busy && <button type="button" onClick={() => { setConfirm(false); setError(""); }} className="min-h-11 rounded-lg border border-line px-3 text-xs font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]">Cancel</button>}
      </div>
      {confirm && <p id={`${id}-confirm`} className="text-xs leading-relaxed text-muted">Remove every public gallery photo from {displayName || "this creator"}? Their photo background will return to Glow. This cannot be undone.</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <p role="status" className="text-xs text-muted">{notice}</p>
    </div>
  );
}
