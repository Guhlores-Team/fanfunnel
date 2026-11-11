"use client";

import { useEffect, useMemo, useState } from "react";
import type { HappyHour } from "@/lib/data/types";
import { useNow } from "@/lib/hooks/useNow";
import { MAX_COMBINED_BOOST } from "@/lib/focus/config";
import { estimateBingoValue } from "@/lib/games/bingo/ev";
import { formatCents } from "@/lib/format";
import type { CreatorGameWheel } from "./gameEditor";

const cost = (value: number | null) => value === null ? "unknown — enter all possible prize costs" : formatCents(Math.round(value));
export default function BingoValuePreview({ wheel, linePrizeId }: { wheel: CreatorGameWheel; linePrizeId: string }) {
  const [plays, setPlays] = useState(10);
  const [price, setPrice] = useState("");
  const [loaded, setLoaded] = useState<{ id: string; hours: HappyHour[]; failed: boolean } | null>(null);
  const now = useNow(15000);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/happy-hours?wheelId=${encodeURIComponent(wheel.id)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json() as { happyHours?: HappyHour[] };
      if (!controller.signal.aborted) setLoaded({ id: wheel.id, hours: data.happyHours ?? [], failed: false });
    }).catch(() => { if (!controller.signal.aborted) setLoaded({ id: wheel.id, hours: [], failed: true }); });
    return () => controller.abort();
  }, [wheel.id]);
  const boost = loaded?.id === wheel.id && !loaded.failed && now !== null ? Math.min(MAX_COMBINED_BOOST, Math.max(1, ...loaded.hours.filter((hour) => Date.parse(hour.startsAt) <= now && Date.parse(hour.endsAt) > now).map((hour) => hour.multiplier))) : null;
  const cents = price.trim() ? Math.round(Number(price) * 100) : undefined;
  const priceInvalid = cents !== undefined && (!Number.isSafeInteger(cents) || cents < 0);
  const estimate = useMemo(() => boost === null ? null : estimateBingoValue(wheel, { linePrizeId, plays, happyHourMultiplier: boost, pityCounter: 0, ...(cents !== undefined && !priceInvalid ? { priceCents: cents } : {}) }), [wheel, linePrizeId, plays, boost, cents, priceInvalid]);
  return <section data-testid="bingo-value-preview" aria-label="Approximate bingo prize cost" className="mt-3 space-y-2 rounded-xl border border-line p-3 text-xs text-muted">
    <h4 className="font-semibold text-ink">Approximate prize cost · representative new card</h4>
    <div className="grid gap-3 sm:grid-cols-2"><label>Preview plays<select className="ff-input mt-1 w-full" value={plays} onChange={(event) => setPlays(Number(event.target.value))}>{[1, 5, 10, 25, 50].map((value) => <option key={value} value={value}>{value} plays</option>)}</select></label><label>Total price for those plays ($, optional)<input className="ff-input mt-1 w-full" type="number" min={0} step="0.01" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} aria-invalid={priceInvalid || undefined} /></label></div>
    {priceInvalid && <p role="alert" className="text-amber-200">Enter a valid non-negative total price.</p>}
    {loaded?.id === wheel.id && loaded.failed ? <p role="status">Current happy-hour settings couldn&apos;t load. Refresh before relying on a cost estimate.</p> : !estimate ? <p role="status">Loading current cost assumptions…</p> : !estimate.available ? <p role="status">Finish the eligible prize pool and line settings before previewing costs.</p> : <>
      <p>Expected new lines over {estimate.plays} plays: about {estimate.expectedLines.toFixed(2)}.</p>
      <p data-testid="bingo-primary-cost">Expected cost of drawn prizes: {cost(estimate.expectedPrimaryCostCents)}.</p>
      <p data-testid="bingo-bonus-cost">Expected extra cost of line bonuses: {cost(estimate.expectedBonusCostCents)}.</p>
      <p data-testid="bingo-total-cost" className="font-semibold text-ink">Total expected prize cost: {cost(estimate.expectedTotalCostCents)}.</p>
      {estimate.priceBelowExpectedCost && <p role="status" data-testid="bingo-cost-warning" className="font-semibold text-amber-200">The entered total price is below the expected prize cost{estimate.expectedTotalCostCents === null ? " already established by known costs" : ""}.</p>}
    </>}
    <p>This uses one representative card layout, not an average of all random cards. It holds the current prize pool and happy hour fixed, starts without pity progress, and omits individual Focus or Chase packs. Stock, later settings and real cards can change the result. Entered prize costs must be accurate; revenue and profit are not forecast.</p>
  </section>;
}
