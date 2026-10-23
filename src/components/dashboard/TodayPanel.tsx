"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { useFetch } from "@/lib/hooks/useFetch";
import { formatCents } from "@/lib/format";
import type { CreatorMetricsExtra, CreatorOverview } from "@/lib/data/types";
import {
  centSeries,
  impactTag,
  lastValue,
  oldestPendingAge,
  sparkPoints,
  spinSeries,
  trendVsAvg,
  trendVsYesterday,
  type ImpactTag,
  type Trend,
} from "./todayHelpers";

interface Action {
  kind: string;
  fanId?: string;
  token?: string | null;
  weekday?: number;
  hour?: number;
}
interface Card {
  key: string;
  icon: string;
  title: string;
  body: string;
  cta: string;
  action: Action;
  score: number;
}

// 24×24 stroke paths (Command Center prototype line icons).
const P = {
  dollar: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  fans: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87",
  gift: "M20 8v13H4V8M2 4h20v4H2zM12 4v17M12 4S10.5 1 8.3 1.6 6 4 6.5 4.6 9 5 12 4Z",
  inbox: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  wheel: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z",
  chart: "M3 3v18h18M7 16v-5M12 16V8M17 16v-3",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
};

function Glyph({ d, size = 19, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

const KIND_ICON: Record<string, string> = {
  open_fulfilment: P.gift,
  dm_fan: P.fans,
  copy_link: P.fans,
  schedule_happy_hour: P.clock,
  edit_wheel: P.wheel,
  open_inbox: P.inbox,
};

// Tone → [tile/tag background, foreground]. Foregrounds are the light tints so
// small uppercase tag text clears AA on the dark surface.
const TONE: Record<ImpactTag["tone"], [string, string]> = {
  brand: ["bg-[color-mix(in_oklab,var(--brand)_16%,transparent)]", "text-brand"],
  blue: ["bg-[#3b82f6]/15", "text-[#93c5fd]"],
  amber: ["bg-[#f59e0b]/15", "text-[#fcd34d]"],
  green: ["bg-[#22c55e]/15", "text-[#86efac]"],
  muted: ["bg-[color-mix(in_oklab,var(--color-ink)_7%,transparent)]", "text-muted"],
};

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";

function TrendChip({ trend }: { trend: Trend | string }) {
  if (trend === null) {
    return (
      <span className="tnum inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--color-ink)_7%,transparent)] px-2 py-0.5 text-[11px] font-bold text-muted">
        —
      </span>
    );
  }
  if (typeof trend === "string") {
    return (
      <span className="tnum inline-flex items-center rounded-full bg-[#f59e0b]/15 px-2 py-0.5 text-[11px] font-bold text-[#fcd34d]">
        {trend}
      </span>
    );
  }
  const cls =
    trend.dir === "up"
      ? "bg-[#22c55e]/15 text-[#86efac]"
      : trend.dir === "down"
        ? "bg-[#ef4444]/15 text-[#fca5a5]"
        : "bg-[color-mix(in_oklab,var(--color-ink)_7%,transparent)] text-muted";
  const arrow = trend.dir === "up" ? "▲" : trend.dir === "down" ? "▼" : "";
  const word = trend.dir === "up" ? "up " : trend.dir === "down" ? "down " : "";
  return (
    <span className={`tnum inline-flex items-center gap-[3px] rounded-full px-2 py-0.5 text-[11px] font-bold ${cls}`}>
      <span aria-hidden="true">{arrow}</span>
      <span className="sr-only">{word}</span>
      {trend.label}
    </span>
  );
}

function PulseCard({
  icon,
  label,
  value,
  chip,
  note,
  spark,
  sparkColor = "var(--brand)",
  action,
}: {
  icon: string;
  label: string;
  value: ReactNode;
  chip: ReactNode;
  note: string;
  spark?: string;
  sparkColor?: string;
  action?: { label: string; ariaLabel: string; onClick: () => void };
}) {
  return (
    <div className={`lift-in relative overflow-hidden rounded-2xl px-[18px] py-4 ${raised}`}>
      {spark && (
        <svg
          viewBox="0 0 120 40"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[38px] w-full opacity-45"
        >
          <polyline
            points={spark}
            fill="none"
            stroke={sparkColor}
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      <div className="relative">
        <div className="flex items-center gap-2 text-brand">
          <Glyph d={icon} size={15} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">{label}</span>
        </div>
        <p className="tnum mt-3 text-[27px] font-bold leading-none tracking-[-0.02em] text-ink">{value}</p>
        <div className="mt-2 flex flex-wrap items-center gap-[7px]">
          {chip}
          <span className="text-[11.5px] text-[#8b8494]">{note}</span>
        </div>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          aria-label={action.ariaLabel}
          className="absolute right-2.5 top-2.5 rounded-lg px-2 py-1 text-xs font-semibold text-brand transition-colors hover:bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]"
        >
          {action.label} <span aria-hidden="true">→</span>
        </button>
      )}
    </div>
  );
}

/**
 * "Today": a pulse strip (today's revenue/spins, fans, fulfilment queue) over a
 * ranked, prescriptive action feed. Each card is one tap to act, reusing the
 * dashboard's sections via `onNavigate`, or a direct copy-link. Cards can be
 * snoozed or dismissed.
 */
export default function TodayPanel({
  onNavigate,
  overview,
}: {
  onNavigate: (tab: string) => void;
  /** Shared, polled overview from DashboardClient (pending count + queue). */
  overview: CreatorOverview | null;
}) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const toast = useToast();
  const origin = useOrigin();
  // Daily series are UTC buckets ending today; the last point is "today".
  const { data: extra } = useFetch<CreatorMetricsExtra>("/api/metrics?days=14", { pollMs: 12000 });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot", { cache: "no-store" });
      if (res.ok) setCards((await res.json()).cards ?? []);
      else setCards([]);
    } catch {
      setCards([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, [load]);

  const act = async (c: Card) => {
    const a = c.action;
    switch (a.kind) {
      case "open_inbox":
        onNavigate("inbox");
        break;
      case "open_fulfilment":
        onNavigate("prizes");
        break;
      case "edit_wheel":
        onNavigate("editor");
        break;
      case "schedule_happy_hour":
        onNavigate("boosts");
        break;
      case "none":
        onNavigate("campaigns");
        break;
      case "dm_fan":
      case "copy_link":
        if (a.token) {
          if (await copyToClipboard(`${origin}/spin/${a.token}`)) {
            toast("Spin link copied — paste it in a DM.", { tone: "success" });
          } else {
            toast("Couldn't copy.", { tone: "error" });
          }
        } else {
          onNavigate("fans");
        }
        break;
      default:
        break;
    }
  };

  const dismiss = async (key: string, snoozeDays?: number) => {
    setCards((cs) => (cs ? cs.filter((c) => c.key !== key) : cs));
    const snoozeUntil = snoozeDays
      ? new Date(Date.now() + snoozeDays * 86400000).toISOString()
      : undefined;
    await fetch("/api/autopilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, snoozeUntil }),
    });
  };

  const m = overview?.metrics;
  const spins = spinSeries(extra?.trend);
  const cents = centSeries(extra?.revenueTrend);
  const pending = m?.pending ?? 0;
  const waiting = pending > 0 ? oldestPendingAge(overview?.redemptions) : null;
  const dash = <span className="text-muted">—</span>;

  return (
    <div className="relative flex flex-col gap-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-6 h-60 blur-[8px] [background:radial-gradient(60%_100%_at_30%_0%,color-mix(in_oklab,var(--brand)_22%,transparent),transparent_70%)]"
      />

      <section aria-label="Today's pulse" className="relative grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-3.5">
        <PulseCard
          icon={P.dollar}
          label="Revenue today"
          value={extra ? formatCents(lastValue(cents)) : dash}
          chip={<TrendChip trend={trendVsAvg(cents)} />}
          note="vs 14-day avg"
          spark={sparkPoints(cents)}
          sparkColor="#22c55e"
        />
        <PulseCard
          icon={P.target}
          label="Spins today"
          value={extra ? lastValue(spins) : dash}
          chip={<TrendChip trend={trendVsYesterday(spins)} />}
          note="vs yesterday"
          spark={sparkPoints(spins)}
        />
        <PulseCard
          icon={P.fans}
          label="Active fans"
          value={extra ? extra.activeFans.thisWeek : dash}
          chip={
            <TrendChip
              trend={extra ? trendVsYesterday([extra.activeFans.lastWeek, extra.activeFans.thisWeek]) : null}
            />
          }
          note={m ? `vs last week · ${m.fans} total` : "vs last week"}
        />
        <PulseCard
          icon={P.gift}
          label="To fulfil"
          value={m ? pending : dash}
          chip={<TrendChip trend={waiting} />}
          note={pending > 0 ? "oldest waiting" : "all clear"}
          // Replaces the old every-tab "N prizes waiting" banner: the queue stays
          // one tap away even when the autopilot fulfil card is dismissed.
          action={pending > 0 ? { label: "Open", ariaLabel: "Open the fulfilment queue", onClick: () => onNavigate("prizes") } : undefined}
        />
      </section>

      <section aria-labelledby="needs-you-now" className="relative">
        <div className="mb-3.5 flex items-baseline justify-between gap-3">
          <h2 id="needs-you-now" className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink">
            <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
            Needs you now
          </h2>
          {cards && cards.length > 0 && (
            <span className="tnum text-xs text-muted">{cards.length} ranked by impact</span>
          )}
        </div>

        {cards === null ? (
          <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading your day">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[76px] rounded-2xl" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className={`flex items-center gap-3.5 rounded-2xl px-[18px] py-5 ${raised}`}>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[#22c55e]/15 text-[#86efac]">
              <Glyph d={P.check} />
            </span>
            <div>
              <h3 className="text-[14.5px] font-bold text-ink">You&rsquo;re all caught up</h3>
              <p className="mt-0.5 text-[13.5px] text-muted">
                No actions need you right now. Come back after more fans spin.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {cards.map((c) => {
              const tag = impactTag(c.action.kind);
              const [tint, fg] = TONE[tag.tone];
              return (
                <li
                  key={c.key}
                  className={`lift-in flex flex-col gap-3 rounded-2xl px-4 py-4 transition-[transform,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--brand)_35%,var(--hair))] sm:flex-row sm:items-start sm:gap-3.5 sm:px-[18px] ${raised}`}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3.5">
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[11px] ${tint} ${fg}`}>
                      <Glyph d={KIND_ICON[c.action.kind] ?? P.chart} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="text-[14.5px] font-bold text-ink">{c.title}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.03em] ${tint} ${fg}`}>
                          {tag.label}
                        </span>
                      </div>
                      <p className="mt-1 text-[13.5px] text-muted text-pretty">{c.body}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 pl-[54px] sm:pl-0">
                    <button
                      type="button"
                      onClick={() => act(c)}
                      className="btn-brand min-h-9 rounded-[9px] px-[15px] text-[13px] font-bold sm:min-w-32"
                    >
                      {c.cta}
                    </button>
                    {/* Snooze isn't in the design (✕ only); kept as a compact
                        icon button beside ✕ so the 3-day snooze isn't lost. */}
                    <button
                      type="button"
                      onClick={() => dismiss(c.key, 3)}
                      aria-label={`Snooze for 3 days: ${c.title}`}
                      title="Snooze 3 days"
                      className="grid h-9 w-9 place-items-center rounded-[9px] border border-line text-muted transition-colors hover:text-ink"
                    >
                      <Glyph d={P.clock} size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss(c.key)}
                      aria-label={`Dismiss: ${c.title}`}
                      title="Dismiss"
                      className="grid h-9 w-9 place-items-center rounded-[9px] border border-line text-muted transition-colors hover:text-ink"
                    >
                      <Glyph d={P.x} size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
