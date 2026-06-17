"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearErrors,
  reportError,
  resolveDebug,
  setDebugAdmin,
  subscribe,
  type CapturedError,
} from "./debug";
import { isSupabaseConfigured } from "@/lib/supabase/client";

const KIND_LABEL: Record<CapturedError["kind"], string> = {
  error: "Error",
  unhandledrejection: "Unhandled rejection",
  react: "Render error",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Build the plain-text blob used by "Copy errors". */
function toPlainText(errors: CapturedError[]): string {
  return errors
    .map((e) => {
      const lines = [
        `[${fmtTime(e.timestamp)}] ${KIND_LABEL[e.kind]}: ${e.message}`,
      ];
      if (e.source) {
        const loc = [e.source, e.line, e.column].filter(Boolean).join(":");
        lines.push(`  at ${loc}`);
      }
      if (e.stack) lines.push(e.stack.replace(/^/gm, "  "));
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Copy via the async Clipboard API, falling back to execCommand for
 *  non-secure contexts (http / older browsers) where navigator.clipboard
 *  is unavailable. Returns whether the copy succeeded. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * In-app error console. Mounted once at the app root; renders NOTHING and
 * registers NO listeners unless debug mode is active (see resolveDebug). When
 * active it captures window errors + unhandled promise rejections, shows a
 * floating launcher, and auto-opens a scrollable panel on the first error.
 *
 * All error text is rendered as React text nodes (auto HTML-escaped) — no
 * dangerouslySetInnerHTML — so captured payloads can't inject markup.
 */
export default function DebugConsole() {
  // null = not yet resolved (also the SSR + first-paint value, so we render
  // nothing identical on server and client and avoid a hydration mismatch).
  const [active, setActive] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<CapturedError[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prevCount = useRef(0);

  useEffect(() => {
    // Resolve on mount only (client-side; SSR + first paint render null). Debug is
    // gated: it activates only if explicitly requested (?debug=1 / this session)
    // AND the viewer is allowed — an admin in production (confirmed via /api/me),
    // or anyone in local/demo dev (no Supabase backend). Normal production users
    // never trigger the fetch (resolveDebug() is false) — zero overhead for them.
    if (!resolveDebug()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only flag resolution
      setActive(false);
      return;
    }
    let cancelled = false;
    (async () => {
      let ok = false;
      if (!isSupabaseConfigured()) {
        // Local/demo dev: no auth backend, so allow the dev tool. Still requires
        // ?debug=1 (session opt-in), so it's never "always on".
        ok = true;
      } else {
        try {
          const res = await fetch("/api/me", { cache: "no-store" });
          ok = res.ok && (await res.json())?.isAdmin === true;
        } catch {
          ok = false;
        }
      }
      if (cancelled) return;
      setDebugAdmin(ok);
      setActive(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe + register listeners only while active.
  useEffect(() => {
    if (!active) return;

    const unsub = subscribe(setErrors);

    const onError = (ev: ErrorEvent) => {
      reportError({
        kind: "error",
        message: ev.message || (ev.error ? String(ev.error) : "Unknown error"),
        source: ev.filename || undefined,
        line: ev.lineno || undefined,
        column: ev.colno || undefined,
        stack: ev.error?.stack,
      });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason as unknown;
      const msg =
        r instanceof Error
          ? r.message
          : typeof r === "string"
            ? r
            : (() => {
                try {
                  return JSON.stringify(r);
                } catch {
                  return String(r);
                }
              })();
      reportError({
        kind: "unhandledrejection",
        message: msg || "Unhandled promise rejection",
        stack: r instanceof Error ? r.stack : undefined,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      unsub();
    };
  }, [active]);

  // Auto-open on the first error (the 0 → ≥1 transition).
  useEffect(() => {
    if (prevCount.current === 0 && errors.length > 0) setOpen(true);
    prevCount.current = errors.length;
  }, [errors.length]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(toPlainText(errors));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [errors]);

  if (!active) return null;

  return (
    // Bottom-LEFT so the launcher never sits on top of the app's bottom-right
    // fixed UI (e.g. the fan chat FAB).
    <div className="fixed bottom-3 left-3 z-[100] font-sans">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-full border border-line bg-surface/95 px-3 py-2 text-xs font-semibold text-ink shadow-2xl backdrop-blur transition hover:border-[var(--brand)]"
          aria-label="Open debug console"
        >
          <span aria-hidden>🐞</span>
          Debug
          {errors.length > 0 && (
            <span className="tnum grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
              {errors.length}
            </span>
          )}
        </button>
      ) : (
        <div
          role="dialog"
          aria-label="Debug error console"
          className="flex max-h-[70vh] w-[min(92vw,30rem)] flex-col overflow-hidden rounded-xl border border-line bg-surface/98 shadow-2xl backdrop-blur"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-sm font-bold text-ink">🐞 Debug console</span>
            <span className="tnum rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-muted">
              {errors.length} {errors.length === 1 ? "error" : "errors"}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={onCopy}
                disabled={errors.length === 0}
                className="rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink transition hover:bg-white/5 disabled:opacity-40"
              >
                {copied ? "Copied!" : "Copy errors"}
              </button>
              <button
                onClick={() => clearErrors()}
                disabled={errors.length === 0}
                className="rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink transition hover:bg-white/5 disabled:opacity-40"
              >
                Clear
              </button>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-ink transition hover:bg-white/5"
                aria-label="Close debug console"
              >
                Close
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {errors.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted">
                No errors captured yet. They&rsquo;ll appear here (newest first)
                as soon as something throws.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {errors.map((e) => (
                  <li key={e.id} className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-400">
                        {KIND_LABEL[e.kind]}
                      </span>
                      <span className="tnum ml-auto text-[10px] text-muted">
                        {fmtTime(e.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1.5 break-words text-sm font-medium text-ink">
                      {e.message}
                    </p>
                    {(e.source || e.line) && (
                      <p className="mt-0.5 break-all text-[11px] text-muted">
                        {[e.source, e.line, e.column]
                          .filter((v) => v !== undefined && v !== null && v !== "")
                          .join(":")}
                      </p>
                    )}
                    {e.stack && (
                      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-base/60 p-2 text-[11px] leading-relaxed text-muted">
                        {e.stack}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Self-test: force a React render crash so you can watch the error
              boundary catch it and log it here (kind: Render error). */}
          <div className="border-t border-line px-3 py-2">
            <button
              onClick={() =>
                window.dispatchEvent(new Event("ff:debug:crash"))
              }
              className="w-full rounded-lg border border-red-500/40 px-2 py-1.5 text-[11px] font-semibold text-red-400 transition hover:bg-red-500/10"
            >
              ⚠︎ Force a render crash (test the error boundary)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
