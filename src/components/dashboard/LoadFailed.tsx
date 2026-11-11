"use client";

import { useEffect, useState } from "react";
import { LoadError, loadErrorMessage, loginRedirectHref } from "@/lib/hooks/loadJson";

/**
 * The one "this didn't load" state for dashboard lists and tiles. Never an
 * empty state: it says the load failed and offers Retry (or Sign in after a
 * 401). `compact` fits inside a tile; `stale` keeps already-loaded data on
 * screen and only notes that the latest refresh failed.
 */
export default function LoadFailed({ error, what, onRetry, compact = false, stale = false, testId }: {
  error: unknown;
  /** "your fans", "the fulfilment queue"… */
  what: string;
  onRetry?: () => void | Promise<unknown>;
  compact?: boolean;
  stale?: boolean;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [href, setHref] = useState("/login");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the return path is only known in the browser
    setHref(loginRedirectHref(window.location));
  }, []);
  const auth = error instanceof LoadError && error.kind === "auth";
  const message = stale && !auth ? `Couldn't refresh ${what}. Showing what loaded earlier.` : loadErrorMessage(error, what);
  const retry = async () => {
    if (!onRetry || busy) return;
    setBusy(true);
    try { await onRetry(); } finally { setBusy(false); }
  };
  const action = "inline-flex min-h-9 items-center justify-center rounded-[9px] border border-line px-3 text-xs font-semibold text-ink hover:border-[var(--brand-ui)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-ui)] disabled:opacity-60";
  return (
    <div
      role="alert"
      data-testid={testId ?? "load-failed"}
      data-load-kind={error instanceof LoadError ? error.kind : "network"}
      className={compact || stale
        ? "flex flex-wrap items-center gap-2 text-[12.5px] text-amber-200"
        : "flex flex-col items-center gap-3 rounded-xl border border-amber-400/40 bg-amber-400/5 p-6 text-center text-sm text-amber-100"}
    >
      <span className="text-pretty">{message}</span>
      {auth ? (
        <a href={href} className={action}>Sign in</a>
      ) : onRetry ? (
        <button type="button" onClick={retry} disabled={busy} className={action}>
          {busy ? "Retrying…" : "Retry"}
        </button>
      ) : null}
    </div>
  );
}
