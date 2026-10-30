import type { PublicPrize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { isPublicPrizeAvailable } from "@/lib/games/wheel/publicView";
import { isLowStock, limitedRowPrizes, stockLabel } from "./stockDisplay";

/**
 * RM-2 · the slim "Limited" row under the wheel: one chip per limited prize
 * with its real count ("📸 Signed Polaroid · 3 left"), or "Claimed ✨" once it
 * is gone. Renders nothing when the wheel hides its stock (no counts arrive).
 */
export default function LimitedStockRow({ prizes }: { prizes: PublicPrize[] }) {
  const { shown, more } = limitedRowPrizes(prizes);
  if (shown.length === 0) return null;

  return (
    <section aria-labelledby="limited-stock-title" className="w-full" data-testid="limited-stock">
      <h2
        id="limited-stock-title"
        className="mb-2 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted"
      >
        Limited
      </h2>
      <ul className="flex flex-wrap justify-center gap-2">
        {shown.map((p) => {
          const c = p.color ?? RARITY_COLORS[p.rarity];
          const gone = !isPublicPrizeAvailable(p);
          const low = isLowStock(p);
          return (
            <li
              key={p.id}
              data-testid="stock-chip"
              data-sold-out={gone ? "true" : undefined}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                gone ? "border-line text-muted" : "font-semibold text-ink"
              }`}
              style={
                gone
                  ? undefined
                  : {
                      borderColor: `color-mix(in oklab, ${c} ${low ? 75 : 50}%, transparent)`,
                      backgroundColor: `color-mix(in oklab, ${c} ${low ? 22 : 14}%, transparent)`,
                    }
              }
            >
              <span aria-hidden="true">{p.emoji ?? "🎁"}</span>
              <span className="min-w-0 truncate">{p.label}</span>
              <span aria-hidden="true">·</span>
              <span className={`tnum shrink-0 whitespace-nowrap${low ? " font-extrabold" : ""}`}>
                {stockLabel(p)}
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <p className="mt-2 text-center text-[11px] text-muted">
          +{more} more in the prize book
        </p>
      )}
    </section>
  );
}
