"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Wheel from "@/components/Wheel";
import { prizeOdds } from "@/lib/games/wheel/engine";
import {
  RARITY_COLORS,
  RARITY_ORDER,
  type Prize,
  type Rarity,
  type WheelConfig,
} from "@/lib/games/wheel/types";
import type {
  CampaignPack,
  CreatorMetricsExtra,
  CreatorOverview,
  DmTemplate,
  FanAccountSummary,
  PrizeTemplate,
  RedemptionItem,
  RedemptionStatus,
} from "@/lib/data/types";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/format";
import { OddsBar } from "@/components/dashboard/OddsBar";
import Sparkline from "@/components/dashboard/Sparkline";
import Funnel from "@/components/dashboard/Funnel";
import { EmptyState, Field, TagEditor } from "./ui";
import QrButton from "@/components/dashboard/QrButton";
import FanDetailDrawer from "@/components/dashboard/FanDetailDrawer";
import CampaignsPanel from "@/components/dashboard/CampaignsPanel";
import WheelSwitcher from "@/components/dashboard/WheelSwitcher";
import TemplateLibrary from "@/components/dashboard/TemplateLibrary";
import PackPresets from "@/components/dashboard/PackPresets";
import InboxPanel from "@/components/dashboard/InboxPanel";
import BoostsPanel from "@/components/dashboard/BoostsPanel";
import TodayPanel from "@/components/dashboard/TodayPanel";
import InvitesBanner from "@/components/dashboard/InvitesBanner";
import GetStartedChecklist from "@/components/dashboard/GetStartedChecklist";
import AnalyticsPanel from "@/components/dashboard/AnalyticsPanel";
import ImportFans from "@/components/dashboard/ImportFans";
import {
  EMOJI_SUGGESTIONS,
  balanceOdds,
  duplicatePrize,
  newPrize,
  reorder,
  RARITY_DEFAULT_WEIGHT,
} from "@/components/dashboard/editorHelpers";

type Tab = "today" | "metrics" | "prizes" | "fans" | "campaigns" | "editor" | "inbox" | "boosts" | "analytics";

// The starter wheel's id; a creator who hasn't saved their own wheel still uses it.
const SAMPLE_WHEEL_ID = "demo-wheel";

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

// Shared overview, polled so metrics + the pending badge stay live.
function useOverview() {
  const [data, setData] = useState<CreatorOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/overview", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 12000);
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);
  return { data, loading, refresh, setData };
}

// Enhanced metrics (spin trend + conversion funnel), polled like the overview
// and refetched whenever the selected window (`days`) changes.
function useMetricsExtra(days: number) {
  const [data, setData] = useState<CreatorMetricsExtra | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/metrics?days=${days}`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading when the window (`days`) changes, then refetch
    setLoading(true);
    refresh();
    const id = setInterval(refresh, 12000);
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);
  return { data, loading };
}

export default function DashboardClient({
  isAdmin,
  email,
  initialWheel,
}: {
  isAdmin: boolean;
  email: string | null;
  initialWheel: WheelConfig;
}) {
  const [tab, setTab] = useState<Tab>("today");
  const [wheel, setWheel] = useState<WheelConfig>(() => structuredClone(initialWheel));
  // Which wheel the editor is currently editing. Lifted so it survives tab
  // switches and the WheelSwitcher highlights the right wheel. Seeded from the
  // initial active wheel's id so the switcher highlights it on first paint.
  const [editingWheelId, setEditingWheelId] = useState<string | null>(
    initialWheel.id ?? null
  );
  const overview = useOverview();
  const pending = overview.data?.metrics.pending ?? 0;
  const unread = overview.data?.metrics.unreadMessages ?? 0;

  // First-run signals: a brand-new creator has no fans and no spins yet, and is
  // still on the sample wheel (no saved wheel id of their own).
  const metricsFans = overview.data?.metrics.fans ?? 0;
  const metricsSpins = overview.data?.metrics.spinsPlayed ?? 0;
  const wheelSaved = wheel.id !== SAMPLE_WHEEL_ID;

  // New creators should land on the Wheel editor (their first task), not the
  // empty "Today" feed. Switch once, on first data load, only if they haven't
  // already navigated somewhere themselves.
  const userPickedTab = useRef(false);
  const autoLanded = useRef(false);
  useEffect(() => {
    if (autoLanded.current || overview.loading || userPickedTab.current) return;
    autoLanded.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time landing choice after async overview load
    if (metricsFans === 0 && metricsSpins === 0) setTab("editor");
  }, [overview.loading, metricsFans, metricsSpins]);

  const goTab = (t: Tab) => {
    userPickedTab.current = true;
    setTab(t);
  };

  const tabs: [Tab, string][] = [
    ["today", "Today"],
    ["editor", "Wheel"],
    ["fans", "Fans"],
    ["prizes", "Prizes"],
    ["campaigns", "Campaigns"],
    ["boosts", "Boosts"],
    ["inbox", "Inbox"],
    ["analytics", "Analytics"],
    ["metrics", "Metrics"],
  ];

  return (
    <ToastProvider>
    <div className="mx-auto w-full max-w-5xl overflow-x-clip px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">
            Creator dashboard
          </h1>
          <p className="truncate text-sm text-muted">
            {email ?? "Demo workspace — connect Supabase to go live"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(isAdmin || !email) && (
            <a
              href="/admin"
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
            >
              Admin
            </a>
          )}
          {email && (
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
              >
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>

      {email && (
        <div className="mt-5">
          <InvitesBanner />
        </div>
      )}

      {!overview.loading && (
        <GetStartedChecklist
          wheelSaved={wheelSaved}
          fans={metricsFans}
          spins={metricsSpins}
          onGoTo={(t) => goTab(t as Tab)}
        />
      )}

      {pending > 0 && tab !== "prizes" && (
        <button
          onClick={() => setTab("prizes")}
          className="mt-5 flex w-full items-center gap-3 rounded-xl border border-[var(--brand)]/40 bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] px-4 py-3 text-left transition hover:bg-[color-mix(in_oklab,var(--brand)_18%,transparent)]"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--brand)] text-sm font-bold text-white tnum">
            {pending}
          </span>
          <span className="text-sm text-ink">
            {pending === 1 ? "1 prize is" : `${pending} prizes are`} waiting to be
            fulfilled
          </span>
          <span className="ml-auto text-sm font-semibold text-[var(--brand)]">
            Open →
          </span>
        </button>
      )}

      <nav className="-mx-4 mt-6 flex flex-nowrap gap-0.5 overflow-x-auto overflow-y-hidden border-b border-line px-4 [-webkit-overflow-scrolling:touch] [overscroll-behavior-x:contain] [scrollbar-width:none] [touch-action:pan-x] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => goTab(id)}
            className={`-mb-px flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-[13px] font-semibold transition sm:text-sm ${
              tab === id
                ? "border-[var(--brand)] text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
            {id === "prizes" && pending > 0 && (
              <span className="tnum grid h-5 min-w-5 place-items-center rounded-full bg-[var(--brand)] px-1 text-[11px] font-bold text-white">
                {pending}
              </span>
            )}
            {id === "inbox" && unread > 0 && (
              <span className="tnum grid h-5 min-w-5 place-items-center rounded-full bg-[var(--brand)] px-1 text-[11px] font-bold text-white">
                {unread}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-7">
        {tab === "today" && <TodayPanel onNavigate={(t) => setTab(t as Tab)} />}
        {tab === "metrics" && (
          <MetricsPanel
            overview={overview.data}
            loading={overview.loading}
            onGoTo={setTab}
          />
        )}
        {tab === "prizes" && (
          <PrizesPanel
            data={overview.data}
            loading={overview.loading}
            refresh={overview.refresh}
            setData={overview.setData}
          />
        )}
        {tab === "fans" && <FansPanel />}
        {tab === "campaigns" && <CampaignsPanel />}
        {tab === "boosts" && (
          <BoostsPanel
            leaderboardEnabled={overview.data?.metrics.leaderboardEnabled ?? false}
            onLeaderboardChange={overview.refresh}
          />
        )}
        {tab === "inbox" && <InboxPanel onChanged={overview.refresh} />}
        {tab === "analytics" && <AnalyticsPanel />}
        {tab === "editor" && (
          <WheelEditor
            wheel={wheel}
            setWheel={setWheel}
            initialWheel={initialWheel}
            editingWheelId={editingWheelId}
            setEditingWheelId={setEditingWheelId}
          />
        )}
      </div>
    </div>
    </ToastProvider>
  );
}

// ---------------------------------------------------------------------------
// Metrics — a real read on what's working, not four vanity numbers.
// ---------------------------------------------------------------------------
function MetricsPanel({
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

// ---------------------------------------------------------------------------
// Prizes fulfilment queue
// ---------------------------------------------------------------------------
function PrizesPanel({
  data,
  loading,
  refresh,
  setData,
}: {
  data: CreatorOverview | null;
  loading: boolean;
  refresh: () => void;
  setData: React.Dispatch<React.SetStateAction<CreatorOverview | null>>;
}) {
  const [filter, setFilter] = useState<RedemptionStatus | "all">("pending");

  // PATCH a redemption: status and/or notes/dueAt. Optimistically patch the
  // shared overview so the row updates instantly, then refresh authoritatively.
  async function patchRow(
    id: string,
    patch: { status?: RedemptionStatus; notes?: string | null; dueAt?: string | null }
  ) {
    setData((d) =>
      d
        ? {
            ...d,
            redemptions: d.redemptions.map((r) =>
              r.id === id ? { ...r, ...patch } : r
            ),
          }
        : d
    );
    await fetch(`/api/redemptions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    refresh();
  }

  const setStatus = (id: string, status: RedemptionStatus) =>
    patchRow(id, { status });

  const redemptions = data?.redemptions ?? [];
  const shown = filter === "all" ? redemptions : redemptions.filter((r) => r.status === filter);
  const pendingCount = redemptions.filter((r) => r.status === "pending").length;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-ink">Prize fulfilment</h3>
          <p className="text-sm text-muted">Every fan spin lands here. Deliver it, then mark it done.</p>
        </div>
        <button
          onClick={refresh}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Refresh
        </button>
      </div>

      <div className="mt-4 flex gap-2">
        {(["pending", "in_progress", "fulfilled", "cancelled", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
              filter === f
                ? "bg-[var(--brand)] text-white"
                : "border border-line text-muted hover:text-ink"
            }`}
          >
            {f === "all" ? "all" : STATUS_LABEL[f]}
            {f === "pending" && pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {loading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-xl" />
            ))}
          </>
        )}
        {!loading && shown.length === 0 && (
          <EmptyState
            title="Nothing here yet"
            body="Create a fan link, open it, and spin. Wins show up here instantly."
          />
        )}
        {shown.map((r) => (
          <RedemptionRow key={r.id} r={r} onSet={setStatus} onPatch={patchRow} />
        ))}
      </div>
    </div>
  );
}

// The next status in the pending → in_progress → fulfilled cycle.
const STATUS_NEXT: Record<RedemptionStatus, RedemptionStatus> = {
  pending: "in_progress",
  in_progress: "fulfilled",
  fulfilled: "pending",
  cancelled: "pending",
};

const STATUS_CTA: Record<RedemptionStatus, string> = {
  pending: "Start",
  in_progress: "Mark fulfilled",
  fulfilled: "Reopen",
  cancelled: "Reopen",
};

const STATUS_PILL: Record<RedemptionStatus, string> = {
  pending: "bg-white/10 text-muted",
  in_progress: "bg-amber-500/15 text-amber-300",
  fulfilled: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-white/10 text-muted",
};

const STATUS_LABEL: Record<RedemptionStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

function RedemptionRow({
  r,
  onSet,
  onPatch,
}: {
  r: RedemptionItem;
  onSet: (id: string, status: RedemptionStatus) => void;
  onPatch: (
    id: string,
    patch: { status?: RedemptionStatus; notes?: string | null; dueAt?: string | null }
  ) => void;
}) {
  const color = RARITY_COLORS[r.rarity];
  const [notes, setNotes] = useState(r.notes ?? "");
  // Keep the local draft in sync when the row is refreshed from the server.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to refreshed prop
    setNotes(r.notes ?? "");
  }, [r.notes]);

  const dueValue = r.dueAt ? r.dueAt.slice(0, 10) : "";
  const overdue =
    !!r.dueAt &&
    r.status !== "fulfilled" &&
    r.status !== "cancelled" &&
    // eslint-disable-next-line react-hooks/purity -- comparing a due date to "now" is inherently time-dependent
    new Date(r.dueAt).getTime() < Date.now();

  function commitNotes() {
    const next = notes.trim() ? notes : null;
    if ((r.notes ?? "") !== (next ?? "")) onPatch(r.id, { notes: next });
  }

  return (
    <div className="card flex flex-col gap-3 rounded-xl p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-xl"
            style={{ backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)` }}
          >
            {r.emoji ?? "🎁"}
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{r.prizeLabel}</p>
            <p className="truncate text-xs text-muted">
              <span style={{ color }}>{RARITY_LABEL[r.rarity]}</span> · {r.fanName} ·{" "}
              {new Date(r.at).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {overdue && (
            <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-bold text-red-400">
              Overdue
            </span>
          )}
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_PILL[r.status]}`}
          >
            {STATUS_LABEL[r.status]}
          </span>
          <button
            onClick={() => onSet(r.id, STATUS_NEXT[r.status])}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white transition ${
              r.status === "in_progress"
                ? "bg-emerald-500 hover:bg-emerald-400"
                : "btn-brand"
            }`}
          >
            {STATUS_CTA[r.status]}
          </button>
          {r.status !== "cancelled" && r.status !== "fulfilled" && (
            <button
              onClick={() => onSet(r.id, "cancelled")}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="ff-input min-w-0 flex-1 text-sm"
          placeholder="Add a note (e.g. shipped via DHL #123)…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Due
          <input
            type="date"
            className="ff-input tnum text-sm"
            value={dueValue}
            onChange={(e) =>
              onPatch(r.id, { dueAt: e.target.value ? e.target.value : null })
            }
          />
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fans & links — now loaded from the server so they persist across refreshes.
// ---------------------------------------------------------------------------
function FansPanel() {
  const [accounts, setAccounts] = useState<FanAccountSummary[] | null>(null);
  const [name, setName] = useState("");
  const [spins, setSpins] = useState(3);
  // Price the creator types is PER SPIN; it's its own state so typing isn't
  // fought by a derived value. The total is computed from perSpin × spins.
  const [perSpin, setPerSpin] = useState<string>("");
  const amount = perSpin && spins > 0 ? (Number(perSpin) * spins).toFixed(2) : "";
  const [campaignId, setCampaignId] = useState<string>("");
  // The pack a preset filled in, if any. Sent to the server which resolves it
  // authoritatively; cleared on any manual override so we don't mis-attribute.
  const [packId, setPackId] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [openFanId, setOpenFanId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [campaignFilter, setCampaignFilter] = useState<string>("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [templates, setTemplates] = useState<DmTemplate[]>([]);
  const [managingMessages, setManagingMessages] = useState(false);
  const toast = useToast();
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
    const res = await fetch("/api/fans", { cache: "no-store" });
    if (res.ok) setAccounts((await res.json()).fans ?? []);
    else setAccounts([]);
  }, []);
  const loadCampaigns = useCallback(async () => {
    const res = await fetch("/api/campaigns", { cache: "no-store" });
    if (res.ok) setCampaigns((await res.json()).campaigns ?? []);
  }, []);
  const loadTemplates = useCallback(async () => {
    const res = await fetch("/api/dm-templates", { cache: "no-store" });
    if (res.ok) setTemplates((await res.json()).templates ?? []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
    loadCampaigns();
    loadTemplates();
  }, [load, loadCampaigns, loadTemplates]);

  // Every distinct tag across loaded accounts, for the tag filter dropdown.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const a of accounts ?? []) for (const t of a.tags) set.add(t);
    return [...set].sort((x, y) => x.localeCompare(y));
  }, [accounts]);

  async function call(body: object) {
    const res = await fetch("/api/passes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.token) {
      toast(
        data.error === "no_wheel"
          ? "Create and save a wheel first, then generate fan links."
          : "Couldn't create link. Are you signed in?",
        { tone: "error" }
      );
      return null;
    }
    return data as { token: string; fanId: string };
  }

  async function createAccount() {
    setCreating(true);
    try {
      const amountDollars = amount ? Number(amount) : undefined;
      const data = await call({
        name: name.trim(),
        spins,
        campaignId: campaignId || undefined,
        amountDollars: amountDollars || undefined,
        ...(packId ? { packId } : {}),
      });
      if (data) {
        setName("");
        setPerSpin("");
        setPackId(null);
        await load();
      }
    } finally {
      setCreating(false);
    }
  }

  // Top up an existing fan. The data layer tops up the balance without minting a
  // new link, and can tag the grant to a (possibly different) campaign.
  async function topUp(
    fanId: string,
    addSpins: number,
    amountDollars?: number,
    topUpCampaignId?: string,
    packId?: string | null
  ) {
    const data = await call({
      fanId,
      spins: addSpins,
      amountDollars: amountDollars || undefined,
      campaignId: topUpCampaignId || undefined,
      ...(packId ? { packId } : {}),
    });
    if (data) await load();
  }

  // Client-side filtering over the loaded accounts. NOTE: once accounts
  // paginate, this must move server-side so search/filter cover all fans.
  const filtered = (accounts ?? []).filter((a) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || a.name.toLowerCase().includes(q);
    const matchesCampaign =
      !campaignFilter || a.campaignNames.includes(campaignFilter);
    const matchesTag = !tagFilter || a.tags.includes(tagFilter);
    return matchesSearch && matchesCampaign && matchesTag;
  });

  return (
    <div className="max-w-2xl">
      <div className="card rounded-xl p-5">
        <h3 className="font-bold text-ink">Create a fan account</h3>
        <p className="mt-1 text-sm text-muted">
          You create the account; the fan never signs up. Balance and win history
          live on the account, so you can mint fresh links anytime.
        </p>
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <Field label="Fan name / handle">
            <input
              className="ff-input w-44"
              placeholder="@bigfan"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Spins to grant">
            <input
              type="number"
              min={1}
              className="ff-input tnum w-24"
              value={spins}
              onChange={(e) => {
                setSpins(Math.max(1, Number(e.target.value)));
                setPackId(null);
              }}
            />
          </Field>
          <Field label="$ per spin (optional)">
            <input
              type="number"
              min={0}
              step={0.01}
              className="ff-input tnum w-28"
              placeholder="0.00"
              value={perSpin}
              onChange={(e) => {
                setPerSpin(e.target.value);
                setPackId(null);
              }}
            />
            {amount && Number(amount) > 0 && spins > 0 && (
              <p className="mt-1 text-[11px] text-muted">
                {formatCents(Math.round((Number(amount) * 100) / spins))}/spin ·{" "}
                {formatCents(Math.round(Number(amount) * 100))} total
              </p>
            )}
          </Field>
          <Field label="Campaign (optional)">
            <select
              className="ff-input w-44"
              value={campaignId}
              onChange={(e) => {
                setCampaignId(e.target.value);
                setPackId(null);
              }}
            >
              <option value="">None</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <button
            onClick={createAccount}
            disabled={creating}
            className="btn-brand mt-5 rounded-lg px-5 py-2 text-sm font-bold"
          >
            {creating ? "Creating…" : "Create account"}
          </button>
        </div>
        {campaignId && (
          <div className="mt-3">
            <PackPresets
              campaignId={campaignId}
              onPick={(p: CampaignPack) => {
                setSpins(p.spins);
                setPerSpin(p.spins > 0 ? (p.amountCents / 100 / p.spins).toFixed(2) : "");
                setPackId(p.id);
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        {accounts && accounts.length > 0 ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Search fans">
              <input
                className="ff-input w-56"
                placeholder="Name or handle"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
            <Field label="Campaign">
              <select
                className="ff-input w-44"
                value={campaignFilter}
                onChange={(e) => setCampaignFilter(e.target.value)}
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tag">
              <select
                className="ff-input w-40"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
              >
                <option value="">All tags</option>
                {allTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setManagingMessages(true)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Manage messages
        </button>
      </div>

      <div className="mt-4">
        <ImportFans campaignId={campaignId || undefined} onImported={load} />
      </div>

      <div className="mt-6 space-y-4">
        {accounts === null && (
          <>
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" />
            ))}
          </>
        )}
        {accounts?.length === 0 && (
          <EmptyState title="No fans yet" body="Create your first fan account above to mint a link." />
        )}
        {accounts && accounts.length > 0 && filtered.length === 0 && (
          <EmptyState title="No matches" body="No fans match your search or campaign filter." />
        )}
        {filtered.map((acc) => (
          <AccountCard
            key={acc.fanId}
            account={acc}
            origin={origin}
            campaigns={campaigns}
            templates={templates}
            onTopUp={topUp}
            onOpen={setOpenFanId}
            onDeleted={load}
            refresh={load}
          />
        ))}
      </div>
      <FanDetailDrawer
        fanId={openFanId}
        onClose={() => setOpenFanId(null)}
        onSaved={load}
      />
      {managingMessages && (
        <ManageMessages
          templates={templates}
          onClose={() => setManagingMessages(false)}
          refresh={loadTemplates}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved DM templates: list / add / delete. `{link}` is the placeholder swapped
// for a fan's full spin URL when the "Copy DM" control on a card is used.
// ---------------------------------------------------------------------------
function ManageMessages({
  templates,
  onClose,
  refresh,
}: {
  templates: DmTemplate[];
  onClose: () => void;
  refresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function add() {
    if (!title.trim() || !body.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/dm-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body }),
      });
      if (res.ok) {
        setTitle("");
        setBody("");
        toast("Template saved", { tone: "success" });
        refresh();
      } else {
        toast("Couldn't save template.", { tone: "error" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch("/api/dm-templates/" + id, { method: "DELETE" });
    if (res.ok) {
      toast("Template deleted", { tone: "info" });
      refresh();
    } else {
      toast("Couldn't delete template.", { tone: "error" });
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage DM templates"
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-y-auto rounded-t-2xl border border-line bg-surface shadow-2xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:max-h-[80vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-ink">DM templates</h2>
            <p className="mt-0.5 text-xs text-muted">
              Use <code className="rounded bg-base px-1">{"{link}"}</code> where the
              fan&rsquo;s spin link should go.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-sm font-semibold text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="space-y-2">
            {templates.length === 0 && (
              <p className="text-sm text-muted">No templates yet. Add one below.</p>
            )}
            {templates.map((t) => (
              <div key={t.id} className="rounded-lg border border-line bg-base/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold text-ink">
                    {t.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    aria-label={`Delete template ${t.title}`}
                    className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold text-muted transition hover:text-red-500"
                  >
                    Delete
                  </button>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted">
                  {t.body}
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t border-line pt-4">
            <Field label="Title">
              <input
                className="ff-input w-full"
                placeholder="Spin invite"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="Message">
              <textarea
                className="ff-input w-full"
                rows={3}
                placeholder="Hey! Here's your spin link: {link}"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <button
              type="button"
              onClick={add}
              disabled={saving || !title.trim() || !body.trim()}
              className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountCard({
  account,
  origin,
  campaigns,
  templates,
  onTopUp,
  onOpen,
  onDeleted,
  refresh,
}: {
  account: FanAccountSummary;
  origin: string;
  campaigns: { id: string; name: string }[];
  templates: DmTemplate[];
  onTopUp: (
    fanId: string,
    addSpins: number,
    amountDollars?: number,
    campaignId?: string,
    packId?: string | null
  ) => void;
  onOpen: (fanId: string) => void;
  onDeleted: () => void;
  refresh: () => void;
}) {
  const [topUp, setTopUp] = useState(3);
  // Per-spin price as its own state (see FansPanel) so typing two digits works.
  const [perSpin, setPerSpin] = useState<string>("");
  const amount = perSpin && topUp > 0 ? (Number(perSpin) * topUp).toFixed(2) : "";
  const [campaignId, setCampaignId] = useState<string>("");
  // The pack a preset filled in, if any. Sent to the server which resolves it
  // authoritatively; cleared on any manual override so we don't mis-attribute.
  const [packId, setPackId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const toast = useToast();

  // Surface only the primary link by default; the rest are revealed on demand.
  const primaryToken = account.primaryToken ?? account.links[0]?.token ?? null;
  const primaryUrl = primaryToken ? `${origin}/spin/${primaryToken}` : null;

  // Persist a new tag set, then refresh the list so chips/filters stay in sync.
  async function saveTags(next: string[]) {
    setSavingTags(true);
    try {
      const res = await fetch("/api/fans/" + account.fanId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      if (res.ok) refresh();
      else toast("Couldn't save tags.", { tone: "error" });
    } catch {
      toast("Couldn't save tags.", { tone: "error" });
    } finally {
      setSavingTags(false);
    }
  }

  // Fill {link} with the fan's full spin URL and copy the message.
  async function copyDm(template: DmTemplate) {
    if (!primaryUrl) {
      toast("No link to insert yet.", { tone: "error" });
      return;
    }
    const text = template.body.split("{link}").join(primaryUrl);
    try {
      await navigator.clipboard?.writeText(text);
      toast("DM copied", { tone: "success" });
    } catch {
      toast("Couldn't copy DM.", { tone: "error" });
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch("/api/fans/" + account.fanId, { method: "DELETE" });
      if (res.ok) {
        toast("Fan deleted", { tone: "success" });
        onDeleted();
      } else {
        toast("Couldn't delete fan. Are you signed in?", { tone: "error" });
        setConfirmDelete(false);
      }
    } catch {
      toast("Couldn't delete fan. Are you signed in?", { tone: "error" });
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  // The rest of the fan's links are revealed on demand (primary shown above).
  const others = account.links.filter((l) => l.token !== primaryToken);

  return (
    <div className="card rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen(account.fanId)}
          aria-label={"View " + account.name}
          className="min-w-0 flex-1 rounded-lg text-left transition hover:opacity-80"
        >
          <p className="truncate font-bold text-ink">{account.name}</p>
          <p className="text-xs text-muted">
            <span className="tnum font-semibold text-ink">{account.spinsRemaining}</span> spins left
            · {account.grantedTotal} granted · {account.links.length} link
            {account.links.length === 1 ? "" : "s"}
            {account.lastWin && (
              <>
                {" "}
                · last won{" "}
                <span style={{ color: RARITY_COLORS[account.lastWin.rarity] }}>
                  {account.lastWin.label}
                </span>
              </>
            )}
          </p>
        </button>

        {confirmDelete ? (
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              aria-label={"Confirm delete " + account.name}
              className="rounded-full border border-red-500/60 px-3 py-1 font-bold text-red-500 transition hover:bg-red-500/10 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete?"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              aria-label="Cancel delete"
              className="rounded-full border border-line px-3 py-1 font-semibold text-muted transition hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label={"Delete " + account.name}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-semibold text-muted transition hover:border-red-500/60 hover:text-red-500"
          >
            Delete
          </button>
        )}
      </div>

      {/* Spend + campaign chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted">
          <span className="tnum font-semibold text-ink">{formatCents(account.totalSpent)}</span> spent
        </span>
        {account.campaignNames.map((c) => (
          <span
            key={c}
            className="rounded-full border border-line px-2 py-0.5 font-semibold text-muted"
          >
            {c}
          </span>
        ))}
      </div>

      {/* Tags: chips + quick editor (presets + free-text). */}
      <div className="mt-3">
        <TagEditor tags={account.tags} onChange={saveTags} disabled={savingTags} compact />
      </div>

      {/* Share actions: QR for the primary link + copy a DM from a template. */}
      {primaryUrl && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <QrButton url={primaryUrl} label={`${account.name} spin link`} />
          <CopyDmMenu templates={templates} onPick={copyDm} />
        </div>
      )}

      {/* Top-up row: spins + optional $ + optional campaign tag. Align to the
          top so the "$X total" helper under $/spin doesn't shove Spins down. */}
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <Field label="Spins">
          <input
            type="number"
            min={1}
            className="ff-input tnum w-16 text-right"
            value={topUp}
            onChange={(e) => {
              setTopUp(Math.max(1, Number(e.target.value)));
              setPackId(null);
            }}
          />
        </Field>
        <Field label="$ per spin">
          <input
            type="number"
            min={0}
            step={0.01}
            className="ff-input tnum w-24"
            placeholder="0.00"
            value={perSpin}
            onChange={(e) => {
              setPerSpin(e.target.value);
              setPackId(null);
            }}
          />
          {amount && Number(amount) > 0 && topUp > 0 && (
            <p className="mt-1 text-[11px] text-muted">
              {formatCents(Math.round(Number(amount) * 100))} total
            </p>
          )}
        </Field>
        <Field label="Campaign">
          <select
            className="ff-input w-40"
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setPackId(null);
            }}
          >
            <option value="">None</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          onClick={() => {
            onTopUp(
              account.fanId,
              topUp,
              amount ? Number(amount) || undefined : undefined,
              campaignId || undefined,
              packId
            );
            setPerSpin("");
            setPackId(null);
          }}
          className="mt-5 rounded-lg border border-[var(--brand)]/50 px-3 py-1.5 text-xs font-bold text-[var(--brand)] transition hover:bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]"
        >
          Top up
        </button>
      </div>
      {campaignId && (
        <div className="mt-3">
          <PackPresets
            campaignId={campaignId}
            onPick={(p: CampaignPack) => {
              setTopUp(p.spins);
              setPerSpin(p.spins > 0 ? (p.amountCents / 100 / p.spins).toFixed(2) : "");
              setPackId(p.id);
            }}
          />
        </div>
      )}

      {primaryToken && (
        <div className="mt-3 space-y-2">
          <LinkRow url={`${origin}/spin/${primaryToken}`} latest />
          {others.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-xs font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline"
              >
                {showAll ? "Hide other links" : `Show all links (${account.links.length})`}
              </button>
              {showAll &&
                others.map((l) => (
                  <LinkRow key={l.token} url={`${origin}/spin/${l.token}`} latest={false} />
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// A small dropdown of saved DM templates. Picking one fills {link} and copies.
function CopyDmMenu({
  templates,
  onPick,
}: {
  templates: DmTemplate[];
  onPick: (t: DmTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-haspopup="menu"
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
      >
        Copy DM
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute left-0 z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-2xl"
        >
          {templates.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">
              No templates yet. Add one in &ldquo;Manage messages&rdquo;.
            </p>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(t);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left transition hover:bg-white/5"
              >
                <span className="block truncate text-sm font-semibold text-ink">
                  {t.title}
                </span>
                <span className="block truncate text-xs text-muted">{t.body}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LinkRow({ url, latest }: { url: string; latest: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-base/40 p-2.5">
      <p className="min-w-0 flex-1 truncate text-xs text-muted">
        {url}
        {latest && (
          <span className="ml-2 rounded bg-[color-mix(in_oklab,var(--brand)_20%,transparent)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--brand)]">
            NEWEST
          </span>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
        >
          Open
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wheel editor
// ---------------------------------------------------------------------------
function WheelEditor({
  wheel,
  setWheel,
  initialWheel,
  editingWheelId,
  setEditingWheelId,
}: {
  wheel: WheelConfig;
  setWheel: (w: WheelConfig) => void;
  initialWheel: WheelConfig;
  editingWheelId: string | null;
  setEditingWheelId: (id: string | null) => void;
}) {
  const odds = useMemo(() => prizeOdds(wheel), [wheel]);
  // OddsBar expects percentages (0–100); prizeOdds returns fractions (0–1).
  const oddsPct = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, f] of odds) m.set(id, f * 100);
    return m;
  }, [odds]);
  const toast = useToast();
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(initialWheel));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const dirty = JSON.stringify(wheel) !== savedJson;

  async function save() {
    setSaving(true);
    setJustSaved(false);
    try {
      const res = await fetch("/api/wheel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wheel }),
      });
      const data = await res.json();
      if (res.ok && data.wheel) {
        setWheel(data.wheel);
        setSavedJson(JSON.stringify(data.wheel));
        setEditingWheelId(data.wheel.id);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2000);
      } else {
        toast("Couldn't save. Are you signed in?", { tone: "error" });
      }
    } finally {
      setSaving(false);
    }
  }

  const [dragIdx, setDragIdx] = useState<number | null>(null);

  function updatePrize(id: string, patch: Partial<Prize>) {
    setWheel({ ...wheel, prizes: wheel.prizes.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }
  function addPrize() {
    setWheel({ ...wheel, prizes: [...wheel.prizes, newPrize()] });
  }
  // Load a wheel's full config into the editor and mark it as the one being
  // edited. The config carries its own id, so the existing save (PUT /api/wheel
  // with the full config) targets the right wheel.
  async function loadWheel(id: string) {
    const res = await fetch(`/api/wheels/${id}`, { cache: "no-store" });
    if (!res.ok) {
      toast("Couldn't open that wheel.", { tone: "error" });
      return;
    }
    const data = (await res.json()) as { wheel?: WheelConfig };
    if (!data.wheel) {
      toast("Couldn't open that wheel.", { tone: "error" });
      return;
    }
    setWheel(data.wheel);
    setSavedJson(JSON.stringify(data.wheel));
    setEditingWheelId(data.wheel.id);
  }
  // Apply a saved wheel template: it mints a fresh wheel from the template
  // server-side, then opens that new wheel in the editor.
  async function applyWheelTemplate(templateId: string) {
    const res = await fetch("/api/wheels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromTemplateId: templateId }),
    });
    const data = (await res.json()) as { wheel?: WheelConfig };
    if (!res.ok || !data.wheel) {
      toast("Couldn't apply template.", { tone: "error" });
      return;
    }
    await loadWheel(data.wheel.id);
    toast("Template applied", { tone: "success" });
  }
  // Save the current editor wheel as a reusable template.
  async function saveCurrentWheelAsTemplate(name: string) {
    const res = await fetch("/api/templates/wheels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: wheel }),
    });
    if (res.ok) toast("Saved as template", { tone: "success" });
    else toast("Couldn't save template.", { tone: "error" });
  }
  // Save every prize on the current wheel into the reusable prize library.
  async function saveCurrentPrizesToLibrary() {
    const results = await Promise.all(
      wheel.prizes.map((p) =>
        fetch("/api/templates/prizes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: p.label,
            description: p.description,
            rarity: p.rarity,
            weight: p.weight,
            color: p.color,
            emoji: p.emoji,
          }),
        }).then((r) => r.ok)
      )
    );
    const saved = results.filter(Boolean).length;
    if (saved > 0) toast(`Saved ${saved} ${saved === 1 ? "prize" : "prizes"} to library`, { tone: "success" });
    else toast("Couldn't save prizes.", { tone: "error" });
  }
  // Drop a library prize into the current wheel. Reuse the editor's newPrize()
  // so ids/format match, then overlay the template's fields.
  function applyPrizeTemplate(t: PrizeTemplate) {
    const prize = {
      ...newPrize(),
      label: t.label,
      description: t.description,
      rarity: t.rarity,
      weight: t.weight,
      color: t.color,
      emoji: t.emoji,
    };
    setWheel({ ...wheel, prizes: [...wheel.prizes, prize] });
    toast("Prize added from library", { tone: "success" });
  }
  function movePrize(from: number, to: number) {
    if (to < 0 || to >= wheel.prizes.length || from === to) return;
    setWheel({ ...wheel, prizes: reorder(wheel.prizes, from, to) });
  }
  function duplicateAt(index: number) {
    const next = wheel.prizes.slice();
    next.splice(index + 1, 0, duplicatePrize(wheel.prizes[index]));
    setWheel({ ...wheel, prizes: next });
  }
  /** Update rarity, preserving a custom color but refreshing a default one. */
  function changeRarity(p: Prize, rarity: Rarity) {
    const wasDefaultColor = p.color == null || p.color === RARITY_COLORS[p.rarity];
    // Auto-fill the weight from the new rarity's default tickets — unless the
    // creator has already hand-tuned this prize's weight (then we leave it).
    const wasDefaultWeight = p.weight === RARITY_DEFAULT_WEIGHT[p.rarity];
    updatePrize(p.id, {
      rarity,
      color: wasDefaultColor ? RARITY_COLORS[rarity] : p.color,
      weight: wasDefaultWeight ? RARITY_DEFAULT_WEIGHT[rarity] : p.weight,
    });
  }
  function removePrize(id: string) {
    if (wheel.prizes.length <= 2) return;
    const index = wheel.prizes.findIndex((p) => p.id === id);
    if (index < 0) return;
    const removed = wheel.prizes[index];
    const afterRemoval = wheel.prizes.filter((p) => p.id !== id);
    setWheel({ ...wheel, prizes: afterRemoval });
    toast("Prize removed", {
      tone: "info",
      action: {
        label: "Undo",
        onClick: () => {
          const restored = afterRemoval.slice();
          restored.splice(Math.min(index, restored.length), 0, removed);
          setWheel({ ...wheel, prizes: restored });
        },
      },
    });
  }

  return (
    <div>
      <div className="mb-6">
        <WheelSwitcher
          currentWheelId={editingWheelId}
          onEdit={loadWheel}
          onChanged={() => {}}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <p className="text-sm">
          {dirty ? (
            <span className="text-amber-300">● Unsaved changes</span>
          ) : justSaved ? (
            <span className="text-emerald-300">✓ Saved</span>
          ) : (
            <span className="text-muted">All changes saved</span>
          )}
        </p>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="btn-brand rounded-lg px-5 py-2 text-sm font-bold"
        >
          {saving ? "Saving…" : "Save wheel"}
        </button>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <input
                className="ff-input w-full"
                value={wheel.title}
                onChange={(e) => setWheel({ ...wheel, title: e.target.value })}
              />
            </Field>
            <Field label="Brand color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-12 rounded border border-line bg-transparent"
                  value={wheel.brandColor ?? "#ec4899"}
                  onChange={(e) => setWheel({ ...wheel, brandColor: e.target.value })}
                />
                <input
                  className="ff-input w-full flex-1"
                  value={wheel.brandColor ?? ""}
                  onChange={(e) => setWheel({ ...wheel, brandColor: e.target.value })}
                />
              </div>
            </Field>
            <Field label="Subtitle" full>
              <input
                className="ff-input w-full"
                value={wheel.subtitle ?? ""}
                onChange={(e) => setWheel({ ...wheel, subtitle: e.target.value })}
              />
            </Field>
          </div>

          <div className="card mt-6 rounded-xl p-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Odds
            </span>
            <div className="mt-2">
              <OddsBar prizes={wheel.prizes} odds={oddsPct} />
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {wheel.prizes.map((p, index) => {
              const swatch = p.color ?? RARITY_COLORS[p.rarity];
              return (
                <div
                  key={p.id}
                  draggable
                  onDragStart={() => setDragIdx(index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIdx !== null) movePrize(dragIdx, index);
                    setDragIdx(null);
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  className={`card rounded-xl p-3 ${dragIdx === index ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="shrink-0 cursor-grab select-none px-1 text-muted"
                      aria-label="Drag to reorder"
                      title="Drag to reorder"
                    >
                      ☰
                    </span>
                    <div className="flex shrink-0 flex-col">
                      <button
                        type="button"
                        onClick={() => movePrize(index, index - 1)}
                        disabled={index === 0}
                        className="rounded px-1 text-xs leading-tight text-muted transition hover:bg-white/5 hover:text-ink disabled:opacity-30"
                        aria-label="Move prize up"
                        title="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => movePrize(index, index + 1)}
                        disabled={index === wheel.prizes.length - 1}
                        className="rounded px-1 text-xs leading-tight text-muted transition hover:bg-white/5 hover:text-ink disabled:opacity-30"
                        aria-label="Move prize down"
                        title="Move down"
                      >
                        ▼
                      </button>
                    </div>
                    <input
                      aria-label="Emoji"
                      className="ff-input w-11 shrink-0 text-center text-base"
                      value={p.emoji ?? ""}
                      onChange={(e) => updatePrize(p.id, { emoji: e.target.value })}
                    />
                    <input
                      aria-label="Prize name"
                      className="ff-input min-w-0 flex-1"
                      value={p.label}
                      onChange={(e) => updatePrize(p.id, { label: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => duplicateAt(index)}
                      className="shrink-0 rounded-lg px-2 py-2 text-muted transition hover:bg-white/5 hover:text-ink"
                      title="Duplicate prize"
                      aria-label="Duplicate prize"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      onClick={() => removePrize(p.id)}
                      className="shrink-0 rounded-lg px-2 py-2 text-muted transition hover:bg-white/5 hover:text-red-400"
                      title="Remove prize"
                      aria-label="Remove prize"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {EMOJI_SUGGESTIONS.map((emo) => (
                      <button
                        key={emo}
                        type="button"
                        onClick={() => updatePrize(p.id, { emoji: emo })}
                        className="rounded-md border border-line px-1.5 py-0.5 text-sm transition hover:bg-white/5"
                        aria-label={`Use emoji ${emo}`}
                        title={`Use ${emo}`}
                      >
                        {emo}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">Tip: type or paste any emoji.</p>

                  <Field label="Cost (your cost)">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      className="ff-input tnum w-full text-right"
                      value={p.cost == null ? "" : (p.cost ?? 0) / 100}
                      onChange={(e) =>
                        updatePrize(p.id, {
                          cost:
                            e.target.value === ""
                              ? null
                              : Math.round(Number(e.target.value) * 100),
                        })
                      }
                    />
                  </Field>

                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Field label="Rarity">
                      <select
                        className="ff-input w-full"
                        value={p.rarity}
                        onChange={(e) => changeRarity(p, e.target.value as Rarity)}
                      >
                        {RARITY_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Tickets">
                      <input
                        type="number"
                        min={0}
                        className="ff-input tnum w-full text-right"
                        value={p.weight}
                        onChange={(e) => updatePrize(p.id, { weight: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="Stock">
                      <input
                        type="number"
                        min={0}
                        placeholder="∞"
                        className="ff-input tnum w-full text-right"
                        value={p.stock ?? ""}
                        onChange={(e) =>
                          updatePrize(p.id, {
                            stock: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Odds
                      </span>
                      <span className="tnum py-2 text-right font-mono font-semibold text-[var(--brand)]">
                        {(odds.get(p.id)! * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <Field label="Color">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
                        value={swatch}
                        onChange={(e) => updatePrize(p.id, { color: e.target.value })}
                        aria-label="Prize color"
                      />
                      <input
                        className="ff-input min-w-0 flex-1"
                        value={swatch}
                        onChange={(e) => updatePrize(p.id, { color: e.target.value })}
                        aria-label="Prize color hex"
                      />
                      <button
                        type="button"
                        onClick={() => updatePrize(p.id, { color: RARITY_COLORS[p.rarity] })}
                        className="shrink-0 text-xs font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline"
                      >
                        Reset to rarity color
                      </button>
                    </div>
                  </Field>

                  <Field label="Description (shown on win)">
                    <textarea
                      className="ff-input w-full"
                      rows={2}
                      value={p.description ?? ""}
                      onChange={(e) => updatePrize(p.id, { description: e.target.value })}
                    />
                  </Field>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={addPrize}
              className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-white/5"
            >
              + Add prize
            </button>
            <button
              type="button"
              onClick={() => setWheel({ ...wheel, prizes: balanceOdds(wheel.prizes) })}
              className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-white/5"
            >
              Balance odds
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-4 self-start rounded-2xl border border-line bg-surface p-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Live preview</p>
          <Wheel prizes={wheel.prizes} brandColor={wheel.brandColor ?? "#ec4899"} result={null} size={280} />
          <p className="text-center text-xs text-muted">
            Think of <strong>tickets</strong> like a raffle: a prize&rsquo;s chance is its
            tickets ÷ all tickets. The <span className="text-[var(--brand)]">%</span> next to
            each prize is its real odds — it updates live as you add prizes or change tickets.
            Pick a rarity and we fill sensible tickets for you.
          </p>
        </div>
      </div>

      {/* Library lives at the bottom: you build the wheel first, then optionally
          save it as a template or pull reusable prizes/templates in. */}
      <div className="mt-6 rounded-xl border border-line bg-surface">
        <button
          type="button"
          onClick={() => setShowLibrary((v) => !v)}
          aria-expanded={showLibrary}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span className="font-bold text-ink">📚 Prize &amp; wheel library</span>
          <span className="text-sm font-semibold text-muted">
            {showLibrary ? "Hide ▲" : "Save / reuse prizes & templates ▼"}
          </span>
        </button>
        {showLibrary && (
          <div className="border-t border-line px-4 py-4">
            <TemplateLibrary
              onApplyWheelTemplate={applyWheelTemplate}
              onSaveCurrentWheelAsTemplate={saveCurrentWheelAsTemplate}
              onApplyPrizeTemplate={applyPrizeTemplate}
              onSaveCurrentPrizesToLibrary={saveCurrentPrizesToLibrary}
            />
          </div>
        )}
      </div>
    </div>
  );
}

