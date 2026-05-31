"use client";

import { useEffect, useState } from "react";
import type {
  CohortRow,
  EngagementHeatmap,
  PrizeRoiRow,
} from "@/lib/data/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { formatCents } from "@/lib/format";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Phase 4 deeper analytics: a best-time engagement heatmap, prize ROI, and
 * cohort retention. All read-light and demo-safe (each endpoint falls back to
 * the in-memory mock when Supabase is absent).
 */
export default function AnalyticsPanel() {
  return (
    <div className="space-y-8">
      <HeatmapCard />
      <PrizeRoiCard />
      <CohortCard />
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function HeatmapCard() {
  const [heatmap, setHeatmap] = useState<EngagementHeatmap | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/analytics/heatmap?days=90", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { heatmap: null }))
      .then((d) => live && setHeatmap(d.heatmap ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Index cells by weekday*24+hour for a stable lookup.
  const byKey = new Map<number, number>();
  for (const c of heatmap?.cells ?? [])
    byKey.set(c.weekday * 24 + c.hour, c.count);
  const max = heatmap?.max ?? 0;

  return (
    <Section
      title="Best-time heatmap"
      hint="When fans spin, by hour of day (UTC). Darker = busier."
    >
      <div className="card overflow-x-auto p-4">
        <div className="min-w-[640px]">
          {/* Hour labels (every 3 hours). */}
          <div className="mb-1 flex gap-px pl-10">
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                className="tnum flex-1 text-center text-[10px] text-muted"
              >
                {hour % 3 === 0 ? hour : ""}
              </div>
            ))}
          </div>
          {WEEKDAYS.map((label, weekday) => (
            <div key={weekday} className="flex items-center gap-px">
              <div className="w-10 shrink-0 pr-2 text-right text-[11px] text-muted">
                {label}
              </div>
              {Array.from({ length: 24 }, (_, hour) => {
                const count = byKey.get(weekday * 24 + hour) ?? 0;
                const opacity = max > 0 ? count / max : 0;
                return (
                  <div
                    key={hour}
                    title={`${label} ${String(hour).padStart(2, "0")}:00 UTC — ${count} spin${count === 1 ? "" : "s"}`}
                    className="aspect-square flex-1 rounded-[2px] border border-line"
                    style={{
                      backgroundColor:
                        count > 0
                          ? `color-mix(in srgb, var(--brand) ${Math.round(15 + opacity * 85)}%, transparent)`
                          : "transparent",
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function PrizeRoiCard() {
  const [rows, setRows] = useState<PrizeRoiRow[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/analytics/roi?days=90", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => live && setRows(d.rows ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section
      title="Prize ROI"
      hint="What each prize is costing you, based on wins in the last 90 days."
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No prize wins yet.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-semibold">Prize</th>
                <th className="px-4 py-2.5 font-semibold">Rarity</th>
                <th className="px-4 py-2.5 text-right font-semibold">Won</th>
                <th className="px-4 py-2.5 text-right font-semibold">
                  Cost each
                </th>
                <th className="px-4 py-2.5 text-right font-semibold">
                  Total cost
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.label}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-4 py-2.5 text-ink">{r.label}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-muted">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: RARITY_COLORS[r.rarity] }}
                      />
                      {r.rarity}
                    </span>
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-ink">
                    {r.timesWon}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-muted">
                    {r.costCents === null ? "—" : formatCents(r.costCents)}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right font-semibold text-ink">
                    {formatCents(r.totalCostCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function CohortCard() {
  const [rows, setRows] = useState<CohortRow[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/analytics/cohorts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => live && setRows(d.rows ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section
      title="Cohort retention"
      hint="Fans grouped by the campaign of their first grant, and how many came back."
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No cohorts yet.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-semibold">Cohort</th>
                <th className="px-4 py-2.5 text-right font-semibold">Fans</th>
                <th className="px-4 py-2.5 text-right font-semibold">
                  Returning
                </th>
                <th className="px-4 py-2.5 text-right font-semibold">
                  Repeat rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.campaignId ?? "direct"}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-4 py-2.5 text-ink">{r.campaignName}</td>
                  <td className="tnum px-4 py-2.5 text-right text-ink">
                    {r.fans}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-ink">
                    {r.returningFans}
                  </td>
                  <td className="tnum px-4 py-2.5 text-right font-semibold text-ink">
                    {Math.round(r.repeatRate * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
