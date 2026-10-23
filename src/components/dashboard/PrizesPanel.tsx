"use client";

import { useEffect, useState } from "react";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import type { CreatorOverview, RedemptionItem, RedemptionStatus } from "@/lib/data/types";
import { EmptyState } from "./ui";

// ---------------------------------------------------------------------------
// Prizes fulfilment queue
// ---------------------------------------------------------------------------
export default function PrizesPanel({
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
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const PER_PAGE = 15;

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
  const q = search.trim().toLowerCase();
  const matched = redemptions
    .filter((r) => filter === "all" || r.status === filter)
    .filter(
      (r) =>
        q === "" ||
        r.fanName.toLowerCase().includes(q) ||
        r.prizeLabel.toLowerCase().includes(q)
    );
  const shown = matched.slice(0, page * PER_PAGE);
  const hasMore = matched.length > shown.length;
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

      <div className="mt-4 flex gap-2 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(["pending", "in_progress", "fulfilled", "cancelled", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => {
              setFilter(f);
              setPage(1);
            }}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
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

      <input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        placeholder="Search by fan or prize…"
        aria-label="Search redemptions by fan or prize"
        className="ff-input mt-3 w-full"
      />

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
        {!loading && shown.length > 0 && (
          <div className="flex items-center justify-between pt-1 text-xs text-muted">
            <span>
              Showing {shown.length} of {matched.length}
            </span>
            {hasMore && (
              <button
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-line px-3 py-1.5 font-semibold text-ink transition hover:bg-white/5"
              >
                Load more
              </button>
            )}
          </div>
        )}
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
