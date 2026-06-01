"use client";

import { useState } from "react";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { WonPrize } from "@/lib/data/types";

/**
 * The fan's "prize book": every prize on the wheel, marked won / not-yet, with
 * honest stock counts on limited prizes. Collection psychology — "gotta get them
 * all" — without any fake scarcity. Collapsed by default to keep the wheel hero.
 */
export default function PrizeBook({
  prizes,
  history,
}: {
  prizes: Prize[];
  history: WonPrize[];
}) {
  const [open, setOpen] = useState(false);
  if (prizes.length === 0) return null;

  const wonLabels = new Set(history.map((w) => w.label));
  const wonCount = prizes.filter((p) => wonLabels.has(p.label)).length;

  return (
    <div className="w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-2xl border border-line bg-surface/60 px-4 py-3"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold text-ink">
          📖 Prize book
          <span className="ml-2 text-xs font-normal text-muted">
            {wonCount}/{prizes.length} collected
          </span>
        </span>
        <span className="text-sm text-muted">{open ? "Hide ▲" : "Show ▼"}</span>
      </button>

      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {prizes.map((p) => {
            const won = wonLabels.has(p.label);
            const c = p.color ?? RARITY_COLORS[p.rarity];
            const limited = typeof p.stock === "number";
            const soldOut = limited && (p.stock as number) <= 0;
            return (
              <div
                key={p.id}
                className="flex items-center gap-2 rounded-xl border px-3 py-2"
                style={{
                  borderColor: won
                    ? `color-mix(in oklab, ${c} 55%, transparent)`
                    : "var(--color-line)",
                  background: won
                    ? `color-mix(in oklab, ${c} 12%, transparent)`
                    : "transparent",
                  opacity: soldOut && !won ? 0.5 : 1,
                }}
              >
                <span className="text-lg">{won ? p.emoji ?? "🎁" : "❔"}</span>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-ink">
                    {won ? p.label : "Not yet…"}
                  </p>
                  {limited && (
                    <p className="text-[10px] text-muted">
                      {soldOut ? "Claimed ✨" : `${p.stock} left`}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
