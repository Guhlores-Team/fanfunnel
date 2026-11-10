"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { legalBody } from "./legalBody";

/**
 * WF-11 (FD-19): the Terms and Privacy pages opened from the age gate. A new
 * tab had no way back (and an in-app browser reloads the gate, losing the
 * ticks), so the text opens in a sheet over the gate and closes back to it.
 * The page is fetched from this origin and its body shown in place (see
 * legalBody.ts: the CSP forbids frames).
 */
export default function LegalSheet({ href, title, onClose }: { href: "/terms" | "/privacy"; title: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose, initialFocus: closeRef });
  const [body, setBody] = useState<{ href: string; html: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(href, { headers: { accept: "text/html" } })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => { if (live) setBody({ href, html: legalBody(new DOMParser().parseFromString(text, "text/html")) }); })
      .catch(() => { if (live) setBody({ href, html: null }); });
    return () => { live = false; };
  }, [href]);
  const current = body && body.href === href ? body : null;
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/85 p-3 backdrop-blur-sm" data-testid="legal-sheet">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.5rem]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <p className="text-sm font-bold text-ink">{title}</p>
          <button ref={closeRef} type="button" onClick={onClose} data-testid="legal-sheet-close"
            className="min-h-11 rounded-xl px-3 text-sm font-semibold text-ink underline-offset-4 hover:underline">
            Back to the game
          </button>
        </div>
        {current?.html ? (
          <div
            data-testid="legal-sheet-body"
            tabIndex={0}
            role="document"
            aria-label={`${title} text`}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 [&_main]:min-h-0"
            // Our own static legal page, sanitised in legalBody (no scripts, handlers, frames or forms).
            dangerouslySetInnerHTML={{ __html: current.html }}
          />
        ) : (
          <p role="status" data-testid="legal-sheet-status" className="flex-1 px-4 py-6 text-center text-sm text-muted">
            {current ? "This page didn't load here." : "Loading…"}
          </p>
        )}
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-2">Open in a new tab</a>
        </p>
      </div>
    </div>
  );
}
