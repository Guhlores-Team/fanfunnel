"use client";

import type { ConversionFunnel } from "@/lib/data/types";

// A dependency-free conversion funnel: fans created → fans who've spun → fans
// with a fulfilled prize. Each stage is a horizontal bar proportional to the
// widest stage (fans), with the count and the conversion rate vs the previous
// stage.
export default function Funnel({ funnel }: { funnel: ConversionFunnel }) {
  const max = Math.max(funnel.fans, funnel.spun, funnel.fulfilled, 1);
  const stages = [
    { label: "Fans", count: funnel.fans, prev: null as number | null },
    { label: "Spun", count: funnel.spun, prev: funnel.fans },
    { label: "Fulfilled", count: funnel.fulfilled, prev: funnel.spun },
  ];

  return (
    <div className="space-y-2.5">
      {stages.map((s) => {
        const widthPct = Math.round((s.count / max) * 100);
        const convPct =
          s.prev && s.prev > 0 ? Math.round((s.count / s.prev) * 100) : null;
        return (
          <div key={s.label}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-ink">{s.label}</span>
              <span className="text-muted">
                <span className="tnum font-semibold text-ink">{s.count}</span>
                {convPct !== null && (
                  <span className="ml-1.5 text-[10px]">({convPct}%)</span>
                )}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-white/5">
              <div
                className="h-2 rounded-full bg-[var(--brand)]"
                style={{ width: `${widthPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
