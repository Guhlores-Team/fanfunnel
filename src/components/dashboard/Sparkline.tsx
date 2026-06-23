"use client";

import { useEffect, useState } from "react";
import type { DailyCount } from "@/lib/data/types";
import { prefersReducedMotion } from "@/lib/sound";

// A dependency-free, responsive spin-trend sparkline. The line + area are drawn
// in a fixed 0..100 viewBox and stretched to fill the container; the stroke is
// kept visually sane with vector-effect so it doesn't distort under the
// non-uniform scale.
export default function Sparkline({
  data,
  height = 56,
  format,
  noun = "Spin",
}: {
  data: DailyCount[];
  height?: number;
  /** Format the total/peak labels (e.g. formatCents for a revenue series). */
  format?: (n: number) => string;
  /** Noun used in the aria-label ("Spin trend" / "Revenue trend"). */
  noun?: string;
}) {
  const fmt = format ?? ((n: number) => String(n));
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

  const label = `${noun} trend: ${fmt(total)} total over ${n} day${n === 1 ? "" : "s"}, peak ${fmt(peak)} in a day.`;

  // Animate the line drawing itself in — but only when the viewer hasn't asked
  // for reduced motion. Resolved after mount (matchMedia is client-only), so
  // SSR + first paint render the line statically and there's no hydration
  // mismatch; reduced-motion users keep the static line.
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only motion-preference resolution after mount (SSR-safe)
    if (!prefersReducedMotion()) setAnimate(true);
  }, []);

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
          pathLength={1}
          style={
            animate
              ? {
                  strokeDasharray: 1,
                  strokeDashoffset: 1,
                  animation: "ff-spark-draw 0.7s ease-out forwards",
                }
              : undefined
          }
        />
      </svg>
      {animate && (
        <style>{`@keyframes ff-spark-draw { to { stroke-dashoffset: 0 } }`}</style>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>
          <span className="tnum font-semibold text-ink">{fmt(total)}</span> total
        </span>
        <span>
          peak <span className="tnum font-semibold text-ink">{fmt(peak)}</span>/day
        </span>
      </div>
    </div>
  );
}
