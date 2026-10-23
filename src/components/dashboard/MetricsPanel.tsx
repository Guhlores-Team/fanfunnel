"use client";

import { useMemo, useState } from "react";
import { RARITY_COLORS, RARITY_LABEL, RARITY_ORDER, type Rarity } from "@/lib/games/wheel/types";
import type { CreatorMetricsExtra, CreatorOverview } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { useFetch } from "@/lib/hooks/useFetch";
import Sparkline from "@/components/dashboard/Sparkline";
import Funnel from "@/components/dashboard/Funnel";
import { EmptyState } from "./ui";
import type { Tab } from "@/components/dashboard/DashboardShell";

// Enhanced metrics (spin trend + conversion funnel), polled like the overview
// and refetched whenever the selected window (`days`) changes.
function useMetricsExtra(days: number) {
  const { data, loading } = useFetch<CreatorMetricsExtra>(
    `/api/metrics?days=${days}`,
    { pollMs: 12000 }
  );
  return { data, loading };
}

// ---------------------------------------------------------------------------
// Metrics — a real read on what's working, not four vanity numbers.
// ---------------------------------------------------------------------------
export default function MetricsPanel({
  overview,
  loading,
  onGoTo,
}: {
  overview: CreatorOverview | null;
  loading: boolean;
  onGoTo: (t: Tab) => void;
}) {
  const m = overview?.metrics;
  const reds = useMemo(() => overview?.redemptions ?? [], [overview]);
  const [days, setDays] = useState(14);
  const { data: extra, loading: extraLoading } = useMetricsExtra(days);

  const { topPrizes, rarityMix } = useMemo(() => {
    const prizeMap = new Map<string, { label: string; count: number; emoji?: string; rarity: Rarity }>();
    const rarity = new Map<Rarity, number>();
    for (const r of reds) {
      const key = r.prizeLabel;
      const cur = prizeMap.get(key);
      if (cur) cur.count += 1;
      else prizeMap.set(key, { label: r.prizeLabel, count: 1, emoji: r.emoji, rarity: r.rarity });
      rarity.set(r.rarity, (rarity.get(r.rarity) ?? 0) + 1);
    }
    return {
      topPrizes: [...prizeMap.values()].sort((a, b) => b.count - a.count).slice(0, 6),
      rarityMix: RARITY_ORDER.map((r) => ({ rarity: r, count: rarity.get(r) ?? 0 })).filter((x) => x.count > 0),
    };
  }, [reds]);

  const stats = [
    { label: "Fans", value: m?.fans ?? 0 },
    { label: "Revenue", value: formatCents(m?.revenue ?? 0) },
    { label: "Spins played", value: m?.spinsPlayed ?? 0 },
    { label: "To fulfil", value: m?.pending ?? 0 },
    { label: "Delivered", value: m?.fulfilled ?? 0 },
  ];
  const totalWins = reds.length;

  if (loading) return <MetricsSkeleton />;

  if (totalWins === 0 && (m?.fans ?? 0) === 0) {
    return (
      <EmptyState
        title="No activity yet"
        body="Create a fan account and send the link. As fans spin, you'll see what's landing here."
        action={{ label: "Create a fan link", onClick: () => onGoTo("fans") }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Compact stat row (hairline-divided, tabular). */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="bg-base px-4 py-4">
            <dd className="tnum text-2xl font-bold text-ink">{s.value}</dd>
            <dt className="mt-0.5 text-xs font-medium uppercase tracking-wide text-muted">
              {s.label}
            </dt>
          </div>
        ))}
      </dl>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Spins trend */}
        <section className="card rounded-xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Spins trend</h3>
              <p className="mt-0.5 text-xs text-muted">Daily spins over time.</p>
            </div>
            <div className="flex shrink-0 gap-1">
              {([14, 30] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                    days === d
                      ? "bg-[var(--brand)] text-white"
                      : "border border-line text-muted hover:text-ink"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            {extraLoading || !extra ? (
              <div className="skeleton h-14 w-full rounded" />
            ) : (
              <Sparkline data={extra.trend} />
            )}
          </div>
        </section>

        {/* Revenue trend */}
        <section className="card rounded-xl p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Revenue trend</h3>
              <p className="mt-0.5 text-xs text-muted">Daily revenue over time.</p>
            </div>
            {!extraLoading && extra && (
              <span className="tnum shrink-0 text-sm font-bold text-ink">
                {formatCents(extra.revenueTrend.reduce((s, d) => s + d.cents, 0))}
              </span>
            )}
          </div>
          <div className="mt-4">
            {extraLoading || !extra ? (
              <div className="skeleton h-14 w-full rounded" />
            ) : (
              <Sparkline
                data={extra.revenueTrend.map((d) => ({ date: d.date, spins: d.cents }))}
                format={formatCents}
                noun="Revenue"
              />
            )}
          </div>
        </section>

        {/* Conversion */}
        <section className="card rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ink">Conversion</h3>
          <p className="mt-0.5 text-xs text-muted">Fans created → spun → fulfilled.</p>
          <div className="mt-4">
            {extraLoading || !extra ? (
              <div className="space-y-2.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="skeleton h-3 w-full rounded" />
                ))}
              </div>
            ) : (
              <Funnel funnel={extra.funnel} />
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* What's landing */}
        <section className="card rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ink">What&rsquo;s landing</h3>
          <p className="mt-0.5 text-xs text-muted">Most-won prizes across recent spins.</p>
          <div className="mt-4 space-y-2.5">
            {topPrizes.length === 0 && <p className="text-sm text-muted">No spins yet.</p>}
            {topPrizes.map((p) => {
              const pct = totalWins ? (p.count / totalWins) * 100 : 0;
              const c = RARITY_COLORS[p.rarity];
              return (
                <div key={p.label} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-sm text-ink">
                    {p.emoji ?? "🎁"} {p.label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(6, pct)}%`, backgroundColor: c }}
                    />
                  </div>
                  <span className="tnum w-6 shrink-0 text-right text-sm font-semibold text-muted">
                    {p.count}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Rarity mix */}
        <section className="card rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ink">Rarity mix</h3>
          <p className="mt-0.5 text-xs text-muted">How rare the wins skew.</p>
          {rarityMix.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No wins yet.</p>
          ) : (
            <>
              <div className="mt-4 flex h-3 overflow-hidden rounded-full">
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
              <div className="mt-4 grid grid-cols-2 gap-2">
                {rarityMix.map((x) => (
                  <div key={x.rarity} className="flex items-center gap-2 text-sm">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: RARITY_COLORS[x.rarity] }}
                    />
                    <span className="text-muted">{RARITY_LABEL[x.rarity]}</span>
                    <span className="tnum ml-auto font-semibold text-ink">{x.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      <p className="text-xs text-muted">Updates live as fans spin.</p>
    </div>
  );
}

function MetricsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-base px-4 py-4">
            <div className="skeleton h-7 w-12 rounded" />
            <div className="skeleton mt-2 h-3 w-16 rounded" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card rounded-xl p-5">
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
