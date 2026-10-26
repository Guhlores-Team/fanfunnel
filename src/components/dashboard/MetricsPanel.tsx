"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import type { ConversionFunnel, CreatorMetricsExtra, CreatorOverview } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { useFetch } from "@/lib/hooks/useFetch";
import Sparkline from "@/components/dashboard/Sparkline";
import { EmptyState } from "./ui";
import type { Tab } from "@/components/dashboard/DashboardShell";
import { summarizeWins } from "./analyticsHelpers";
import { CardHeader, LoadError, StatCell, hairGrid, raised } from "./analyticsUi";

// Enhanced metrics (spin trend + conversion funnel), polled like the overview
// and refetched whenever the selected window (`days`) changes.
function useMetricsExtra(days: number) {
  const { data, loading, error, reload } = useFetch<CreatorMetricsExtra>(
    `/api/metrics?days=${days}`,
    { pollMs: 12000 }
  );
  return { data, loading, error, reload };
}

/** The conversion funnel lives with the Audience group (AnalyticsPanel) but is
 *  read from this panel's polled /api/metrics, so it's handed down. */
export interface ConversionState {
  funnel: ConversionFunnel | null;
  failed: boolean;
  retry: () => void;
}

// ---------------------------------------------------------------------------
// Analytics — the Command Center's designed half: stat strip, the two trends,
// what's landing + rarity mix. `renderDeep` renders the rest of the section
// (profit, audience, timing) below it, in this order.
// ---------------------------------------------------------------------------
export default function MetricsPanel({
  overview,
  loading,
  onGoTo,
  renderDeep,
}: {
  overview: CreatorOverview | null;
  loading: boolean;
  onGoTo: (t: Tab) => void;
  renderDeep?: (conversion: ConversionState) => ReactNode;
}) {
  const m = overview?.metrics;
  const reds = useMemo(() => overview?.redemptions ?? [], [overview]);
  const [days, setDays] = useState(14);
  const { data: extra, loading: extraLoading, error: extraError, reload } = useMetricsExtra(days);

  const { topPrizes, rarityMix } = useMemo(() => summarizeWins(reds), [reds]);

  const stats = [
    { label: "Fans", value: m?.fans ?? 0 },
    { label: "Revenue", value: formatCents(m?.revenue ?? 0) },
    { label: "Spins played", value: m?.spinsPlayed ?? 0 },
    { label: "To fulfil", value: m?.pending ?? 0 },
    { label: "Delivered", value: m?.fulfilled ?? 0 },
  ];
  const totalWins = reds.length;
  const extraFailed = !!extraError && !extra;
  const deep = renderDeep?.({
    funnel: extraLoading ? null : (extra?.funnel ?? null),
    failed: extraFailed,
    retry: () => void reload(),
  });

  // `deep` always sits at the same child position, so the overview finishing
  // its first load doesn't remount (and refetch) the profit/CRM/cohort cards.
  if (loading) return <Stack top={<MetricsSkeleton />} deep={deep} />;

  if (totalWins === 0 && (m?.fans ?? 0) === 0) {
    return (
      <Stack
        top={
          <EmptyState
            title="No activity yet"
            body="Create a fan account and send the link. As fans spin, you'll see what's landing here."
            action={{ label: "Create a fan link", onClick: () => onGoTo("fans") }}
          />
        }
        deep={deep}
      />
    );
  }

  const trendBody = (chart: ReactNode) =>
    extraFailed ? (
      <LoadError what="this trend" onRetry={() => void reload()} />
    ) : extraLoading || !extra ? (
      <div className="skeleton h-14 w-full rounded" />
    ) : (
      chart
    );

  const top = (
    <div className="flex flex-col gap-7">
      <section aria-label="Key numbers" className="flex flex-col gap-2">
        {/* Stat strip: hairline grid of recessed, tabular cells. */}
        <dl className={`${hairGrid} grid-cols-2 sm:grid-cols-5`}>
          {stats.map((s, i) => (
            <StatCell
              key={s.label}
              label={s.label}
              value={s.value}
              big
              className={i === stats.length - 1 ? "col-span-2 sm:col-span-1" : ""}
            />
          ))}
        </dl>
        <p className="flex items-center gap-2 text-xs text-muted">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
          Updates live as fans spin.
        </p>
      </section>

      <div className="grid gap-[18px] lg:grid-cols-2">
        {/* Spins trend — the 14d/30d window drives both trend cards. */}
        <section className={`rounded-2xl p-5 ${raised}`}>
          <CardHeader
            title="Spins trend"
            right={
              <div role="group" aria-label="Trend window (days)"className="flex shrink-0 gap-1">
                {([14, 30] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    aria-pressed={days === d}
                    className={`tnum rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                      days === d
                        ? "bg-[var(--brand)] text-[var(--brand-ink)]"
                        : "border border-line text-muted hover:text-ink"
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            }
          />
          <div className="mt-4">{trendBody(extra && <Sparkline data={extra.trend} />)}</div>
        </section>

        <section className={`rounded-2xl p-5 ${raised}`}>
          <CardHeader
            title="Revenue trend"
            right={
              !extraLoading && extra ? (
                <span className="tnum shrink-0 text-sm font-bold text-ink">
                  {formatCents(extra.revenueTrend.reduce((s, d) => s + d.cents, 0))}
                </span>
              ) : undefined
            }
          />
          <div className="mt-4">
            {trendBody(
              extra && (
                <Sparkline
                  data={extra.revenueTrend.map((d) => ({ date: d.date, spins: d.cents }))}
                  format={formatCents}
                  noun="Revenue"
                  color="#22c55e"
                />
              )
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <section className={`rounded-2xl p-5 ${raised}`}>
          <CardHeader title={<>What&rsquo;s landing</>} hint="Most-won prizes across recent spins." />
          <ul className="mt-4 flex flex-col gap-[11px]">
            {topPrizes.length === 0 && <li className="text-sm text-muted">No spins yet.</li>}
            {topPrizes.map((p) => {
              const pct = totalWins ? (p.count / totalWins) * 100 : 0;
              return (
                <li key={p.label} className="flex items-center gap-3" title={`${p.label}: ${p.count} won (${RARITY_LABEL[p.rarity]})`}>
                  <span className="w-[120px] shrink-0 truncate text-[13.5px] text-ink">
                    {p.emoji ?? "🎁"} {p.label}
                  </span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(6, pct)}%`, backgroundColor: RARITY_COLORS[p.rarity] }}
                    />
                  </div>
                  <span className="tnum w-[22px] shrink-0 text-right text-[13.5px] font-semibold text-muted">
                    {p.count}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className={`rounded-2xl p-5 ${raised}`}>
          <CardHeader title="Rarity mix" hint="How rare the wins skew." />
          {rarityMix.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No wins yet.</p>
          ) : (
            <>
              {/* 2px surface gaps between segments so adjacent rarities never
                  touch (blue/purple are close under deutan CVD); the legend
                  below carries identity in text. */}
              <div
                role="img"
                aria-label={`Rarity mix: ${rarityMix.map((x) => `${RARITY_LABEL[x.rarity]} ${x.count}`).join(", ")}`}
                className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full"
              >
                {rarityMix.map((x) => (
                  <div
                    key={x.rarity}
                    style={{
                      width: `${(x.count / totalWins) * 100}%`,
                      backgroundColor: RARITY_COLORS[x.rarity],
                    }}
                    title={`${RARITY_LABEL[x.rarity]}: ${x.count}`}
                  />
                ))}
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {rarityMix.map((x) => (
                  <li key={x.rarity} className="flex items-center gap-2 text-[13.5px]">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: RARITY_COLORS[x.rarity] }}
                    />
                    <span className="truncate text-muted">{RARITY_LABEL[x.rarity]}</span>
                    <span className="tnum ml-auto font-semibold text-ink">{x.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
  return <Stack top={top} deep={deep} />;
}

function Stack({ top, deep }: { top: ReactNode; deep: ReactNode }) {
  return (
    <div className="flex flex-col gap-7">
      {top}
      {deep}
    </div>
  );
}

function MetricsSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-label="Loading analytics">
      <div className={`${hairGrid} grid-cols-2 sm:grid-cols-5`}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`px-[18px] py-[18px] [background:var(--s2)] ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
            <div className="skeleton h-7 w-12 rounded" />
            <div className="skeleton mt-2 h-3 w-16 rounded" />
          </div>
        ))}
      </div>
      <div className="grid gap-[18px] lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={`rounded-2xl p-5 ${raised}`}>
            <div className="skeleton h-4 w-32 rounded" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="skeleton h-3 w-full rounded" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
