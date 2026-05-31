"use client";

import type { DailyCount } from "@/lib/data/types";

// A dependency-free, responsive spin-trend sparkline. The line + area are drawn
// in a fixed 0..100 viewBox and stretched to fill the container; the stroke is
// kept visually sane with vector-effect so it doesn't distort under the
// non-uniform scale.
export default function Sparkline({
  data,
  height = 56,
}: {
  data: DailyCount[];
  height?: number;
}) {
  const total = data.reduce((s, d) => s + d.spins, 0);
  const peak = data.reduce((m, d) => Math.max(m, d.spins), 0);
  const n = data.length;

  // Map each point into the 0..100 box, y inverted (0 = top). Guard against a
  // single-point series and an all-zero series.
  const max = peak || 1;
  const points = data.map((d, i) => {
    const x = n <= 1 ? 0 : (i / (n - 1)) * 100;
    const y = 100 - (d.spins / max) * 100;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePoints = points.join(" ");
  // Close the area down to the baseline for the subtle fill.
  const areaPoints =
    n > 0 ? `0,100 ${linePoints} 100,100` : "0,100 100,100";

  const label = `Spin trend: ${total} total over ${n} day${n === 1 ? "" : "s"}, peak ${peak} in a day.`;

  return (
    <div>
      <svg
        role="img"
        aria-label={label}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
      >
        <polygon
          points={areaPoints}
          fill="color-mix(in oklab, var(--brand) 18%, transparent)"
          stroke="none"
        />
        <polyline
          points={linePoints}
          fill="none"
          stroke="var(--brand)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>
          <span className="tnum font-semibold text-ink">{total}</span> total
        </span>
        <span>
          peak <span className="tnum font-semibold text-ink">{peak}</span>/day
        </span>
      </div>
    </div>
  );
}
