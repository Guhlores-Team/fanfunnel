// The neutral home-screen glyph (D8): a prize wheel with a pointer, nothing that
// names or pictures the creator. Plain SVG with no hooks, so the icon routes
// (next/og) and the dashboard's preview render the same drawing.

const SPOKES = [0, 60, 120, 180, 240, 300];
const CX = 50;
const CY = 55;
const R = 33;

export default function WheelGlyph({ size, ink }: { size: number; ink: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle cx={CX} cy={CY} r={R} fill="none" stroke={ink} strokeWidth={7} />
      {SPOKES.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={CX}
            y1={CY}
            x2={CX + R * Math.sin(rad)}
            y2={CY - R * Math.cos(rad)}
            stroke={ink}
            strokeWidth={4.5}
            strokeLinecap="round"
          />
        );
      })}
      <circle cx={CX} cy={CY} r={8} fill={ink} />
      <polygon points="40,6 60,6 50,22" fill={ink} />
    </svg>
  );
}
