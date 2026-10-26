"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import type { CreatorOverview, RedemptionItem, RedemptionStatus } from "@/lib/data/types";

// 24×24 stroke paths (Command Center prototype line icons).
const P = {
  check: "M20 6 9 17l-5-5",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
};

function Glyph({ d, size = 15, className = "" }: { d: string; size?: number; className?: string }) {
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

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const ghostBtn =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-line px-3 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink";

type Patch = { status?: RedemptionStatus; notes?: string | null; dueAt?: string | null };

// ---------------------------------------------------------------------------
// Fulfilment queue (Command Center "Run › Fulfilment")
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
  async function patchRow(id: string, patch: Patch) {
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
  // Server count (metrics.pending), not the list length: the list is capped.
  const pendingCount = data?.metrics.pending ?? 0;

  const emptyBody =
    q !== ""
      ? "No prizes match that search. Clear it to see the rest of the queue."
      : redemptions.length === 0
        ? "Wins show up here the moment a fan spins. Create a fan link and share it."
        : "No prizes in this status. Switch filters to see the rest of the queue.";

  return (
    <div className="max-w-[780px]">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
          Prize queue
        </h2>
        <button type="button" onClick={refresh} className={ghostBtn}>
          <Glyph d={P.refresh} size={14} />
          Refresh
        </button>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
          {(["pending", "in_progress", "fulfilled", "cancelled", "all"] as const).map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setFilter(f);
                  setPage(1);
                }}
                className={`min-h-9 shrink-0 rounded-full border px-3.5 text-[12.5px] font-semibold transition-colors ${
                  active
                    ? "border-[color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-brand"
                    : "border-line text-muted hover:text-ink"
                }`}
              >
                {f === "all" ? "All" : STATUS_LABEL[f]}
                {f === "pending" && pendingCount > 0 && (
                  <span className="tnum"> · {pendingCount}</span>
                )}
              </button>
            );
          })}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search fan or prize…"
          aria-label="Search redemptions by fan or prize"
          className="ff-input min-h-9 w-full min-w-0 py-1.5 text-[13px] sm:ml-auto sm:w-56"
        />
      </div>

      {loading && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the queue">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[68px] rounded-[13px]" />
          ))}
        </div>
      )}

      {!loading && shown.length === 0 && (
        <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-[var(--hair)] px-8 py-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-brand">
            <Glyph d={P.check} size={22} />
          </span>
          <p className="text-[15px] font-bold text-ink">All clear here</p>
          <p className="max-w-80 text-[13px] text-muted text-pretty">{emptyBody}</p>
        </div>
      )}

      {shown.length > 0 && (
        <ul className="flex flex-col gap-2">
          {shown.map((r) => (
            <RedemptionRow key={r.id} r={r} onSet={setStatus} onPatch={patchRow} />
          ))}
        </ul>
      )}

      {!loading && shown.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
          <span className="tnum">
            Showing {shown.length} of {matched.length}
          </span>
          {hasMore && (
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              className={`${ghostBtn} text-ink`}
            >
              Load more
            </button>
          )}
        </div>
      )}
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

// "Mark fulfilled" (not the prototype's "Fulfil"): it reads unambiguously next
// to an "In progress" pill, and the e2e journey already matches it.
const STATUS_CTA: Record<RedemptionStatus, string> = {
  pending: "Start",
  in_progress: "Mark fulfilled",
  fulfilled: "Reopen",
  cancelled: "Reopen",
};

// Pill tints: light foregrounds so 12px bold text clears AA on the dark surface.
const STATUS_PILL: Record<RedemptionStatus, string> = {
  pending: "bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted",
  in_progress: "bg-[#f59e0b]/15 text-[#fcd34d]",
  fulfilled: "bg-[#22c55e]/15 text-[#86efac]",
  cancelled: "bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted",
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
  onPatch: (id: string, patch: Patch) => void;
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
  const subject = `${r.prizeLabel} for ${r.fanName}`;
  const canCancel = r.status !== "cancelled" && r.status !== "fulfilled";
  // "Cancel prize" asks first, in a full-width strip under the row header (so
  // it can wrap on phones). Closing it with Keep/Escape refocuses the trigger.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreCancelFocus = useRef(false);
  useEffect(() => {
    if (!confirmingCancel && restoreCancelFocus.current) {
      restoreCancelFocus.current = false;
      cancelTriggerRef.current?.focus();
    }
  }, [confirmingCancel]);

  function commitNotes() {
    const next = notes.trim() ? notes : null;
    if ((r.notes ?? "") !== (next ?? "")) onPatch(r.id, { notes: next });
  }

  return (
    <li
      className={`lift-in flex flex-col gap-3 rounded-[13px] px-4 py-[13px] transition-[border-color] duration-150 hover:border-[color-mix(in_oklab,var(--brand)_30%,var(--hair))] ${raised}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] text-xl"
            style={{ backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)` }}
          >
            {r.emoji ?? "🎁"}
          </div>
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-ink">{r.prizeLabel}</p>
            <p className="mt-0.5 break-words text-[12.5px] text-muted">
              {/* Lightened toward white so low-luminance rarities (common gray) stay readable. */}
              <span style={{ color: `color-mix(in oklab, ${color} 62%, white)` }}>
                {RARITY_LABEL[r.rarity]}
              </span>{" "}
              · {r.fanName} ·{" "}
              <time dateTime={r.at} className="tnum">
                {new Date(r.at).toLocaleString()}
              </time>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {overdue && (
            <span className="rounded-full bg-[#ef4444]/15 px-[11px] py-1 text-xs font-bold text-[#fca5a5]">
              Overdue
            </span>
          )}
          <span className={`rounded-full px-[11px] py-1 text-xs font-bold ${STATUS_PILL[r.status]}`}>
            {STATUS_LABEL[r.status]}
          </span>
          <button
            type="button"
            onClick={() => onSet(r.id, STATUS_NEXT[r.status])}
            aria-label={`${STATUS_CTA[r.status]}: ${subject}`}
            className="btn-brand min-h-9 rounded-[9px] px-3.5 text-[12.5px] font-bold"
          >
            {STATUS_CTA[r.status]}
          </button>
          {canCancel && !confirmingCancel && (
            <button
              ref={cancelTriggerRef}
              type="button"
              onClick={() => setConfirmingCancel(true)}
              aria-label={`Cancel prize: ${subject}`}
              className={ghostBtn}
            >
              Cancel prize
            </button>
          )}
        </div>
      </div>

      {canCancel && confirmingCancel && (
        <CancelConfirm
          subject={subject}
          onConfirm={() => onSet(r.id, "cancelled")}
          onKeep={() => {
            restoreCancelFocus.current = true;
            setConfirmingCancel(false);
          }}
        />
      )}

      {/* Note + due date sit on every row (as before the redesign), restyled. */}
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
            Note
          </span>
          <input
            className="ff-input min-w-0 py-1.5 text-[13px]"
            placeholder="Add a note (e.g. shipped via DHL #123)…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={commitNotes}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
            Due
          </span>
          <input
            type="date"
            className="ff-input tnum min-w-0 py-1.5 text-[13px]"
            value={dueValue}
            onChange={(e) =>
              onPatch(r.id, { dueAt: e.target.value ? e.target.value : null })
            }
          />
        </label>
      </div>
    </li>
  );
}

/**
 * The two-step confirm for "Cancel prize", so a stray click never cancels a
 * win. It takes focus on open; Escape or "Keep" closes it.
 */
function CancelConfirm({
  subject,
  onConfirm,
  onKeep,
}: {
  subject: string;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      role="group"
      aria-label="Confirm cancelling this prize"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onKeep();
        }
      }}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[11px] border border-[#ef4444]/25 bg-[#ef4444]/[0.06] px-3 py-2.5"
    >
      <p id={questionId} className="min-w-0 flex-1 basis-48 text-[12.5px] text-ink text-pretty">
        Cancel {subject}? It leaves the queue; you can reopen it from the Cancelled filter.
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          aria-describedby={questionId}
          className="inline-flex min-h-9 items-center rounded-[9px] border border-[#ef4444]/35 px-3 text-[12.5px] font-semibold text-[#fca5a5] transition-colors hover:bg-[#ef4444]/10"
        >
          Cancel prize
        </button>
        <button type="button" onClick={onKeep} className={`${ghostBtn} text-ink`}>
          Keep
        </button>
      </div>
    </div>
  );
}
