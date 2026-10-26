"use client";

import { useId, useRef } from "react";
import Modal from "@/components/ui/Modal";

/**
 * In-app "unsaved changes" prompt (replaces window.confirm). Focus lands on the
 * safe action, Tab cycles inside, Escape or the backdrop keeps the edits, and
 * focus returns to the control that opened it once it closes.
 */
export default function DiscardChangesDialog({
  what,
  consequence = "Switching now throws them away.",
  onKeep,
  onDiscard,
}: {
  /** What has unsaved edits, e.g. "this wheel". */
  what: string;
  /** What happens on Discard, e.g. "Signing out now throws them away." */
  consequence?: string;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const titleId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      onClose={onKeep}
      labelledBy={titleId}
      initialFocus={keepRef}
      className="w-full max-w-sm rounded-2xl border border-[var(--hair)] p-6 text-ink shadow-[var(--lift)] [background:var(--s1)]"
    >
      <div>
        <h2 id={titleId} className="flex items-center gap-[9px] text-lg font-bold tracking-[-0.01em]">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[#f59e0b]" />
          Discard unsaved changes?
        </h2>
        <p className="mt-2 text-[13.5px] text-muted text-pretty">
          {`You have edits to ${what} that aren’t saved. ${consequence}`}
        </p>
        <div className="mt-5 flex gap-2">
          <button
            ref={keepRef}
            type="button"
            onClick={onKeep}
            className="flex-1 rounded-[10px] border border-line py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="flex-1 rounded-[10px] border border-[#ef4444]/50 py-2.5 text-sm font-bold text-[#f87171] transition-colors hover:bg-[#ef4444]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ef4444]"
          >
            Discard changes
          </button>
        </div>
      </div>
    </Modal>
  );
}
