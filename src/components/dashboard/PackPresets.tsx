"use client";

import { useCallback, useEffect, useState } from "react";
import type { CampaignPack } from "@/lib/data/types";
import { formatCents } from "@/lib/format";

/**
 * Read-only preset buttons for the grant / top-up flow. Fetches the packs for
 * the active campaign (refetching when `campaignId` changes) and renders a row
 * of one-tap buttons. Clicking a button hands the full pack to `onPick`.
 * Renders nothing when there are no packs to offer.
 *
 * Props:
 *   campaignId   campaign to scope packs to, or null for global presets
 *   onPick(pack) called with the chosen pack
 */
export default function PackPresets({
  campaignId,
  onPick,
}: {
  campaignId: string | null;
  onPick: (pack: CampaignPack) => void;
}) {
  const [packs, setPacks] = useState<CampaignPack[]>([]);

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
    load().then((next) => {
      if (active) setPacks(next);
    });
    return () => {
      active = false;
    };
  }, [load]);

  if (packs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Spin pack presets">
      {packs.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
        >
          <span className="font-bold">{p.label}</span>
          <span className="tnum text-muted">
            {" "}
            · {p.spins} spins · {formatCents(p.amountCents)}
            {p.bonusSpins > 0 ? ` (+${p.bonusSpins})` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
