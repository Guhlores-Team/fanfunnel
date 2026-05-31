"use client";

import { useState } from "react";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { WishlistItem } from "@/lib/data/types";

/**
 * Lets a fan flag prizes they're chasing. The creator sees aggregate demand.
 * Optimistic toggle backed by POST/DELETE /api/wishlists.
 */
export default function WishlistSection({
  token,
  prizes,
  initial,
}: {
  token: string;
  prizes: Prize[];
  initial: WishlistItem[];
}) {
  const [wanted, setWanted] = useState<Set<string>>(
    () => new Set(initial.map((w) => w.prizeLabel))
  );
  const [pending, setPending] = useState<Set<string>>(new Set());

  const toggle = async (label: string) => {
    if (pending.has(label)) return;
    const isWanted = wanted.has(label);
    setPending((p) => new Set(p).add(label));
    // Optimistic.
    setWanted((w) => {
      const next = new Set(w);
      if (isWanted) next.delete(label);
      else next.add(label);
      return next;
    });
    try {
      const res = await fetch("/api/wishlists", {
        method: isWanted ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, prizeLabel: label }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      // Roll back on failure.
      setWanted((w) => {
        const next = new Set(w);
        if (isWanted) next.add(label);
        else next.delete(label);
        return next;
      });
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(label);
        return next;
      });
    }
  };

  if (prizes.length === 0) return null;

  return (
    <div className="w-full">
      <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        Chasing a prize? Tap to wishlist
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {prizes.map((p) => {
          const c = p.color ?? RARITY_COLORS[p.rarity];
          const on = wanted.has(p.label);
          return (
            <button
              key={p.id}
              onClick={() => toggle(p.label)}
              aria-pressed={on}
              className="rounded-full px-3 py-1 text-xs font-semibold text-ink transition"
              style={{
                backgroundColor: on
                  ? `color-mix(in oklab, ${c} 28%, transparent)`
                  : "transparent",
                border: `1px solid color-mix(in oklab, ${c} ${on ? 70 : 30}%, transparent)`,
                opacity: pending.has(p.label) ? 0.6 : 1,
              }}
            >
              {on ? "★" : "☆"} {p.emoji ?? "🎁"} {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
