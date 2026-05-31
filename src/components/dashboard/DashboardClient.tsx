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
  CreatorOverview,
  RedemptionItem,
  RedemptionStatus,
} from "@/lib/data/types";

type Tab = "editor" | "fans" | "prizes" | "metrics";

// A persistent fan account, with the (possibly many) links minted for it.
// Balance + win history live on the account, so any link shows the full story.
interface FanAccount {
  fanId: string;
  name: string;
  grantedTotal: number;
  links: { token: string; spins: number }[];
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
  const [tab, setTab] = useState<Tab>("editor");
  const [wheel, setWheel] = useState<WheelConfig>(() =>
    structuredClone(initialWheel)
  );
  const [accounts, setAccounts] = useState<FanAccount[]>([]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 text-white">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Creator Dashboard</h1>
          <p className="text-sm text-white/50">
            {email ?? "Demo workspace — no sign-in (connect Supabase to go live)"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {(isAdmin || !email) && (
            <a
              href="/admin"
              className="rounded-lg bg-amber-400/15 px-3 py-1.5 text-xs font-bold text-amber-300 hover:bg-amber-400/25"
            >
              ⚡ Admin panel
            </a>
          )}
          {email && (
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/5"
              >
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>

      <nav className="mt-6 flex gap-2 border-b border-white/10">
        {(
          [
            ["editor", "🎡 Wheel editor"],
            ["fans", "🔗 Fans & links"],
            ["prizes", "🎁 Prizes"],
            ["metrics", "📊 Metrics"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              tab === id
                ? "border-pink-500 text-white"
                : "border-transparent text-white/50 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-8">
        {tab === "editor" && (
          <WheelEditor wheel={wheel} setWheel={setWheel} initialWheel={initialWheel} />
        )}
        {tab === "fans" && (
          <FansPanel accounts={accounts} setAccounts={setAccounts} />
        )}
        {tab === "prizes" && <PrizesPanel />}
        {tab === "metrics" && <MetricsPanel />}
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
        alert("Couldn't save. Are you signed in?");
      }
    } finally {
      setSaving(false);
    }
  }

  function updatePrize(id: string, patch: Partial<Prize>) {
    setWheel({
      ...wheel,
      prizes: wheel.prizes.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  }
  function addPrize() {
    const id = "p" + Math.random().toString(36).slice(2, 8);
    setWheel({
      ...wheel,
      prizes: [
        ...wheel.prizes,
        { id, label: "New prize", rarity: "common", weight: 10, emoji: "🎁" },
      ],
    });
  }
  function removePrize(id: string) {
    if (wheel.prizes.length <= 2) return;
    setWheel({ ...wheel, prizes: wheel.prizes.filter((p) => p.id !== id) });
  }

  return (
    <div>
      {/* Save bar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
        <p className="text-sm text-white/60">
          {dirty ? (
            <span className="text-amber-300">● Unsaved changes</span>
          ) : justSaved ? (
            <span className="text-green-300">✓ Saved</span>
          ) : (
            "All changes saved"
          )}
        </p>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-lg bg-pink-500 px-5 py-2 text-sm font-bold text-white hover:bg-pink-400 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save wheel"}
        </button>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div>
        {/* Wheel meta */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title">
            <input
              className="ff-input"
              value={wheel.title}
              onChange={(e) => setWheel({ ...wheel, title: e.target.value })}
            />
          </Field>
          <Field label="Brand color">
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-9 w-12 rounded bg-transparent"
                value={wheel.brandColor ?? "#ec4899"}
                onChange={(e) =>
                  setWheel({ ...wheel, brandColor: e.target.value })
                }
              />
              <input
                className="ff-input flex-1"
                value={wheel.brandColor ?? ""}
                onChange={(e) =>
                  setWheel({ ...wheel, brandColor: e.target.value })
                }
              />
            </div>
          </Field>
          <Field label="Subtitle" full>
            <input
              className="ff-input"
              value={wheel.subtitle ?? ""}
              onChange={(e) => setWheel({ ...wheel, subtitle: e.target.value })}
            />
          </Field>
        </div>

        {/* Prize table */}
        <div className="mt-6 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-left text-xs uppercase text-white/50">
              <tr>
                <th className="p-2"></th>
                <th className="p-2">Prize</th>
                <th className="p-2">Rarity</th>
                <th className="p-2 text-right">Weight</th>
                <th className="p-2 text-right">Stock</th>
                <th className="p-2 text-right">Odds</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {wheel.prizes.map((p) => (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="p-2">
                    <input
                      className="ff-input w-12 text-center"
                      value={p.emoji ?? ""}
                      onChange={(e) =>
                        updatePrize(p.id, { emoji: e.target.value })
                      }
                    />
                  </td>
                  <td className="p-2">
                    <input
                      className="ff-input w-full"
                      value={p.label}
                      onChange={(e) =>
                        updatePrize(p.id, { label: e.target.value })
                      }
                    />
                  </td>
                  <td className="p-2">
                    <select
                      className="ff-input"
                      value={p.rarity}
                      onChange={(e) =>
                        updatePrize(p.id, {
                          rarity: e.target.value as Rarity,
                          color: RARITY_COLORS[e.target.value as Rarity],
                        })
                      }
                    >
                      {RARITY_ORDER.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2 text-right">
                    <input
                      type="number"
                      min={0}
                      className="ff-input w-16 text-right"
                      value={p.weight}
                      onChange={(e) =>
                        updatePrize(p.id, { weight: Number(e.target.value) })
                      }
                    />
                  </td>
                  <td className="p-2 text-right">
                    <input
                      type="number"
                      min={0}
                      placeholder="∞"
                      className="ff-input w-16 text-right"
                      value={p.stock ?? ""}
                      onChange={(e) =>
                        updatePrize(p.id, {
                          stock:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td className="p-2 text-right font-mono text-pink-300">
                    {(odds.get(p.id)! * 100).toFixed(1)}%
                  </td>
                  <td className="p-2 text-right">
                    <button
                      onClick={() => removePrize(p.id)}
                      className="text-white/30 hover:text-red-400"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          onClick={addPrize}
          className="mt-3 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/5"
        >
          + Add prize
        </button>
      </div>

      {/* Live preview */}
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-6">
        <p className="text-xs uppercase tracking-wider text-white/40">
          Live preview
        </p>
        <Wheel
          prizes={wheel.prizes}
          brandColor={wheel.brandColor}
          result={null}
          size={300}
        />
        <p className="text-center text-xs text-white/40">
          Rare prizes with low weight + limited stock create the &ldquo;chase.&rdquo;
        </p>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fans & links
// ---------------------------------------------------------------------------
function FansPanel({
  accounts,
  setAccounts,
}: {
  accounts: FanAccount[];
  setAccounts: (updater: (a: FanAccount[]) => FanAccount[]) => void;
}) {
  const [name, setName] = useState("");
  const [spins, setSpins] = useState(3);
  const [creating, setCreating] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function call(body: object) {
    const res = await fetch("/api/passes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.token) {
      alert(
        data.error === "no_wheel"
          ? "Create a wheel first, then generate fan links."
          : "Couldn't create link. Are you signed in?"
      );
      return null;
    }
    return data as { token: string; fanId: string };
  }

  // Create a brand-new fan account + its first link.
  async function createAccount() {
    setCreating(true);
    try {
      const data = await call({ name: name.trim(), spins });
      if (data) {
        setAccounts((a) => [
          {
            fanId: data.fanId,
            name: name.trim() || "Fan",
            grantedTotal: spins,
            links: [{ token: data.token, spins }],
          },
          ...a,
        ]);
        setName("");
      }
    } finally {
      setCreating(false);
    }
  }

  // Mint another link for an EXISTING account (history + balance preserved).
  async function addLink(fanId: string, addSpins: number) {
    const data = await call({ fanId, spins: addSpins });
    if (!data) return;
    setAccounts((a) =>
      a.map((acc) =>
        acc.fanId === fanId
          ? {
              ...acc,
              grantedTotal: acc.grantedTotal + addSpins,
              links: [{ token: data.token, spins: addSpins }, ...acc.links],
            }
          : acc
      )
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="font-bold">Create a fan account</h3>
        <p className="mt-1 text-sm text-white/50">
          You create the account — the fan never signs up. Balance and win
          history stay on the account, so you can mint fresh links anytime.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Fan name / handle">
            <input
              className="ff-input"
              placeholder="@bigfan"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Spins to grant">
            <input
              type="number"
              min={1}
              className="ff-input w-24"
              value={spins}
              onChange={(e) => setSpins(Math.max(1, Number(e.target.value)))}
            />
          </Field>
          <button
            onClick={createAccount}
            disabled={creating}
            className="rounded-lg bg-pink-500 px-5 py-2 text-sm font-bold hover:bg-pink-400 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create account"}
          </button>
        </div>
        <p className="mt-3 text-xs text-white/40">
          💡 Fan tips on OnlyFans → you grant spins → DM them their link. Every
          spin wins; rare drops bring them back.
        </p>
      </div>

      <div className="mt-6 space-y-4">
        {accounts.length === 0 && (
          <p className="text-sm text-white/40">
            No fan accounts yet — create one above.
          </p>
        )}
        {accounts.map((acc) => (
          <AccountCard
            key={acc.fanId}
            account={acc}
            origin={origin}
            onAddLink={addLink}
          />
        ))}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  origin,
  onAddLink,
}: {
  account: FanAccount;
  origin: string;
  onAddLink: (fanId: string, spins: number) => void;
}) {
  const [topUp, setTopUp] = useState(3);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold">{account.name}</p>
          <p className="text-xs text-white/40">
            {account.grantedTotal} spins granted · {account.links.length} link
            {account.links.length === 1 ? "" : "s"} · history shared across all
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            className="ff-input w-16 text-right"
            value={topUp}
            onChange={(e) => setTopUp(Math.max(1, Number(e.target.value)))}
          />
          <button
            onClick={() => onAddLink(account.fanId, topUp)}
            className="rounded-lg border border-pink-400/50 px-3 py-1.5 text-xs font-bold text-pink-300 hover:bg-pink-500/10"
          >
            + Top up &amp; new link
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {account.links.map((l, i) => (
          <LinkRow
            key={l.token}
            url={`${origin}/spin/${l.token}`}
            spins={l.spins}
            latest={i === 0}
          />
        ))}
      </div>
    </div>
  );
}

function LinkRow({
  url,
  spins,
  latest,
}: {
  url: string;
  spins: number;
  latest: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
      <p className="min-w-0 truncate text-xs text-white/50">
        {url}
        {latest && (
          <span className="ml-2 rounded bg-pink-500/20 px-1.5 py-0.5 text-[10px] font-bold text-pink-300">
            NEWEST
          </span>
        )}
      </p>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-pink-500/15 px-2.5 py-1 text-xs font-bold text-pink-300">
          +{spins}
        </span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/5"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/5"
        >
          Open ↗
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview data (metrics + prize inbox) — shared by the Prizes and Metrics tabs
// ---------------------------------------------------------------------------
const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

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
  }, [refresh]);
  return { data, loading, refresh, setData };
}

// ---------------------------------------------------------------------------
// Prizes inbox — the creator's daily fulfilment queue
// ---------------------------------------------------------------------------
function PrizesPanel() {
  const { data, loading, refresh, setData } = useOverview();
  const [filter, setFilter] = useState<RedemptionStatus | "all">("pending");

  async function setStatus(id: string, status: RedemptionStatus) {
    // Optimistic update.
    setData((d) =>
      d
        ? {
            ...d,
            redemptions: d.redemptions.map((r) =>
              r.id === id ? { ...r, status } : r
            ),
          }
        : d
    );
    await fetch("/api/redemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    refresh();
  }

  const redemptions = data?.redemptions ?? [];
  const shown =
    filter === "all" ? redemptions : redemptions.filter((r) => r.status === filter);
  const pendingCount = redemptions.filter((r) => r.status === "pending").length;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">Prize fulfilment queue</h3>
          <p className="text-sm text-white/50">
            Every fan spin lands here. Deliver the prize, then mark it done.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/5"
        >
          ↻ Refresh
        </button>
      </div>

      <div className="mt-4 flex gap-2">
        {(["pending", "fulfilled", "cancelled", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
              filter === f
                ? "bg-pink-500 text-white"
                : "bg-white/5 text-white/60 hover:bg-white/10"
            }`}
          >
            {f}
            {f === "pending" && pendingCount > 0 ? ` (${pendingCount})` : ""}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {loading && <p className="text-sm text-white/40">Loading…</p>}
        {!loading && shown.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-white/40">
            Nothing here yet. Create a fan link, open it, and spin — wins show up
            instantly.
          </p>
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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg text-xl"
          style={{ backgroundColor: color + "22" }}
        >
          {r.emoji ?? "🎁"}
        </div>
        <div>
          <p className="font-semibold">{r.prizeLabel}</p>
          <p className="text-xs text-white/40">
            <span style={{ color }}>{RARITY_LABEL[r.rarity]}</span> ·{" "}
            {r.fanName} · {new Date(r.at).toLocaleString()}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {r.status === "pending" ? (
          <>
            <button
              onClick={() => onSet(r.id, "fulfilled")}
              className="rounded-lg bg-green-500/90 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-400"
            >
              ✓ Fulfilled
            </button>
            <button
              onClick={() => onSet(r.id, "cancelled")}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/60 hover:bg-white/5"
            >
              Cancel
            </button>
          </>
        ) : (
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              r.status === "fulfilled"
                ? "bg-green-500/15 text-green-300"
                : "bg-white/10 text-white/40"
            }`}
          >
            {r.status === "fulfilled" ? "✓ Fulfilled" : "Cancelled"}
            <button
              onClick={() => onSet(r.id, "pending")}
              className="ml-2 text-white/40 underline hover:text-white/70"
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
// Metrics
// ---------------------------------------------------------------------------
function MetricsPanel() {
  const { data, loading } = useOverview();
  const m = data?.metrics;
  const tiles = [
    { label: "Fan accounts", value: m?.fans ?? 0 },
    { label: "Spins played", value: m?.spinsPlayed ?? 0 },
    { label: "Prizes to fulfil", value: m?.pending ?? 0 },
    { label: "Prizes delivered", value: m?.fulfilled ?? 0 },
  ];
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-2xl border border-white/10 bg-white/5 p-5"
          >
            <p className="text-3xl font-extrabold text-pink-300">
              {loading ? "—" : t.value}
            </p>
            <p className="mt-1 text-sm text-white/50">{t.label}</p>
          </div>
        ))}
      </div>
      <p className="mt-6 text-sm text-white/40">
        These update live as fans spin. Create a fan link, open it, and spin to
        watch them move.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "sm:col-span-2" : ""}`}>
      <span className="text-xs font-semibold uppercase tracking-wider text-white/40">
        {label}
      </span>
      {children}
    </label>
  );
}
