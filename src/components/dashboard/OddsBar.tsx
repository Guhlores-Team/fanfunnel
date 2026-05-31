"use client";

import { type Prize, RARITY_COLORS } from "@/lib/games/wheel/types";

// Horizontal stacked bar showing each prize's win odds as a proportional
// segment. Mirrors the rarity-mix bar idiom in MetricsPanel.
export function OddsBar({
  prizes,
  odds,
}: {
  prizes: Prize[];
  odds: Map<string, number>;
}) {
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full">
      {prizes.map((p) => {
        const pct = odds.get(p.id) ?? 0;
        const label = `${p.label}: ${pct.toFixed(1)}%`;
        return (
          <div
            key={p.id}
            style={{
              width: `${pct}%`,
              backgroundColor: p.color ?? RARITY_COLORS[p.rarity],
            }}
            title={label}
            aria-label={label}
          />
        );
      })}
    </div>
  );
}
