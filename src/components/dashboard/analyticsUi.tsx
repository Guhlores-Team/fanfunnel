"use client";

import type { ReactNode } from "react";

// Command Center primitives shared by the Analytics section (MetricsPanel,
// AnalyticsPanel, CrmPanel). Same tokens as TodayPanel: raised cards on --s1,
// recessed hairline grids with --s2 cells, 3px brand-tick group headers.

export const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
/** Hairline grid: the 1px gap shows the --hair background between --s2 cells. */
export const hairGrid = "grid gap-px overflow-hidden rounded-[14px] border border-[var(--hair)] bg-[var(--hair)]";
export const recessedCell = "[background:var(--s2)]";

// 24×24 stroke paths (Command Center prototype line icons).
export const ICON = {
  chart: "M3 3v18h18M7 16v-5M12 16V8M17 16v-3",
  funnel: "M3 4h18l-7 9v6l-4 2v-8L3 4Z",
  dollar: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  fans: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87",
  crown: "M3 18h18M4 8l4 4 4-7 4 7 4-4-1.5 10h-13L4 8Z",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  gift: "M20 8v13H4V8M2 4h20v4H2zM12 4v17M12 4S10.5 1 8.3 1.6 6 4 6.5 4.6 9 5 12 4Z",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
};

export function Glyph({ d, size = 16, className = "" }: { d: string; size?: number; className?: string }) {
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

/** Group sub-header with the 3px brand tick (as TodayPanel's "Needs you now"). */
export function TickHeader({
  id,
  title,
  hint,
  right,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-sm bg-[var(--brand)]" />
          {title}
        </h2>
        {right}
      </div>
      {hint && <p className="mt-1 max-w-3xl pl-3 text-xs text-muted text-pretty">{hint}</p>}
    </div>
  );
}

/** Card title row: 14px semibold title, optional muted hint and a right slot. */
export function CardHeader({
  title,
  icon,
  hint,
  right,
}: {
  title: ReactNode;
  icon?: string;
  hint?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {icon && <Glyph d={icon} size={15} className="text-brand" />}
          {title}
        </h3>
        {hint && <p className="mt-0.5 text-xs text-muted text-pretty">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

/**
 * A failed read renders fixed copy (never the raw error text) plus a retry.
 */
export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
      <span className="flex items-center gap-2">
        <Glyph d={ICON.alert} size={15} className="text-[#fcd34d]" />
        Couldn&rsquo;t load {what} right now.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:border-[var(--brand)]"
      >
        Try again
      </button>
    </div>
  );
}

/** One recessed stat cell: big tabular value over a small label. */
export function StatCell({
  label,
  value,
  big,
  className = "",
}: {
  label: string;
  value: ReactNode;
  /** 24px strip value (stat strip) vs 20px (profit / LTV grids). */
  big?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col ${big ? "px-[18px] py-[18px]" : "px-[18px] py-4"} ${recessedCell} ${className}`}>
      <dt
        className={`order-2 mt-[3px] ${
          big ? "text-[11px] font-medium uppercase tracking-[0.04em]" : "text-xs"
        } text-muted`}
      >
        {label}
      </dt>
      <dd className={`tnum order-1 font-bold leading-tight text-ink ${big ? "text-2xl" : "text-xl"}`}>{value}</dd>
    </div>
  );
}
