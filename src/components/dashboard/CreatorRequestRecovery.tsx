"use client";

import { useEffect, useRef, useState } from "react";
import { creatorIntentReceipt } from "./creatorIntent";
import { releaseCreatorRequest, terminalCreatorRequest, type CreatorRequestKind, type TerminalCreatorRequestStatus } from "./creatorRequestOutcome";
import { useCreatorDraft } from "./CreatorDrafts";
import { requestCreatorReceipt, type CreatorReceiptRequest } from "./creatorRequestJournal";

const button = "min-h-10 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50";

/** A retry receipt can only be released by a matching terminal journal result. */
export default function CreatorRequestRecovery({ scope, kind, guardScope = scope, creatorId, refreshKey, disabled = false, request = requestCreatorReceipt, onFound, onResolved, onBusyChange }: {
  scope: string;
  kind: CreatorRequestKind;
  creatorId?: string;
  guardScope?: string;
  refreshKey?: boolean | number;
  disabled?: boolean;
  request?: CreatorReceiptRequest;
  onFound: () => void;
  onResolved: (status: TerminalCreatorRequestStatus) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const checkRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const found = useRef(onFound);
  useEffect(() => { found.current = onFound; }, [onFound]);
  useEffect(() => { if (confirmCancel) confirmRef.current?.focus(); }, [confirmCancel]);
  useEffect(() => { if (!requestId && message) statusRef.current?.focus(); }, [requestId, message]);
  useEffect(() => {
    try {
      const receipt = creatorIntentReceipt(scope);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize with the external browser receipt after mount or a completed request
      setRequestId(receipt?.id ?? null);
      if (receipt) found.current();
    } catch {
      setError("The saved retry receipt couldn't be read. No different request will be sent from this form. Restore browser session storage before trying again.");
    }
  }, [scope, refreshKey]);
  useCreatorDraft(guardScope, "a request outcome check", false, busy);

  async function reconcile(cancel: boolean) {
    if (!requestId || busy || disabled) return;
    setBusy(true); setError(""); setMessage("");
    onBusyChange?.(true);
    let confirmed = false;
    try {
      const response = await request({ requestId, kind, cancel, creatorId });
      if (!response.ok) throw new Error("outcome_unconfirmed");
      const status = releaseCreatorRequest(window.sessionStorage, scope, await response.json(), requestId, kind);
      if (!terminalCreatorRequest(status)) {
        setMessage("There is no final outcome yet. Keep the same request, check again, or cancel it before starting a different one.");
        return;
      }
      confirmed = true;
      setRequestId(null); setConfirmCancel(false);
      setMessage(status === "committed" ? "The original request completed. No duplicate grant was added." : status === "gone" ? "The original result was removed. That request cannot recreate it." : status === "cancelled" ? "Cancellation confirmed. This request cannot complete later; you can review the form and start a new request." : "The server confirmed this request did not complete and cannot complete later. You can correct the form.");
      await onResolved(status);
    } catch {
      setError(confirmed ? "The outcome was confirmed, but the refreshed view couldn't load. Refresh before starting another request." : "The outcome couldn't be confirmed. Keep this request and check again; it has not been safely released.");
    } finally {
      setBusy(false); onBusyChange?.(false);
      if (!confirmed) requestAnimationFrame(() => checkRef.current?.focus());
    }
  }

  if (!requestId && !error && !message) return null;
  return <div data-testid="creator-request-recovery" className="mt-3 space-y-2 rounded-xl border border-amber-300/30 p-3 text-xs text-ink">
    {requestId && <>
      <p className="font-semibold">An earlier request needs checking</p>
      <p className="text-muted">Check its saved outcome before editing this form or sending a different request. No fan details are stored in this browser receipt.</p>
      <div className="flex flex-wrap gap-2">
        <button ref={checkRef} type="button" data-testid="creator-request-check" disabled={busy || disabled} className={button} onClick={() => void reconcile(false)}>{busy ? "Checking outcome…" : "Check outcome"}</button>
        {!confirmCancel && <button ref={cancelRef} type="button" data-testid="creator-request-cancel" disabled={busy || disabled} className={button} onClick={() => setConfirmCancel(true)}>Cancel uncompleted request</button>}
      </div>
      {confirmCancel && <div role="group" aria-label="Confirm cancelling the uncompleted request" className="space-y-2 rounded-lg border border-line p-2">
        <p>Only an uncompleted request can be cancelled. A completed grant stays recorded. Wait for the server to confirm cancellation before changing this form.</p>
        <div className="flex flex-wrap gap-2"><button ref={confirmRef} type="button" data-testid="creator-request-cancel-confirm" disabled={busy || disabled} className={button} onClick={() => void reconcile(true)}>Confirm cancel request</button><button type="button" disabled={busy || disabled} className={button} onClick={() => { setConfirmCancel(false); requestAnimationFrame(() => cancelRef.current?.focus()); }}>Keep checking</button></div>
      </div>}
    </>}
    {error && <p role="alert" className="text-amber-200">{error}</p>}
    {message && <p ref={statusRef} tabIndex={-1} role="status" className="text-muted">{message}</p>}
  </div>;
}
