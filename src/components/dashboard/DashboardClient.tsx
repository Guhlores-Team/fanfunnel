"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  CreatorMetricsExtra,
  CreatorOverview,
  FanAccountSummary,
  RedemptionItem,
  RedemptionStatus,
} from "@/lib/data/types";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { OddsBar } from "@/components/dashboard/OddsBar";
import Sparkline from "@/components/dashboard/Sparkline";
import Funnel from "@/components/dashboard/Funnel";
import { EmptyState, Field } from "./ui";
import FanDetailDrawer from "@/components/dashboard/FanDetailDrawer";
import CampaignsPanel from "@/components/dashboard/CampaignsPanel";
import {
  EMOJI_SUGGESTIONS,
  balanceOdds,
  duplicatePrize,
  newPrize,
  reorder,
} from "@/components/dashboard/editorHelpers";

type Tab = "metrics" | "prizes" | "fans" | "campaigns" | "editor";

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
  const [tab, setTab] = useState<Tab>("metrics");
  const [wheel, setWheel] = useState<WheelConfig>(() => structuredClone(initialWheel));
  const overview = useOverview();
  const pending = overview.data?.metrics.pending ?? 0;

  const tabs: [Tab, string][] = [
    ["metrics", "Metrics"],
    ["prizes", "Prizes"],
    ["fans", "Fans & links"],
    ["campaigns", "Campaigns"],
    ["editor", "Wheel editor"],
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

      <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-semibold transition ${
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
          </button>
        ))}
      </nav>

      <div className="mt-7">
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
        {tab === "editor" && (
          <WheelEditor wheel={wheel} setWheel={setWheel} initialWheel={initialWheel} />
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
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
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

        {/* Conversion */}
        <section className="card rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ink">Conversion</h3>
          <p className="mt-0.5 text-xs text-muted">Link → spin → fulfilled.</p>
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

  async function setStatus(id: string, status: RedemptionStatus) {
    setData((d) =>
      d ? { ...d, redemptions: d.redemptions.map((r) => (r.id === id ? { ...r, status } : r)) } : d
    );
    await fetch("/api/redemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    refresh();
  }

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
        {(["pending", "fulfilled", "cancelled", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
              filter === f
                ? "bg-[var(--brand)] text-white"
                : "border border-line text-muted hover:text-ink"
            }`}
          >
            {f}
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
          <RedemptionRow key={r.id} r={r} onSet={setStatus} />
        ))}
      </div>
    </div>
  );
}

function RedemptionRow({
  r,
  onSet,
}: {
  r: RedemptionItem;
  onSet: (id: string, status: RedemptionStatus) => void;
}) {
  const color = RARITY_COLORS[r.rarity];
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 rounded-xl p-3">
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
        {r.status === "pending" ? (
          <>
            <button
              onClick={() => onSet(r.id, "fulfilled")}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-400"
            >
              Mark fulfilled
            </button>
            <button
              onClick={() => onSet(r.id, "cancelled")}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
            >
              Cancel
            </button>
          </>
        ) : (
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              r.status === "fulfilled"
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-white/10 text-muted"
            }`}
          >
            {r.status === "fulfilled" ? "Fulfilled" : "Cancelled"}
            <button
              onClick={() => onSet(r.id, "pending")}
              className="ml-2 underline opacity-70 hover:opacity-100"
            >
              undo
            </button>
          </span>
        )}
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
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [openFanId, setOpenFanId] = useState<string | null>(null);
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
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
    loadCampaigns();
  }, [load, loadCampaigns]);

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
      const data = await call({ name: name.trim(), spins, campaignId: campaignId || undefined });
      if (data) {
        setName("");
        await load();
      }
    } finally {
      setCreating(false);
    }
  }

  async function addLink(fanId: string, addSpins: number) {
    const data = await call({ fanId, spins: addSpins });
    if (data) await load();
  }

  return (
    <div className="max-w-2xl">
      <div className="card rounded-xl p-5">
        <h3 className="font-bold text-ink">Create a fan account</h3>
        <p className="mt-1 text-sm text-muted">
          You create the account; the fan never signs up. Balance and win history
          live on the account, so you can mint fresh links anytime.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
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
              onChange={(e) => setSpins(Math.max(1, Number(e.target.value)))}
            />
          </Field>
          <Field label="Campaign (optional)">
            <select
              className="ff-input w-44"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
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
            className="btn-brand rounded-lg px-5 py-2 text-sm font-bold"
          >
            {creating ? "Creating…" : "Create account"}
          </button>
        </div>
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
        {accounts?.map((acc) => (
          <AccountCard
            key={acc.fanId}
            account={acc}
            origin={origin}
            onAddLink={addLink}
            onOpen={setOpenFanId}
          />
        ))}
      </div>
      <FanDetailDrawer fanId={openFanId} onClose={() => setOpenFanId(null)} />
    </div>
  );
}

function AccountCard({
  account,
  origin,
  onAddLink,
  onOpen,
}: {
  account: FanAccountSummary;
  origin: string;
  onAddLink: (fanId: string, spins: number) => void;
  onOpen: (fanId: string) => void;
}) {
  const [topUp, setTopUp] = useState(3);
  return (
    <div className="card rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen(account.fanId)}
          aria-label={"View " + account.name}
          className="min-w-0 rounded-lg text-left transition hover:opacity-80"
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
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            className="ff-input tnum w-16 text-right"
            value={topUp}
            onChange={(e) => setTopUp(Math.max(1, Number(e.target.value)))}
          />
          <button
            onClick={() => onAddLink(account.fanId, topUp)}
            className="rounded-lg border border-[var(--brand)]/50 px-3 py-1.5 text-xs font-bold text-[var(--brand)] transition hover:bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]"
          >
            Top up + new link
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {account.links.map((l, i) => (
          <LinkRow key={l.token} url={`${origin}/spin/${l.token}`} latest={i === 0} />
        ))}
      </div>
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
}: {
  wheel: WheelConfig;
  setWheel: (w: WheelConfig) => void;
  initialWheel: WheelConfig;
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
    const wasDefault = p.color == null || p.color === RARITY_COLORS[p.rarity];
    updatePrize(p.id, {
      rarity,
      color: wasDefault ? RARITY_COLORS[rarity] : p.color,
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
                    <Field label="Weight">
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
            Low weight plus limited stock is what makes the best prizes feel rare.
          </p>
        </div>
      </div>
    </div>
  );
}

