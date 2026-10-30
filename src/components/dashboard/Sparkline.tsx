"use client";

import { useEffect, useState } from "react";
import type { DailyCount } from "@/lib/data/types";
import { prefersReducedMotion } from "@/lib/sound";
import { sparklinePoints } from "./sparklineGeometry";

// A dependency-free, responsive spin-trend sparkline. The line + area are drawn
// in a fixed 0..100 viewBox and stretched to fill the container; the stroke is
// kept visually sane with vector-effect so it doesn't distort under the
// non-uniform scale.
export default function Sparkline({
  data,
  height = 56,
  format,
  noun = "Spin",
  color = "var(--brand)",
}: {
  data: DailyCount[];
  height?: number;
  /** Format the total/peak labels (e.g. formatCents for a revenue series). */
  format?: (n: number) => string;
  /** Noun used in the aria-label ("Spin trend" / "Revenue trend"). */
  noun?: string;
  /** Line color (the Command Center draws revenue in green). */
  color?: string;
}) {
  const fmt = format ?? ((n: number) => String(n));
  const total = data.reduce((s, d) => s + d.spins, 0);
  const peak = data.reduce((m, d) => Math.max(m, d.spins), 0);
  const n = data.length;

  const linePoints = sparklinePoints(data.map((d) => d.spins));
  // Close the area down to the baseline for the subtle fill.
  const areaPoints =
    n > 0 ? `0,100 ${linePoints} 100,100` : "0,100 100,100";

  const label = `${noun} trend: ${fmt(total)} total over ${n} day${n === 1 ? "" : "s"}, peak ${fmt(peak)} in a day.`;

  // Wipe the chart in left-to-right — but only when the viewer hasn't asked
  // for reduced motion. Resolved after mount (matchMedia is client-only), so
  // SSR + first paint render the line statically and there's no hydration
  // mismatch; reduced-motion users keep the static line. The wipe is a
  // clip-path on the <svg>, not a stroke-dash draw: Chromium measures dashes
  // in screen space under vector-effect="non-scaling-stroke" while pathLength
  // is in user space, which left flat lines dashed and other lines cut short.
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
        // A flat series sits on the top/bottom edge; don't clip half its stroke.
        overflow="visible"
        className="w-full"
        style={{
          height,
          animation: animate ? "ff-spark-draw 0.7s ease-out" : undefined,
        }}
      >
        <polygon
          points={areaPoints}
          fill={`color-mix(in oklab, ${color} 18%, transparent)`}
          stroke="none"
        />
        <polyline
          points={linePoints}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {animate && (
        // Negative insets keep edge strokes visible mid-wipe; with no fill-mode
        // the clip is dropped entirely once the animation ends.
        <style>{`@keyframes ff-spark-draw { from { clip-path: inset(-4px 100% -4px -4px) } to { clip-path: inset(-4px) } }`}</style>
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
