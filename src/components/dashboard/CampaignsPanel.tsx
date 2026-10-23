"use client";

import { useCallback, useEffect, useState } from "react";
import type { Campaign, CampaignStats, WheelSummary } from "@/lib/data/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { useToast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/format";
import { Field } from "./ui";
import PackEditor from "./PackEditor";

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const ghostBtn =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-line px-3 text-[12.5px] font-semibold text-muted transition-colors hover:border-[color-mix(in_oklab,var(--brand)_35%,var(--color-line))] hover:text-ink disabled:opacity-50";

// 24x24 line icons (Command Center set); the megaphone is the sidebar's
// Campaigns glyph so the empty state matches the nav item.
const ICON = {
  megaphone: "M3 11v2a1 1 0 0 0 1 1h1.5L10 18V6L5.5 10H4a1 1 0 0 0-1 1ZM14 8a5 5 0 0 1 0 8M17.5 5a9 9 0 0 1 0 14",
  chevron: "m6 9 6 6 6-6",
};

function Glyph({ d, size = 14, className = "" }: { d: string; size?: number; className?: string }) {
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink">
      <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
      {children}
    </h2>
  );
}

// Hairline-divided stat grid on recessed cells: 2 columns on phones, 4 from sm.
function StatGrid({ cells }: { cells: { label: string; value: string | number }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--hair)] bg-[var(--hair)] sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0 px-3.5 py-3 [background:var(--s2)] sm:px-[15px]">
          <dd className="tnum truncate text-lg font-bold text-ink">{c.value}</dd>
          <dt className="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.04em] text-muted">
            {c.label}
          </dt>
        </div>
      ))}
    </dl>
  );
}

// Self-contained Campaigns tab. Creators name a campaign, attach it to the
// links they mint, then compare performance (spins, fans, fulfilment, top
// prize) across promotions. Owns its own fetch + refresh so it can live behind
// a lazily-mounted tab. Command Center styling; mobile-first, no horizontal overflow.
export default function CampaignsPanel() {
  const toast = useToast();
  const [stats, setStats] = useState<CampaignStats[] | null>(null);
  const [uncat, setUncat] = useState<{ revenue: number; spinsBought: number; spinsPlayed: number; fans: number } | null>(null);
  const [wheels, setWheels] = useState<WheelSummary[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    // Stats already carry the campaign rows (newest first), so one fetch covers
    // the whole comparison list. /api/campaigns stays available for callers that
    // only need the bare list.
    const res = await fetch("/api/campaigns/stats", { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      setStats((d.stats ?? []) as CampaignStats[]);
      setUncat(d.uncategorized ?? null);
    } else setStats([]);
  }, []);

  // Fetch the creator's wheels once so each campaign can offer a pin selector.
  const loadWheels = useCallback(async () => {
    const res = await fetch("/api/wheels", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { wheels?: WheelSummary[] };
      setWheels(data.wheels ?? []);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
    loadWheels();
  }, [load, loadWheels]);

  async function createCampaign() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await res.json()) as { campaign?: Campaign; error?: string };
      if (!res.ok || !data.campaign) {
        toast(
          data.error === "unauthorized"
            ? "Couldn't create campaign. Are you signed in?"
            : "Couldn't create campaign. Try again.",
          { tone: "error" }
        );
        return;
      }
      setName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex max-w-[820px] flex-col gap-[18px]">
      {/* Create */}
      <section className={`lift-in rounded-2xl p-4 sm:p-5 ${raised}`}>
        <SectionTitle>Create a campaign</SectionTitle>
        <p className="mt-1 text-[13px] text-muted">
          Name a promotion, then attach it to the links you mint to compare how
          each one performs.
        </p>
        <div className="mt-3.5 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-56 sm:max-w-60 sm:flex-none">
            <Field label="Campaign name">
              <input
                className="ff-input w-full"
                placeholder="Summer drop"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createCampaign();
                }}
              />
            </Field>
          </div>
          <button
            onClick={createCampaign}
            disabled={creating || !name.trim()}
            className="btn-brand min-h-10 rounded-[10px] px-[18px] text-sm font-bold"
          >
            {creating ? "Creating…" : "Create campaign"}
          </button>
        </div>
      </section>

      {/* Uncategorized: revenue/spins not tagged to any campaign, so it's never
          invisible. Appears only when there's something untracked. */}
      {uncat && (uncat.revenue > 0 || uncat.spinsBought > 0) && (
        <section className="lift-in rounded-2xl border border-dashed border-amber-400/40 bg-amber-400/5 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-bold text-ink">Uncategorized</h2>
            <span className="text-[11px] text-amber-300">no campaign attached</span>
          </div>
          <p className="mt-1 text-[13px] text-muted">
            Spins/revenue from top-ups with no campaign selected. Pick a campaign on
            future top-ups to attribute them.
          </p>
          <div className="mt-3">
            <StatGrid
              cells={[
                { label: "Revenue", value: formatCents(uncat.revenue) },
                { label: "Spins bought", value: uncat.spinsBought },
                { label: "Spins played", value: uncat.spinsPlayed },
                { label: "Fans", value: uncat.fans },
              ]}
            />
          </div>
        </section>
      )}

      {/* Comparison list */}
      {stats === null ? (
        <div className="flex flex-col gap-[18px]" aria-busy="true" aria-label="Loading campaigns">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="skeleton h-52 rounded-2xl" />
          ))}
        </div>
      ) : stats.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-[var(--hair)] px-6 py-12 text-center sm:px-8">
          <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-brand">
            <Glyph d={ICON.megaphone} size={22} />
          </span>
          <p className="text-[15px] font-bold text-ink">No campaigns yet</p>
          <p className="max-w-sm text-[13px] text-muted text-pretty">
            Create a campaign above, then attach it to the fan links you mint to compare their
            performance side by side.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-[18px]">
          {stats.map((s) => (
            <CampaignCard key={s.campaign.id} stats={s} wheels={wheels} onRefresh={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignCard({
  stats,
  wheels,
  onRefresh,
}: {
  stats: CampaignStats;
  wheels: WheelSummary[];
  onRefresh: () => Promise<void> | void;
}) {
  const toast = useToast();
  const { campaign, revenue, arpu, spinsBought, spinsPlayed, uniqueFans, fulfilled, topPrize } =
    stats;
  const [showPacks, setShowPacks] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(campaign.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function saveName() {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === campaign.name) {
      setEditingName(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        toast("Couldn't rename campaign.", { tone: "error" });
        return;
      }
      toast("Campaign renamed.", { tone: "success" });
      setEditingName(false);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Couldn't delete campaign.", { tone: "error" });
        return;
      }
      toast("Campaign deleted.", { tone: "success" });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function pinWheel(value: string) {
    setPinning(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedWheelId: value || null }),
      });
      if (!res.ok) {
        toast("Couldn't update the pinned wheel. Try again.", { tone: "error" });
        return;
      }
      toast(value ? "Pinned wheel updated." : "Pin removed.", { tone: "success" });
      await onRefresh();
    } finally {
      setPinning(false);
    }
  }

  const cells = [
    { label: "Revenue", value: formatCents(revenue) },
    { label: "ARPU", value: formatCents(arpu) },
    { label: "Spins bought", value: spinsBought },
    { label: "Spins played", value: spinsPlayed },
    { label: "Play-through", value: `${Math.round(stats.playThroughPct * 100)}%` },
    { label: "Unique fans", value: uniqueFans },
    { label: "Fulfilled", value: fulfilled },
    { label: "Pending", value: stats.pending },
  ];

  return (
    <section className={`lift-in rounded-2xl p-4 sm:p-5 ${raised}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {editingName ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") {
                  setDraftName(campaign.name);
                  setEditingName(false);
                }
              }}
              aria-label="Campaign name"
              className="ff-input min-w-0 flex-1"
            />
            <button
              onClick={saveName}
              disabled={busy}
              className="btn-brand min-h-9 shrink-0 rounded-[9px] px-3.5 text-[12.5px] font-bold disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => {
                setDraftName(campaign.name);
                setEditingName(false);
              }}
              className={`${ghostBtn} shrink-0`}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="min-w-0 truncate text-base font-bold tracking-[-0.01em] text-ink">
                {campaign.name}
              </h2>
              {!campaign.isActive && (
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold text-muted">
                  Inactive
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
              <span>Top prize</span>
              {topPrize ? (
                <span className="flex min-w-0 items-center gap-1.5 font-semibold text-ink">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: RARITY_COLORS[topPrize.rarity] }}
                  />
                  <span className="truncate">{topPrize.label}</span>
                  <span className="tnum shrink-0 text-muted">×{topPrize.count}</span>
                </span>
              ) : (
                <span>—</span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="mt-4">
        <StatGrid cells={cells} />
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-3 border-t border-[var(--hair)] pt-3.5">
        {/* Pinned wheel selector. */}
        <label className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
          Pinned wheel
          <select
            className="ff-input min-w-0 max-w-full text-[13px]"
            style={{ width: "auto" }}
            value={campaign.pinnedWheelId ?? ""}
            disabled={pinning}
            onChange={(e) => pinWheel(e.target.value)}
          >
            <option value="">No pin (use active wheel)</option>
            {wheels.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {/* Spin packs (collapsible to keep the panel tidy). */}
          <button
            type="button"
            onClick={() => setShowPacks((v) => !v)}
            aria-expanded={showPacks}
            className={ghostBtn}
          >
            Spin packs
            <Glyph
              d={ICON.chevron}
              size={13}
              className={`transition-transform ${showPacks ? "rotate-180" : ""}`}
            />
          </button>
          {!editingName && (
            <>
              <button
                onClick={() => {
                  setDraftName(campaign.name);
                  setEditingName(true);
                }}
                className={ghostBtn}
              >
                Rename
              </button>
              {confirmDelete ? (
                <>
                  <button
                    onClick={remove}
                    disabled={busy}
                    className="inline-flex min-h-9 items-center rounded-[9px] border border-[#ef4444] px-3 text-[12.5px] font-semibold text-[#f87171] transition-colors hover:bg-[#ef4444]/10 disabled:opacity-50"
                  >
                    Confirm
                  </button>
                  <button onClick={() => setConfirmDelete(false)} className={ghostBtn}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className={`${ghostBtn} !text-[#f87171] hover:!border-[#ef4444]/60`}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Pinned: fans in this campaign always spin this wheel.
      </p>

      {showPacks && (
        <div className="mt-4">
          <PackEditor campaignId={campaign.id} />
        </div>
      )}
    </section>
  );
}
