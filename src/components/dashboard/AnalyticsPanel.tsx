"use client";

import type { CohortRow, EngagementHeatmap, PrizeRoiRow } from "@/lib/data/types";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import { formatCents } from "@/lib/format";
import { useFetch } from "@/lib/hooks/useFetch";
import CrmPanel from "@/components/dashboard/CrmPanel";
import Funnel from "@/components/dashboard/Funnel";
import type { ConversionState } from "@/components/dashboard/MetricsPanel";
import { heatmapIndex, heatmapStrength, shareOfRevenue } from "./analyticsHelpers";
import { CardHeader, Glyph, ICON, LoadError, StatCell, TickHeader, hairGrid, raised } from "./analyticsUi";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One-shot reads (no polling, no refetch on tab focus) — same cadence as the
// old fetch-on-mount, but through useFetch for its stale-response guard and
// an owned error state.
const ONCE = { refreshOnVisible: false } as const;

/**
 * The deeper half of Analytics, below the Command Center's designed cards:
 * profit & prize costs (designed grid + costs warning + per-prize table), then
 * the Audience group (conversion, CRM, cohorts) and Timing (best-time heatmap).
 * All endpoints fall back to the in-memory mock when Supabase is absent.
 */
export default function AnalyticsPanel({ conversion }: { conversion?: ConversionState }) {
  return (
    <div className="flex flex-col gap-10">
      <ProfitSection />

      <section aria-labelledby="an-audience">
        <TickHeader
          id="an-audience"
          title="Audience"
          hint="Who converts, who spends, and who comes back."
        />
        <div className="flex flex-col gap-[18px]">
          <CrmPanel leading={conversion && <ConversionCard {...conversion} />} />
          <CohortCard />
        </div>
      </section>

      <section aria-labelledby="an-timing">
        <TickHeader id="an-timing" title="Timing" hint="When your fans actually show up." />
        <HeatmapCard />
      </section>
    </div>
  );
}

function ConversionCard({ funnel, failed, retry }: ConversionState) {
  return (
    <section className={`rounded-2xl p-5 ${raised}`}>
      <CardHeader icon={ICON.funnel} title="Conversion" hint="Fans created → spun → fulfilled." />
      <div className="mt-4">
        {failed ? (
          <LoadError what="the funnel" onRetry={retry} />
        ) : !funnel ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-3 w-full rounded" />
            ))}
          </div>
        ) : (
          <Funnel funnel={funnel} />
        )}
      </div>
    </section>
  );
}

/** A card body that scrolls sideways on narrow screens instead of the page. */
function ScrollX({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // Focusable so keyboard users can scroll it (axe scrollable-region-focusable).
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto">
      {children}
    </div>
  );
}

const th = "px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.04em]";
const td = "px-4 py-2.5";

function HeatmapCard() {
  const { data, error, loading, reload } = useFetch<{ heatmap: EngagementHeatmap | null }>(
    "/api/analytics/heatmap?days=90",
    ONCE
  );
  const heatmap = data?.heatmap ?? null;
  const byKey = heatmapIndex(heatmap);
  const max = heatmap?.max ?? 0;

  let busiest: { weekday: number; hour: number; count: number } | null = null;
  for (const c of heatmap?.cells ?? []) if (!busiest || c.count > busiest.count) busiest = c;
  const summary =
    busiest && busiest.count > 0
      ? `Spins by weekday and hour (UTC), last 90 days. Busiest: ${WEEKDAYS[busiest.weekday]} ${String(busiest.hour).padStart(2, "0")}:00 with ${busiest.count} spin${busiest.count === 1 ? "" : "s"}.`
      : "Spins by weekday and hour (UTC), last 90 days. No spins yet.";

  return (
    <section className={`rounded-2xl p-5 ${raised}`}>
      <CardHeader
        icon={ICON.clock}
        title="Best-time heatmap"
        hint="When fans spin, by hour of day (UTC). Darker = busier."
        right={
          <div aria-hidden="true" className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted sm:flex">
            Less
            {[0, 25, 50, 75, 100].map((s) => (
              <span
                key={s}
                className="h-3 w-3 rounded-[3px]"
                style={{
                  background:
                    s === 0
                      ? "var(--s2)"
                      : `color-mix(in srgb, var(--brand) ${heatmapStrength(s, 100)}%, transparent)`,
                }}
              />
            ))}
            More
          </div>
        }
      />
      <div className="mt-4">
        {error && !data ? (
          <LoadError what="the heatmap" onRetry={() => void reload()} />
        ) : loading && !data ? (
          <div className="skeleton h-40 w-full rounded-xl" />
        ) : (
          <ScrollX label="Best-time heatmap, scrolls sideways">
            <div role="img" aria-label={summary} className="min-w-[640px] pb-1">
              {/* Hour labels (every 3 hours). */}
              <div className="mb-1 flex gap-[3px] pl-10">
                {Array.from({ length: 24 }, (_, hour) => (
                  <div key={hour} className="tnum flex-1 text-center text-[10px] text-muted">
                    {hour % 3 === 0 ? hour : ""}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-[3px]">
                {WEEKDAYS.map((label, weekday) => (
                  <div key={weekday} className="flex items-center gap-[3px]">
                    <div className="w-10 shrink-0 pr-2 text-right text-[11px] text-muted">{label}</div>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const count = byKey.get(weekday * 24 + hour) ?? 0;
                      const strength = heatmapStrength(count, max);
                      return (
                        <div
                          key={hour}
                          title={`${label} ${String(hour).padStart(2, "0")}:00 UTC — ${count} spin${count === 1 ? "" : "s"}`}
                          className="aspect-square flex-1 rounded-[3px]"
                          style={{
                            background:
                              strength > 0
                                ? `color-mix(in srgb, var(--brand) ${strength}%, transparent)`
                                : "var(--s2)",
                          }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </ScrollX>
        )}
      </div>
    </section>
  );
}

interface ProfitSummary {
  revenueCents: number;
  costCents: number;
  profitCents: number;
  marginPct: number;
  costsComplete: boolean;
}

function ProfitSection() {
  const roi = useFetch<{ rows: PrizeRoiRow[] }>("/api/analytics/roi?days=90", ONCE);
  const prof = useFetch<{ summary: ProfitSummary | null }>("/api/analytics/profit?days=90", ONCE);
  const rows = roi.data?.rows ?? [];
  const profit = prof.data?.summary ?? null;

  return (
    <section aria-labelledby="an-profit">
      <TickHeader
        id="an-profit"
        title="Profit & prize costs · 90 days"
        hint={
          <>
            Your real bottom line: revenue (what fans paid) minus prize cost (won prizes × the
            &ldquo;Cost&rdquo; you set on each in the Wheel editor) = profit. Per-prize ROI can&rsquo;t be
            exact because a fan pays for spins, not a specific prize — so the table shows each
            prize&rsquo;s cost and its share of revenue.
          </>
        }
      />

      {prof.error && !prof.data ? (
        <div className={`rounded-2xl p-5 ${raised}`}>
          <LoadError what="profit" onRetry={() => void prof.reload()} />
        </div>
      ) : prof.loading && !prof.data ? (
        <div className={`${hairGrid} grid-cols-2 sm:grid-cols-4`} aria-busy="true" aria-label="Loading profit">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-[18px] py-4 [background:var(--s2)]">
              <div className="skeleton h-6 w-16 rounded" />
              <div className="skeleton mt-2 h-3 w-12 rounded" />
            </div>
          ))}
        </div>
      ) : (
        profit && (
          <>
            <dl className={`${hairGrid} grid-cols-2 sm:grid-cols-4`}>
              <StatCell label="Revenue" value={formatCents(profit.revenueCents)} />
              <StatCell label="Prize cost" value={formatCents(profit.costCents)} />
              <StatCell label="Profit" value={formatCents(profit.profitCents)} />
              <StatCell label="Margin" value={`${Math.round(profit.marginPct * 100)}%`} />
            </dl>
            {!profit.costsComplete && (
              <p className="mt-2.5 flex items-start gap-2 rounded-xl border border-[#f59e0b]/25 bg-[#f59e0b]/10 px-3.5 py-2.5 text-xs text-[#fcd34d]">
                <Glyph d={ICON.alert} size={15} className="mt-px" />
                <span>
                  Some won prizes have no cost set, so cost (and profit) is understated. Set a Cost on
                  each prize in the Wheel editor for an exact figure.
                </span>
              </p>
            )}
          </>
        )
      )}

      <section className={`mt-[18px] rounded-2xl ${raised}`}>
        <div className="p-5 pb-4">
          <CardHeader icon={ICON.gift} title="Prize ROI" hint="Each prize's fulfilment cost and its share of revenue." />
        </div>
        {roi.error && !roi.data ? (
          <div className="px-5 pb-5">
            <LoadError what="prize costs" onRetry={() => void roi.reload()} />
          </div>
        ) : roi.loading && !roi.data ? (
          <div className="space-y-2.5 px-5 pb-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-4 w-full rounded" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted">No prize wins yet.</p>
        ) : (
          <ScrollX label="Prize ROI table, scrolls sideways">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-y border-[var(--hair)] text-left text-muted [background:var(--s2)]">
                  <th scope="col" className={th}>Prize</th>
                  <th scope="col" className={th}>Rarity</th>
                  <th scope="col" className={`${th} text-right`}>Won</th>
                  <th scope="col" className={`${th} text-right`}>Cost each</th>
                  <th scope="col" className={`${th} text-right`}>Total cost</th>
                  <th scope="col" className={`${th} text-right`}>% of revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hair)]">
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td className={`${td} text-ink`}>{r.label}</td>
                    <td className={td}>
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: RARITY_COLORS[r.rarity] }}
                        />
                        {RARITY_LABEL[r.rarity] ?? r.rarity}
                      </span>
                    </td>
                    <td className={`tnum ${td} text-right text-ink`}>{r.timesWon}</td>
                    <td className={`tnum ${td} text-right text-muted`}>
                      {r.costCents === null ? "—" : formatCents(r.costCents)}
                    </td>
                    <td className={`tnum ${td} text-right font-semibold text-ink`}>
                      {formatCents(r.totalCostCents)}
                    </td>
                    <td className={`tnum ${td} text-right text-muted`}>
                      {shareOfRevenue(r.totalCostCents, profit?.revenueCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        )}
      </section>
    </section>
  );
}

function CohortCard() {
  const { data, error, loading, reload } = useFetch<{ rows: CohortRow[] }>("/api/analytics/cohorts", ONCE);
  const rows = data?.rows ?? [];

  return (
    <section className={`rounded-2xl ${raised}`}>
      <div className="p-5 pb-4">
        <CardHeader
          icon={ICON.repeat}
          title="Cohort retention"
          hint="Fans grouped by the campaign of their first grant, and how many came back."
        />
      </div>
      {error && !data ? (
        <div className="px-5 pb-5">
          <LoadError what="cohorts" onRetry={() => void reload()} />
        </div>
      ) : loading && !data ? (
        <div className="space-y-2.5 px-5 pb-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-4 w-full rounded" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">No cohorts yet.</p>
      ) : (
        <ScrollX label="Cohort retention table, scrolls sideways">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-y border-[var(--hair)] text-left text-muted [background:var(--s2)]">
                <th scope="col" className={th}>Cohort</th>
                <th scope="col" className={`${th} text-right`}>Fans</th>
                <th scope="col" className={`${th} text-right`}>Returning</th>
                <th scope="col" className={`${th} text-right`}>Repeat rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hair)]">
              {rows.map((r) => (
                <tr key={r.campaignId ?? "direct"}>
                  <td className={`${td} text-ink`}>{r.campaignName}</td>
                  <td className={`tnum ${td} text-right text-ink`}>{r.fans}</td>
                  <td className={`tnum ${td} text-right text-ink`}>{r.returningFans}</td>
                  <td className={`tnum ${td} text-right font-semibold text-ink`}>
                    {Math.round(r.repeatRate * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      )}
    </section>
  );
}
