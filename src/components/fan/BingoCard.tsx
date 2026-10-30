"use client";

import { useEffect, useState } from "react";
import type { BingoPresentation, BingoState } from "@/lib/games/bingo/engine";

export const bingoLineLabel = (line: number) => line < 3 ? `Row ${line + 1}` : line < 6 ? `Column ${line - 2}` : `Diagonal ${line - 5}`;

/** Only renders committed marks. A table is readable without nine redundant tab stops.
 *  `engaged` is the F6 gate (fanEngagementAllowed): a blocked, paused or
 *  resting fan reads the card with neutral copy, never a "next play" nudge. */
export default function BingoCard({ card, presentation, prizeLabel, savedPlay = false, engaged = true }: {
  card: BingoState | null;
  presentation?: BingoPresentation | null;
  prizeLabel?: string;
  savedPlay?: boolean;
  engaged?: boolean;
}) {
  const state = presentation?.after ?? card;
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!presentation || !prizeLabel) return;
    const marked = presentation.markedIndex;
    const alreadyMarked = !presentation.newCard && marked !== null && !!((presentation.before?.markedMask ?? 0) & (1 << marked));
    const mark = marked === null ? "This prize is outside your card; your win is still yours."
      : alreadyMarked ? "That square was already marked; your win is still yours." : `${prizeLabel} is now marked on your card.`;
    const lines = presentation.newLines.length ? ` ${presentation.newLines.length === 1 ? "A new line is" : `${presentation.newLines.length} new lines are`} complete. Your bonus rewards appear in your win card.` : "";
    const timer = setTimeout(() => setAnnouncement(`${savedPlay ? "Recovered play. " : ""}You won ${prizeLabel}. ${mark}${lines}`), 80);
    return () => clearTimeout(timer);
  }, [presentation, prizeLabel, savedPlay]);
  return (
    <section aria-label="Your personal bingo card" className="w-full min-w-0 rounded-2xl border border-line bg-surface p-3 sm:p-4" data-testid="bingo-card" data-card-version={state?.version ?? "new"}>
      <p className="mb-3 text-sm text-muted">Every play wins its drawn prize. A newly completed line adds a bonus reward.</p>
      {savedPlay && <p className="mb-3 text-xs text-muted">Card from your recovered play. Your current balance is shown below.</p>}
      {state ? <table className="w-full table-fixed border-collapse text-center" aria-label="Three by three personal bingo card" data-testid="bingo-grid">
        <tbody>{[0,1,2].map(row => <tr key={row}>{state.cells.slice(row * 3, row * 3 + 3).map((cell, column) => {
          const index = row * 3 + column;
          const marked = !!(state.markedMask & (1 << index));
          return <td key={cell.id} data-testid="bingo-cell" data-prize-id={cell.id} data-marked={String(marked)}
            aria-label={`Row ${row + 1}, column ${column + 1}: ${cell.label}, ${marked ? "marked" : "unmarked"}`}
            className={`h-32 border border-line px-1 py-3 align-middle ${marked ? "bg-[color-mix(in_oklab,var(--brand)_15%,var(--color-base))]" : "bg-base"}`}>
            <span className="block text-2xl" aria-hidden="true">{cell.emoji ?? "🎁"}</span>
            <span className="mt-1 block break-words text-xs font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{cell.label}</span>
            <span className={`mt-2 block text-xs font-bold ${marked ? "text-[var(--brand-text)]" : "text-muted"}`}><span aria-hidden="true">{marked ? "✓ " : "○ "}</span>{marked ? "Marked" : "Unmarked"}</span>
          </td>;
        })}</tr>)}</tbody>
      </table> : <p className="rounded-xl border border-line bg-base p-6 text-center text-sm text-ink" data-testid="bingo-new-card">{engaged ? "Your first play creates your own card and awards its drawn prize." : "No card yet. A card is created by a play."}</p>}
      {state?.markedMask === 511 && <p className="mt-3 text-sm font-semibold text-ink" data-testid="bingo-full-card">{engaged ? "Card complete. Your next play starts a new card." : "Card complete."}</p>}
      <p role="status" aria-live="polite" aria-atomic="true" className="mt-3 text-sm text-muted" data-testid="bingo-announcement">{announcement}</p>
    </section>
  );
}
