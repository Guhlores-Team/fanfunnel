"use client";

import { RARITY_COLORS, RARITY_ORDER } from "@/lib/games/wheel/types";
import type { WonPrize } from "@/lib/data/types";

const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Grouped {
  label: string;
  rarity: WonPrize["rarity"];
  emoji?: string;
  color?: string;
  count: number;
  latest: string;
}

/**
 * The fan's wins as visual cards (grouped by prize) instead of flat pills. Each
 * card shows a rarity-tinted medallion, the rarity, how many times it's been won,
 * and how recently — turning a list into a collection worth showing off.
 */
export default function WinsGallery({ history }: { history: WonPrize[] }) {
  if (history.length === 0) return null;

  // Group identical prizes; keep a count + the most recent timestamp.
  const map = new Map<string, Grouped>();
  for (const w of history) {
    const key = `${w.label}|${w.rarity}`;
    const g = map.get(key);
    if (g) {
      g.count += 1;
      if (new Date(w.at) > new Date(g.latest)) g.latest = w.at;
    } else {
      map.set(key, { label: w.label, rarity: w.rarity, emoji: w.emoji, color: w.color, count: 1, latest: w.at });
    }
  }
  const groups = [...map.values()].sort(
    (a, b) =>
      RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || b.count - a.count
  );

  const rareCount = history.filter(
    (w) => RARITY_ORDER.indexOf(w.rarity) >= RARITY_ORDER.indexOf("rare")
  ).length;

  return (
    <div className="w-full">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">Your wins</p>
        <p className="text-[11px] text-muted">
          {history.length} total{rareCount > 0 ? ` · ${rareCount} rare+` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {groups.map((g) => {
          const c = g.color ?? RARITY_COLORS[g.rarity];
          return (
            <div
              key={`${g.label}|${g.rarity}`}
              className="relative overflow-hidden rounded-2xl border p-3"
              style={{
                borderColor: `color-mix(in oklab, ${c} 45%, transparent)`,
                background: `linear-gradient(160deg, color-mix(in oklab, ${c} 14%, transparent), color-mix(in oklab, ${c} 4%, transparent))`,
              }}
            >
              {g.count > 1 && (
                <span
                  className="absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-extrabold text-white"
                  style={{ backgroundColor: c }}
                >
                  ×{g.count}
                </span>
              )}
              <div
                className="grid h-12 w-12 place-items-center rounded-full text-2xl"
                style={{
                  background: `radial-gradient(circle at 50% 35%, color-mix(in oklab, ${c} 40%, transparent), color-mix(in oklab, ${c} 10%, transparent) 70%)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 45%, transparent)`,
                }}
              >
                {g.emoji ?? "🎁"}
              </div>
              <p className="mt-2 truncate text-sm font-bold text-ink" title={g.label}>
                {g.label}
              </p>
              <div className="mt-1 flex items-center justify-between gap-1">
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                  style={{ color: c, backgroundColor: `color-mix(in oklab, ${c} 16%, transparent)` }}
                >
                  {RARITY_LABEL[g.rarity] ?? g.rarity}
                </span>
                <span className="shrink-0 text-[10px] text-muted">{ago(g.latest)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
