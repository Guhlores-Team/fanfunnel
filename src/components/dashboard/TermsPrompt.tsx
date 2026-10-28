"use client";

import { useEffect, useId, useRef, useState } from "react";
import Modal from "@/components/ui/Modal";
import TermsCheckbox from "@/components/TermsCheckbox";

interface TermsStatus {
  version: string | null;
  needsAcceptance: boolean;
}

/**
 * One-time clickwrap for signed-in creators whose recorded Terms version is
 * missing or older than the current one (migration 0055). Blocking and
 * non-dismissable until they agree (or sign out). The acceptance itself is
 * recorded by POST /api/account/terms, server-side.
 */
export default function TermsPrompt({ canSignOut }: { canSignOut: boolean }) {
  const [status, setStatus] = useState<TermsStatus | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/account/terms", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: TermsStatus | null) => {
        if (live && s && typeof s.needsAcceptance === "boolean") setStatus(s);
      })
      .catch(() => {
        /* no prompt if the status can't be read; it is asked again next load */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!status?.needsAcceptance) return null;

  const accept = async () => {
    if (!agreed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept: true }),
      });
      if (!res.ok) throw new Error();
      setStatus({ version: null, needsAcceptance: false });
    } catch {
      setError("Couldn’t save that. Check your connection and try again.");
      setBusy(false);
    }
  };

  const updated = status.version != null;
  return (
    <Modal
      onClose={() => {}}
      dismissable={false}
      labelledBy={titleId}
      initialFocus={firstRef}
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      className="w-full max-w-md rounded-2xl border border-[var(--hair)] p-6 text-ink shadow-[var(--lift)] [background:var(--s1)]"
    >
      <div data-testid="terms-prompt">
        <h2 id={titleId} className="text-lg font-bold tracking-[-0.01em]">
          {updated ? "We’ve updated our terms" : "Please review our terms"}
        </h2>
        <p className="mt-2 text-[13.5px] text-muted text-pretty">
          {updated
            ? "Our Terms of Service and Privacy Policy have changed. Please read them and agree to keep using FanFunnel."
            : "To keep using FanFunnel, please read and agree to our Terms of Service and Privacy Policy."}
        </p>
        <div className="mt-4">
          <TermsCheckbox checked={agreed} onChange={setAgreed} disabled={busy} inputRef={firstRef} />
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-amber-300">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={accept}
          disabled={!agreed || busy}
          className="btn-brand mt-5 w-full rounded-[10px] py-2.5 text-sm font-bold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Agree and continue"}
        </button>
        {canSignOut && (
          <form action="/auth/signout" method="post" className="mt-3 text-center">
            <button className="text-xs font-semibold text-muted transition hover:text-ink">Sign out</button>
          </form>
        )}
      </div>
    </Modal>
  );
}
