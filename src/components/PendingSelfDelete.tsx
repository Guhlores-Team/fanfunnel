"use client";

import { useId, useState } from "react";
import { CLOSE_ACCOUNT_PHRASE } from "@/lib/privacy/config";
import { closeAccountErrorMessage } from "@/lib/privacy/messages";
import { ACCOUNT_CLEANUP_PENDING_MESSAGE, deletionResponseState } from "@/lib/privacy/deletionResult";

/**
 * T7: on /pending, an applicant whose request is waiting or was declined can
 * delete the request and the account behind it. It is the same server path as
 * Settings › Close my account (POST /api/account/close), with the same
 * confirmations: the typed phrase, the current password and, if turned on,
 * two-factor. Approved creators never see this page (it redirects them).
 */
export default function PendingSelfDelete({ status }: { status: "pending" | "rejected" }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const pwId = useId();
  const phraseId = useId();
  const errId = useId();
  const ready = password.length > 0 && phrase.trim() === CLOSE_ACCOUNT_PHRASE;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, confirm: phrase.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      const state = deletionResponseState(res.status, d);
      if (state === "pending") {
        setError(ACCOUNT_CLEANUP_PENDING_MESSAGE);
        return;
      }
      if (state !== "complete") {
        setError(closeAccountErrorMessage(d.error));
        return;
      }
      window.location.replace("/login?closed=1");
    } catch {
      setError(closeAccountErrorMessage(undefined));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-4 text-left" data-testid="pending-self-delete">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="min-h-11 w-full text-center text-xs font-semibold text-muted underline-offset-4 hover:text-ink hover:underline"
      >
        Delete my request and account
      </button>
      <div id={panelId} hidden={!open} className="mt-3 space-y-3">
        <p className="text-xs text-muted text-pretty">
          {status === "rejected"
            ? "This permanently deletes your declined request and your FanFunnel sign-in. This can't be undone."
            : "This withdraws your request and permanently deletes your FanFunnel sign-in. This can't be undone."}{" "}
          You can sign up again later with the same e-mail as a new account.
        </p>
        <label htmlFor={pwId} className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Current password</span>
          <input
            id={pwId}
            type="password"
            autoComplete="current-password"
            className="ff-input w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? errId : undefined}
          />
        </label>
        <label htmlFor={phraseId} className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Type {CLOSE_ACCOUNT_PHRASE}</span>
          <input
            id={phraseId}
            className="ff-input w-full"
            autoComplete="off"
            spellCheck={false}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={CLOSE_ACCOUNT_PHRASE}
            aria-describedby={error ? errId : undefined}
          />
        </label>
        {error && (
          <p id={errId} role="alert" className="text-xs text-amber-300">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={remove}
          disabled={!ready || busy}
          className="min-h-11 w-full rounded-xl border border-[#ef4444] py-2.5 text-sm font-bold text-[#ef4444] transition hover:bg-[#ef4444]/10 disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Permanently delete my account"}
        </button>
      </div>
    </div>
  );
}
