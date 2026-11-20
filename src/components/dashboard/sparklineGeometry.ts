/**
 * Polyline vertices for a sparkline in a 0..100 viewBox, y inverted (0 = top).
 * An all-zero series sits on the baseline. A single point is drawn as a flat
 * full-width line, since a one-vertex polyline renders nothing.
 */
export function sparklinePoints(values: number[]): string {
  const n = values.length;
  if (n === 0) return "";
  const max = values.reduce((m, v) => Math.max(m, v), 0) || 1;
  const y = (v: number) => (100 - (v / max) * 100).toFixed(2);
  if (n === 1) return `0.00,${y(values[0])} 100.00,${y(values[0])}`;
  return values
    .map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${y(v)}`)
    .join(" ");
}
