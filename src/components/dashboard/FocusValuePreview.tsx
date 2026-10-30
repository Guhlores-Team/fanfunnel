"use client";

import { useEffect, useMemo, useState } from "react";
import type { WheelConfig } from "@/lib/games/wheel/types";
import type { HappyHour } from "@/lib/data/types";
import { estimatePackValue, type PackValueOptions } from "@/lib/focus/ev";
import { MAX_COMBINED_BOOST } from "@/lib/focus/config";
import { formatCents } from "@/lib/format";
import { useNow } from "@/lib/hooks/useNow";

/** Creator-only, cents throughout. An estimate of all prizes, not a profit claim. */
export default function FocusValuePreview({ wheel, options }: { wheel: WheelConfig; options: PackValueOptions }) {
  const [loaded, setLoaded] = useState<{ wheelId: string; hours: HappyHour[]; failed: boolean } | null>(null);
  const hours = loaded?.wheelId === wheel.id ? loaded.hours : null;
  const failed = loaded?.wheelId === wheel.id && loaded.failed;
  const now = useNow(15000);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/happy-hours?wheelId=${encodeURIComponent(wheel.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json() as { happyHours?: HappyHour[] };
        if (!controller.signal.aborted) setLoaded({ wheelId: wheel.id, hours: body.happyHours ?? [], failed: false });
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ wheelId: wheel.id, hours: [], failed: true }); });
    return () => controller.abort();
  }, [wheel.id]);
  const boost = hours && now !== null ? Math.min(MAX_COMBINED_BOOST, Math.max(1, ...hours.filter((hour) => Date.parse(hour.startsAt) <= now && Date.parse(hour.endsAt) > now).map((hour) => hour.multiplier))) : null;
  const estimate = useMemo(() => {
    if (boost === null) return null;
    try { return estimatePackValue(wheel, { ...options, happyHourMultiplier: boost }); }
    catch { return null; }
  }, [wheel, options, boost]);
  if (failed) return <p role="status" className="text-xs text-muted">Expected cost is unavailable because the current boost settings could not load. Refresh before relying on a preview.</p>;
  if (!estimate) return <p role="status" className="text-xs text-muted">Loading expected prize cost…</p>;
  if (!estimate.available) return <p className="text-xs text-muted">This target is unavailable in the current pool; no reliable estimate is shown.</p>;
  return (
    <div data-testid="focus-value-preview" className={`space-y-1.5 rounded-xl border p-3 text-xs ${estimate.priceBelowExpectedCost ? "border-amber-300/35 bg-amber-300/5 text-ink" : "border-line text-muted"}`}>
      <p className="font-semibold text-ink">Expected prize cost · {estimate.spins} spins</p>
      <p>Next-spin target odds: {(estimate.baseChance * 100).toFixed(2)}% → {(estimate.boostedChance * 100).toFixed(2)}%. About {estimate.expectedAdditionalTargetWins.toFixed(2)} additional target wins across this preview.</p>
      <p data-testid="focus-total-cost">Total expected cost of all prizes: {estimate.expectedTotalCostCents === null ? "unknown — some possible prizes have no cost entered" : formatCents(Math.round(estimate.expectedTotalCostCents))}.</p>
      <p>Additional expected cost versus the ordinary pool: {estimate.expectedAdditionalCostCents === null ? "unknown" : formatCents(Math.round(estimate.expectedAdditionalCostCents))}.</p>
      {options.kind === "chase" && <p>One guaranteed target&apos;s entered cost: {estimate.guaranteedTargetCostCents === null ? "unknown" : formatCents(estimate.guaranteedTargetCostCents)}. This is separate from the other prizes won along the way.</p>}
      <p>Pack price: {formatCents(options.priceCents ?? 0)}.</p>
      {estimate.priceBelowExpectedCost && <p data-testid="focus-cost-warning" className="font-semibold text-amber-200">The pack price is below the expected prize cost{estimate.expectedTotalCostCents === null ? " that can already be established from entered costs" : ""}.</p>}
      <p>This estimate keeps the saved pool and current happy hour fixed, starts with no pity progress, and assumes entered costs are accurate. Stock, pity progress and later settings can change actual payouts. It is not a profit estimate.</p>
    </div>
  );
}

export function FocusValuePicker({ options }: { options: Omit<PackValueOptions, "prizeId"> }) {
  const [wheels, setWheels] = useState<{ id: string; title: string }[]>([]);
  const [wheelId, setWheelId] = useState("");
  const [wheel, setWheel] = useState<WheelConfig | null>(null);
  const [prizeId, setPrizeId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/wheels", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as { wheels?: { id: string; title: string }[] };
      if (!controller.signal.aborted) setWheels(body.wheels ?? []);
    }).catch(() => { if (!controller.signal.aborted) setError("Couldn't load wheels for the cost preview."); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!wheelId) return;
    const controller = new AbortController();
    fetch(`/api/wheels/${encodeURIComponent(wheelId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as { wheel?: WheelConfig };
      if (!body.wheel) throw new Error();
      if (!controller.signal.aborted) setWheel(body.wheel);
    }).catch(() => { if (!controller.signal.aborted) setError("Couldn't load this wheel for the cost preview."); });
    return () => controller.abort();
  }, [wheelId]);
  const targets = wheel?.prizes.filter((prize) => prize.boostable && (options.kind === "chase" || prize.weight > 0)) ?? [];
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-line p-3">
      <p className="text-xs text-muted">Choose a saved prize to preview this pack&apos;s cost. You choose the actual target when granting the pack.</p>
      <label className="block text-xs text-muted">Preview wheel<select data-testid="focus-preview-wheel" className="ff-input mt-1 w-full" value={wheelId} onChange={(e) => { setWheelId(e.target.value); setWheel(null); setPrizeId(""); setError(""); }}><option value="">Choose a wheel</option>{wheels.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      {wheel && <label className="block text-xs text-muted">Preview prize<select data-testid="focus-preview-prize" className="ff-input mt-1 w-full" value={prizeId} onChange={(e) => setPrizeId(e.target.value)}><option value="">Choose a Boostable prize</option>{targets.map((prize) => <option key={prize.id} value={prize.id}>{prize.emoji} {prize.label}{prize.stock === 0 ? " · sold out" : ""}</option>)}</select></label>}
      {wheel && targets.length === 0 && <p className="text-xs text-muted">Mark a saved prize Boostable in the wheel editor to estimate a Focus pack.</p>}
      {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
      {wheel && prizeId && <FocusValuePreview wheel={wheel} options={{ ...options, prizeId }} />}
    </div>
  );
}
