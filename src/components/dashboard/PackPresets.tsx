"use client";

import { useCallback, useEffect, useState } from "react";
import type { CampaignPack } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { stackPack } from "./packHelpers";

/**
 * Read-only preset buttons for the grant / top-up flow. Fetches the packs for
 * the active campaign (refetching when `campaignId` changes) and renders a row
 * of one-tap buttons.
 *
 * Stacking (#4): clicking the SAME preset repeatedly ACCUMULATES — five taps on
 * "10 spins" hands 50 spins to `onPick` (spins, price, and bonus all scale via
 * {@link stackPack}), and the button shows a live ×N count. Tapping a DIFFERENT
 * preset switches selection and resets the running count to 1. Each call to
 * `onPick` still receives a single `CampaignPack`-shaped object (with the
 * accumulated totals), so callers need no changes.
 *
 * Renders nothing when there are no packs to offer.
 *
 * Props:
 *   campaignId   campaign to scope packs to, or null for global presets
 *   onPick(pack) called with the chosen pack (accumulated when re-tapped)
 */
export default function PackPresets({
  campaignId,
  onPick,
}: {
  campaignId: string | null;
  onPick: (pack: CampaignPack) => void;
}) {
  const [packs, setPacks] = useState<CampaignPack[]>([]);
  // Which preset is currently selected, and how many times it's been tapped.
  const [picked, setPicked] = useState<{ id: string; count: number } | null>(null);

  const load = useCallback(async () => {
    const qs = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
    const res = await fetch(`/api/campaign-packs${qs}`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { packs?: CampaignPack[] };
      return data.packs ?? [];
    }
    return [];
  }, [campaignId]);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when the scoped campaign changes
    setPacks([]);
    setPicked(null);
    load().then((next) => {
      if (active) setPacks(next);
    });
    return () => {
      active = false;
    };
  }, [load]);

  function handlePick(pack: CampaignPack) {
    // Same preset → stack one more unit; different preset → start fresh at 1.
    const count = picked && picked.id === pack.id ? picked.count + 1 : 1;
    setPicked({ id: pack.id, count });
    onPick(stackPack(pack, count));
  }

  if (packs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Spin pack presets">
      {packs.map((p) => {
        const active = picked?.id === p.id;
        const count = active ? picked.count : 0;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => handlePick(p)}
            aria-pressed={active}
            className={
              "rounded-lg border px-3 py-1.5 text-xs font-semibold text-ink transition " +
              (active
                ? "border-[var(--brand)]/60 bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]"
                : "border-line hover:bg-white/5")
            }
          >
            <span className="font-bold">{p.label}</span>
            <span className="tnum text-muted">
              {" "}
              · {p.spins} spins · {formatCents(p.amountCents)}
              {p.bonusSpins > 0 ? ` (+${p.bonusSpins})` : ""}
            </span>
            {count > 1 && (
              <span className="tnum ml-1.5 rounded-full bg-[var(--brand)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--brand-ink,#fff)]">
                ×{count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
