"use client";

import { useCallback, useEffect, useState } from "react";
import type { CampaignPack } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { stackPack } from "./packHelpers";
import { DEFAULT_CHASE_WITHIN, DEFAULT_FOCUS_MULTIPLIER, DEFAULT_FOCUS_SPINS } from "@/lib/focus/config";

/**
 * Read-only preset buttons for the grant / top-up flow. Fetches the packs for
 * the active campaign (refetching when `campaignId` changes) and renders a row
 * of one-tap buttons.
 *
 * Stacking (#4): clicking the SAME preset repeatedly ACCUMULATES — five taps on
 * "10 spins" hands 50 spins to `onPick` (spins, price, and bonus all scale via
 * {@link stackPack}), and the button shows a live ×N count. Tapping a DIFFERENT
 * preset switches selection and resets the running count to 1. Each call to
 * `onPick` receives accumulated totals plus an explicit unit count. The server
 * resolves each saved pack's price and credits and multiplies by that count.
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
  onModifierPick,
}: {
  campaignId: string | null;
  onPick: (pack: CampaignPack, units: number) => void;
  /** Modifier packs require a target and existing pass, never ordinary stacking. */
  onModifierPick?: (pack: CampaignPack) => void;
}) {
  const [packs, setPacks] = useState<CampaignPack[]>([]);
  const [error, setError] = useState("");
  // Which preset is currently selected, and how many times it's been tapped.
  const [picked, setPicked] = useState<{ id: string; count: number } | null>(null);

  const load = useCallback(async () => {
    const qs = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
    const res = await fetch(`/api/campaign-packs${qs}`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { packs?: CampaignPack[] };
      return data.packs ?? [];
    }
    throw new Error("packs_unavailable");
  }, [campaignId]);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when the scoped campaign changes
    setPacks([]);
    setPicked(null);
    load().then((next) => {
      if (active) { setPacks(next); setError(""); }
    }).catch(() => { if (active) setError("Saved packs couldn't load. Refresh this page before using a preset."); });
    return () => {
      active = false;
    };
  }, [load]);

  function handlePick(pack: CampaignPack) {
    if (pack.packKind && pack.packKind !== "spins") {
      if (onModifierPick) { setPicked({ id: pack.id, count: 1 }); onModifierPick(pack); }
      return;
    }
    // Same preset → stack one more unit; different preset → start fresh at 1.
    const count = picked && picked.id === pack.id ? picked.count + 1 : 1;
    setPicked({ id: pack.id, count });
    onPick(stackPack(pack, count), count);
  }

  if (error) return <p role="alert" className="text-xs text-amber-200">{error}</p>;
  if (packs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Spin pack presets">
      {packs.map((p) => {
        const active = picked?.id === p.id;
        const count = active ? picked.count : 0;
        const modifier = p.packKind === "focus" || p.packKind === "chase";
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => handlePick(p)}
            disabled={modifier && !onModifierPick}
            title={modifier && !onModifierPick ? "Open an existing fan's details to choose a target prize and a saved pass." : undefined}
            aria-pressed={active}
            className={
              "inline-flex min-h-9 max-w-full flex-wrap items-center rounded-[9px] border px-3 py-1.5 text-xs font-semibold text-ink transition-colors disabled:opacity-60 " +
              (active
                ? "border-[color-mix(in_oklab,var(--brand)_60%,transparent)] bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]"
                : "border-line hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]")
            }
          >
            <span className="font-bold">{p.label}</span>
            {modifier && <span className="ml-1.5 font-semibold">{p.packKind === "chase" ? `Chase · within ${p.chaseWithin ?? DEFAULT_CHASE_WITHIN}` : `Focus ×${p.focusMultiplier ?? DEFAULT_FOCUS_MULTIPLIER} · ${p.focusSpins ?? DEFAULT_FOCUS_SPINS} spins`}</span>}
            <span className="tnum text-muted">
              {" "}
              · {p.spins} spins · {formatCents(p.amountCents)}
              {p.bonusSpins > 0 ? ` (+${p.bonusSpins})` : ""}
            </span>
            {!modifier && count > 1 && (
              <span className="tnum ml-1.5 rounded-full bg-[var(--brand)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--brand-ink)]">
                ×{count}
              </span>
            )}
          </button>
        );
      })}
      {!onModifierPick && packs.some((pack) => pack.packKind === "focus" || pack.packKind === "chase") && <p className="basis-full text-xs text-muted">Focus and Chase packs are granted from an existing fan&apos;s details, where you choose their prize and pass.</p>}
    </div>
  );
}
