"use client";

import { useCallback, useEffect, useState } from "react";
import type { Campaign, CampaignStats } from "@/lib/data/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { useToast } from "@/components/ui/Toast";
import { EmptyState, Field } from "./ui";

// Self-contained Campaigns tab. Creators name a campaign, attach it to the
// links they mint, then compare performance (spins, fans, fulfilment, top
// prize) across promotions. Owns its own fetch + refresh so it can live behind
// a lazily-mounted tab. Mobile-first: cards stack with no horizontal overflow.
export default function CampaignsPanel() {
  const toast = useToast();
  const [stats, setStats] = useState<CampaignStats[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    // Stats already carry the campaign rows (newest first), so one fetch covers
    // the whole comparison list. /api/campaigns stays available for callers that
    // only need the bare list.
    const res = await fetch("/api/campaigns/stats", { cache: "no-store" });
    if (res.ok) setStats(((await res.json()).stats ?? []) as CampaignStats[]);
    else setStats([]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, [load]);

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
    <div className="max-w-3xl space-y-6">
      {/* Create */}
      <div className="card rounded-xl p-5">
        <h3 className="font-bold text-ink">Create a campaign</h3>
        <p className="mt-1 text-sm text-muted">
          Name a promotion, then attach it to the links you mint to compare how
          each one performs.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Campaign name">
            <input
              className="ff-input w-56"
              placeholder="Summer drop"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createCampaign();
              }}
            />
          </Field>
          <button
            onClick={createCampaign}
            disabled={creating || !name.trim()}
            className="btn-brand rounded-lg px-5 py-2 text-sm font-bold"
          >
            {creating ? "Creating…" : "Create campaign"}
          </button>
        </div>
      </div>

      {/* Comparison list */}
      {stats === null ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="skeleton h-28 rounded-xl" />
          ))}
        </div>
      ) : stats.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          body="Create a campaign above, then attach it to the fan links you mint to compare their performance side by side."
        />
      ) : (
        <div className="space-y-4">
          {stats.map((s) => (
            <CampaignCard key={s.campaign.id} stats={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignCard({ stats }: { stats: CampaignStats }) {
  const { campaign, spins, uniqueFans, fulfilled, topPrize } = stats;
  const cells = [
    { label: "Spins", value: spins },
    { label: "Unique fans", value: uniqueFans },
    { label: "Fulfilled", value: fulfilled },
  ];

  return (
    <section className="card rounded-xl p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate font-bold text-ink">{campaign.name}</h3>
        {!campaign.isActive && (
          <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs font-semibold text-muted">
            Inactive
          </span>
        )}
      </div>

      {/* Hairline-divided stat row, like the metrics tab. */}
      <dl className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line">
        {cells.map((c) => (
          <div key={c.label} className="bg-base px-4 py-3">
            <dd className="tnum text-xl font-bold text-ink">{c.value}</dd>
            <dt className="mt-0.5 text-xs font-medium uppercase tracking-wide text-muted">
              {c.label}
            </dt>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-muted">Top prize</span>
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
          <span className="text-muted">—</span>
        )}
      </div>
    </section>
  );
}
