"use client";

import type { ConversionFunnel } from "@/lib/data/types";

// A dependency-free conversion funnel: link → spin → fulfilled. Each stage is a
// horizontal bar whose width is proportional to the widest stage (links), with
// the count and the conversion rate versus the previous stage. "Opened" isn't
// tracked, so the funnel skips it.
export default function Funnel({ funnel }: { funnel: ConversionFunnel }) {
  const max = Math.max(funnel.links, funnel.spun, funnel.fulfilled, 1);
  const stages = [
    { label: "Links", count: funnel.links, prev: null as number | null },
    { label: "Spun", count: funnel.spun, prev: funnel.links },
    { label: "Fulfilled", count: funnel.fulfilled, prev: funnel.spun },
  ];

  return (
    <div>
      <div className="space-y-2.5">
        {stages.map((s) => {
          const pct = (s.count / max) * 100;
          const conv =
            s.prev === null
              ? null
              : s.prev > 0
                ? Math.round((s.count / s.prev) * 100)
                : 0;
          return (
            <div key={s.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 truncate text-sm text-ink">
                {s.label}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(4, pct)}%`,
                    backgroundColor: "var(--brand)",
                  }}
                />
              </div>
              <span className="tnum w-10 shrink-0 text-right text-sm font-semibold text-ink">
                {s.count}
              </span>
              <span className="tnum w-12 shrink-0 text-right text-xs text-muted">
                {conv === null ? "—" : `${conv}%`}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">
        Opened isn&rsquo;t tracked yet — funnel runs link → spin → fulfilled.
      </p>
    </div>
  );
}
