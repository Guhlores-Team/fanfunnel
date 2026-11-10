"use client";

import { useRef } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";

/**
 * WF-11 (FD-19): the Terms and Privacy pages opened from the age gate. A new
 * tab had no way back (and an in-app browser reloads the gate, losing the
 * ticks), so the page opens in a sheet over the gate and closes back to it.
 */
export default function LegalSheet({ href, title, onClose }: { href: "/terms" | "/privacy"; title: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose, initialFocus: closeRef });
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/85 p-3 backdrop-blur-sm" data-testid="legal-sheet">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.5rem]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} data-testid="legal-sheet-close"
            className="min-h-11 rounded-xl px-3 text-sm font-semibold text-ink underline-offset-4 hover:underline">
            Back to the game
          </button>
        </div>
        <iframe src={href} title={title} className="min-h-0 w-full flex-1 bg-white" />
        <p className="px-4 py-2 text-xs text-muted">
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Open in a new tab</a> if this page does not load.
        </p>
      </div>
    </div>
  );
}
