"use client";

import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS, RARITY_ORDER } from "@/lib/games/wheel/types";
import type { WonPrize } from "@/lib/data/types";
import { externalUrl } from "@/lib/format";

/**
 * The highest-intent moment in the funnel: the fan just hit 0 spins. Instead of
 * a dead "out of spins" line, we tease the best prize they HAVEN'T won yet and
 * give them a direct path to top up. Honest, celebratory, not loss-framed.
 */
export default function TopUpMoment({
  prizes,
  history,
  creatorTitle,
  tipUrl,
}: {
  prizes: Prize[];
  history: WonPrize[];
  creatorTitle: string;
  tipUrl?: string | null;
}) {
  const wonLabels = new Set(history.map((w) => w.label));
  // The rarest prize the fan hasn't won yet (descending rarity).
  const target = [...prizes]
    .filter((p) => !wonLabels.has(p.label))
    .sort(
      (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
    )[0];

  const color = target ? target.color ?? RARITY_COLORS[target.rarity] : "var(--brand)";

  return (
    <div
      className="reveal w-full rounded-2xl border p-5 text-center"
      style={{
        borderColor: "color-mix(in oklab, var(--brand) 50%, transparent)",
        background: "color-mix(in oklab, var(--brand) 10%, transparent)",
      }}
    >
      <p className="text-sm font-extrabold text-ink">Out of spins! 💖</p>
      {target ? (
        <p className="mt-1 text-sm text-muted text-pretty">
          You still haven&rsquo;t landed{" "}
          <span className="font-bold" style={{ color }}>
            {target.emoji ?? "🎁"} {target.label}
          </span>{" "}
          — top up and chase it.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          Top up to keep spinning with {creatorTitle}.
        </p>
      )}
      {tipUrl ? (
        <a
          href={externalUrl(tipUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-brand mt-4 inline-block w-full rounded-2xl py-3 font-extrabold"
        >
          Top up with {creatorTitle} →
        </a>
      ) : (
        <p className="mt-4 text-sm font-semibold text-[var(--brand)]">
          Tip {creatorTitle} to unlock more spins.
        </p>
      )}
    </div>
  );
}
