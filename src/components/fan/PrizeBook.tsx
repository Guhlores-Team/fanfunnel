"use client";

import { useState } from "react";
import type { PublicPrize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { WonPrize } from "@/lib/data/types";
import { isPublicPrizeAvailable } from "@/lib/games/wheel/publicView";
import { hasStockToShow, stockLabel } from "./stockDisplay";
import type { FanFocusView, FanOddsView } from "@/lib/data/focusView";

/**
 * The fan's "prize book": every prize on the wheel, marked won / not-yet, with
 * honest stock counts on limited prizes. Collection psychology — "gotta get them
 * all" — without any fake scarcity. Collapsed by default to keep the wheel hero.
 * RM-2: counts appear only when the wheel shows stock; a sold-out prize reads
 * "Claimed ✨" either way (it has 0% odds, see isPublicPrizeAvailable).
 */
export default function PrizeBook({
  prizes,
  history,
  focus = null,
  odds,
}: {
  prizes: PublicPrize[];
  history: WonPrize[];
  focus?: FanFocusView | null;
  odds?: FanOddsView;
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
          <p className="col-span-2 text-xs text-muted" data-testid="fan-odds-note">
            {odds?.chaseForced ? "Your chase guarantee applies to the next eligible spin." : odds?.pityForced ? "Your rare-prize guarantee applies to your next spin." : "Current odds for your next spin; creator edits can change them before you play."}
          </p>
          {prizes.map((p) => {
            const won = wonLabels.has(p.label);
            const target = focus?.prizeId === p.id && (focus.status === "active" || focus.status === "paused");
            const chance = odds?.rows.find(row => row.prizeId === p.id)?.chance;
            const c = p.color ?? RARITY_COLORS[p.rarity];
            const limited = hasStockToShow(p);
            const soldOut = !isPublicPrizeAvailable(p);
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
                }}
                data-testid="prize-book-item"
                data-prize-id={p.id}
                data-focus-target={String(target)}
              >
                {/* Dim only the icon: dimmed text would fail AA contrast. */}
                <span className="text-lg" aria-hidden="true" style={{ opacity: soldOut && !won ? 0.5 : 1 }}>
                  {won ? p.emoji ?? "🎁" : "❔"}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-ink">
                    {won || target ? p.label : "Not yet…"}
                  </p>
                  {target && <p className="text-xs font-semibold text-[var(--brand-text)]">{focus?.kind === "chase" ? "Chase target" : "Focus target"}</p>}
                  <p className="tnum text-xs text-muted" data-testid="fan-prize-odds">{typeof chance === "number" && Number.isFinite(chance) && chance >= 0 && chance <= 1 ? `${(chance * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}% chance` : "Odds unavailable"}</p>
                  {limited && (
                    <p className="tnum text-[10px] text-muted">{stockLabel(p)}</p>
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
