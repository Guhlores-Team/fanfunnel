"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { ageLabel, deletionErrorLabel, deletionStateLabel, nextRetryLabel, parseStuckDeletions, retryResultMessage, type StuckDeletionView } from "./deletionCopy";
import { btnGhost, raised, recessed, SectionTitle } from "./adminUi";

// A18: account deletions that paused, or stalled mid-way, used to be visible
// only as a one-off toast. They are listed here with their state, last error,
// attempts and age; the daily maintenance run retries paused ones with backoff
// and Retry resumes one now (POST /api/admin/account/storage-retry).
export default function StuckDeletions() {
  const id = useId();
  const [items, setItems] = useState<StuckDeletionView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/account/deletions", { cache: "no-store" });
      const parsed = parseStuckDeletions(await response.json());
      if (!response.ok || !parsed) throw new Error();
      setItems(parsed);
    } catch {
      setMessage("Stuck deletions could not be loaded. Sign in with two-factor authentication and try again.");
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void load();
  }, [load]);
  async function retry(target: string) {
    if (busy) return;
    setBusy(target);
    setMessage("");
    try {
      const response = await fetch("/api/admin/account/storage-retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(retryResultMessage(response.status, (body as { error?: string }).error));
      await load();
    } catch {
      setMessage("The retry could not be sent. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-labelledby={`${id}-title`} className={`${raised} overflow-hidden rounded-xl`}>
      <SectionTitle id={`${id}-title`}>Stuck account deletions</SectionTitle>
      <div className="space-y-3 p-4 text-sm text-ink sm:p-[18px]">
        {items === null && !message && <p>Loading…</p>}
        {items?.length === 0 && <p className="text-muted">No account deletion is paused or stalled.</p>}
        {items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((d) => (
              <li key={d.id} className={`${recessed} flex flex-wrap items-start justify-between gap-3 rounded-lg p-3`}>
                <dl className="grid gap-0.5 text-xs">
                  <div><dt className="inline font-semibold">Account: </dt><dd className="inline font-mono">{d.id}</dd></div>
                  <div><dt className="inline font-semibold">State: </dt><dd className="inline">{deletionStateLabel(d)}</dd></div>
                  <div><dt className="inline font-semibold">Last error: </dt><dd className="inline">{deletionErrorLabel(d.lastError)}</dd></div>
                  <div><dt className="inline font-semibold">Attempts: </dt><dd className="inline">{d.attempts}</dd></div>
                  <div><dt className="inline font-semibold">Started: </dt><dd className="inline">{ageLabel(d.startedAt)} ago</dd></div>
                  <div><dt className="inline font-semibold">Next: </dt><dd className="inline">{nextRetryLabel(d)}</dd></div>
                </dl>
                <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => void retry(d.id)} aria-label={`Retry deletion of account ${d.id}`}>
                  {busy === d.id ? "Retrying…" : "Retry"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => { setMessage(""); void load(); }}>Refresh</button>
        <p role="status" aria-live="polite">{message}</p>
      </div>
    </section>
  );
}
