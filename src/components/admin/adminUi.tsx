// Shared look of the Admin section (Command Center prototype): line icons,
// surfaces, buttons, pills and the section title bar. Used by AdminClient and
// AdminErrors so the two read as one panel.
import type { ReactNode } from "react";

// 24×24 stroke paths (Command Center prototype line icons).
export const P = {
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9.5 12l2 2 3.5-4",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5zM12 15v2",
  plus: "M12 5v14M5 12h14",
  chevron: "m6 9 6 6 6-6",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87",
  wheel: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  gift: "M20 8v13H4V8M2 4h20v4H2zM12 4v17M12 4S10.5 1 8.3 1.6 6 4 6.5 4.6 9 5 12 4Z",
  inbox: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
};

export function Glyph({ d, size = 18, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

export const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
export const recessed = "border border-[var(--hair)] [background:var(--s2)]";
export const btnGhost =
  "inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line px-[11px] text-xs font-semibold text-muted transition-colors hover:border-[color-mix(in_oklab,var(--color-ink)_25%,var(--color-line))] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";
export const btnDanger =
  "inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[#ef4444]/50 px-[11px] text-xs font-semibold text-[#f87171] transition-colors hover:bg-[#ef4444]/10 disabled:cursor-not-allowed disabled:opacity-50";
export const pill = "inline-flex shrink-0 items-center rounded-full px-2.5 py-[3px] text-[11px] font-bold";

export function SectionTitle({ id, children, extra }: { id: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f1b27] px-4 py-3.5 sm:px-[18px] sm:py-4">
      <h2 id={id} className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink">
        <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
        {children}
      </h2>
      {extra}
    </div>
  );
}
