"use client";

import LoadFailed from "./LoadFailed";
import { useEffect, useId, useRef, useState } from "react";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import type { CreatorOverview, RedemptionItem, RedemptionStatus } from "@/lib/data/types";
import { OVERVIEW_REDEMPTION_WINDOW } from "@/lib/data/queueWindow";
import { useToast } from "@/components/ui/Toast";
import { useNow } from "@/lib/hooks/useNow";
import { dueDateInRange, dueDateValue, dueDayLabel, isOverdue, localDayPlus } from "@/lib/dueDate";
import { formatWhen } from "@/lib/localTime";

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

/** What a refused fulfilment change tells the creator (the row is rolled back). */
function patchErrorMessage(error: string): string {
  switch (error) {
    case "already_delivered":
      return "Not saved: this prize was delivered to the fan instantly, so its status and due date can't change.";
    case "unauthorized":
      return "Not saved: you're signed out. Sign in again, then retry.";
    case "not_found":
      return "Not saved: this prize no longer exists. The queue has been refreshed.";
    case "sold_out":
      return "Not reopened: this prize has no limited stock left. Add stock in the game editor, then reopen it.";
    case "notes_too_long":
      return "Not saved: notes can be at most 2000 characters.";
    case "bad_due_date":
      return "Not saved: that due date isn't a valid date.";
    case "network":
      return "Not saved: couldn't reach FanFunnel. Check your connection and try again.";
    default:
      return "Not saved: something went wrong. Try again.";
  }
}

// ---------------------------------------------------------------------------
// Fulfilment queue (Command Center "Run › Fulfilment")
// ---------------------------------------------------------------------------
export default function PrizesPanel({
  data,
  loading,
  error = null,
  refresh,
  setData,
  onOpenFan,
  onMessageFan,
}: {
  data: CreatorOverview | null;
  loading: boolean;
  /** The overview's last load failure: an error, never "All clear" (C2). */
  error?: unknown;
  refresh: () => void | Promise<unknown>;
  /** C18: the fan's name opens their drawer in Fans. */
  onOpenFan?: (fanId: string) => void;
  /** C18: Message opens the fan's Inbox thread. */
  onMessageFan?: (fanId: string) => void;
  setData: React.Dispatch<React.SetStateAction<CreatorOverview | null>>;
}) {
  const [filter, setFilter] = useState<RedemptionStatus | "all">("pending");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const PER_PAGE = 15;
  // A5: wins older than the overview's newest-200 window, fetched from the
  // server for the current filter/search. `anchor` is the window row they
  // continue from; if the window moves (new wins), they are dropped and can
  // be loaded again, so no prize can fall into a gap between the two lists.
  const [older, setOlder] = useState<{ key: string; anchor: string; items: RedemptionItem[]; next: string | null } | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState(false);
  // PR-10: the creator's delivery promise (Settings › Public page), used to
  // suggest an expected-by date on wins that have no due date yet.
  const [deliveryDays, setDeliveryDays] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/public-profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (live && p && Number.isInteger(p.deliveryDays) && p.deliveryDays > 0) setDeliveryDays(p.deliveryDays);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const toast = useToast();
  // PATCH a redemption: status and/or notes/dueAt. Optimistically patch the
  // shared overview so the row updates instantly; if the server refuses, put
  // the row back the way it was and say why, then refresh authoritatively.
  async function patchRow(id: string, patch: Patch) {
    const before =
      data?.redemptions.find((r) => r.id === id) ?? older?.items.find((r) => r.id === id);
    const apply = (fields: Partial<RedemptionItem>) => {
      setOlder((o) => (o ? { ...o, items: o.items.map((r) => (r.id === id ? { ...r, ...fields } : r)) } : o));
      setData((d) =>
        d ? { ...d, redemptions: d.redemptions.map((r) => (r.id === id ? { ...r, ...fields } : r)) } : d
      );
    };
    apply(patch);
    let error: string | null = null;
    try {
      const res = await fetch(`/api/redemptions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => null)) as { error?: unknown; stock?: unknown } | null;
      if (!res.ok) {
        error = typeof body?.error === "string" ? body.error : "unknown";
      } else if (body?.stock === "returned") {
        toast("Prize cancelled. Its limited unit is back in stock.", { tone: "success" });
      } else if (body?.stock === "taken") {
        toast("Prize reopened. One limited unit is set aside for this fan again.", { tone: "success" });
      } else if ("status" in patch && patch.status && before && patch.status !== "cancelled") {
        // WC-06 / WG-08: the row leaves the current filter, so say what
        // happened and offer a way back for a mis-tap.
        const was = before.status;
        const said = patch.status === "fulfilled" ? "Marked fulfilled" : patch.status === "in_progress" ? "Marked in progress" : "Reopened";
        toast(`${said}: ${before.prizeLabel} for ${before.fanName}.`, {
          tone: "success",
          duration: 8000,
          key: `status:${id}`,
          action: { label: "Undo", onClick: () => void patchRow(id, { status: was }) },
        });
      } else if ("notes" in patch || "dueAt" in patch) {
        // The note and due date save on blur with no button, so confirm it.
        toast("notes" in patch ? (patch.notes ? "Note saved" : "Note cleared") : patch.dueAt ? "Due date saved" : "Due date cleared", { tone: "success" });
      }
    } catch {
      error = "network";
    }
    if (error !== null) {
      if (before) {
        const restore: Partial<RedemptionItem> = {};
        if ("status" in patch) restore.status = before.status;
        if ("notes" in patch) restore.notes = before.notes;
        if ("dueAt" in patch) restore.dueAt = before.dueAt;
        apply(restore);
      }
      toast(patchErrorMessage(error), { tone: "error", duration: 6000 });
    }
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
  // The window holds every win newer than its oldest row; anything older
  // (and so every older pending prize) is read page by page from the server.
  const capped = redemptions.length >= OVERVIEW_REDEMPTION_WINDOW;
  const windowEnd = redemptions[redemptions.length - 1];
  const anchor = windowEnd ? `${windowEnd.at}|${windowEnd.id}` : "";
  const olderKey = `${filter}|${q}`;
  const olderRows =
    older && older.key === olderKey && older.anchor === anchor
      ? older.items.filter((r) => (filter === "all" || r.status === filter) && !redemptions.some((x) => x.id === r.id))
      : [];
  const olderLive = !!older && older.key === olderKey && older.anchor === anchor;
  const all = [...matched, ...olderRows];
  const shown = all.slice(0, page * PER_PAGE);
  const hasMore = all.length > shown.length;
  const canLoadOlder = capped && !hasMore && (!olderLive || older?.next !== null);

  async function loadOlder() {
    if (olderBusy || !windowEnd) return;
    setOlderBusy(true);
    setOlderError(false);
    try {
      const cursor = olderLive && older?.next ? older.next : anchor;
      const qs = new URLSearchParams({ before: cursor, ...(filter === "all" ? {} : { status: filter }), ...(q ? { q } : {}) });
      const res = await fetch(`/api/redemptions?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { items: RedemptionItem[]; next: string | null };
      setOlder((o) => {
        const prev = o && o.key === olderKey && o.anchor === anchor ? o.items : [];
        return { key: olderKey, anchor, items: [...prev, ...body.items.filter((r) => !prev.some((x) => x.id === r.id))], next: body.next };
      });
      setPage((p) => p + 1);
    } catch {
      setOlderError(true);
    } finally {
      setOlderBusy(false);
    }
  }
  // Server count (metrics.pending), not the list length: the list is capped.
  const pendingCount = data?.metrics.pending ?? 0;

  const emptyBody =
    q !== ""
      ? "No prizes match that search. Clear it to see the rest of the queue."
      : redemptions.length === 0
        ? "Wins show up here the moment a fan spins. Create a fan link and share it."
        : capped
          ? "None among your latest wins. Load older wins to keep looking."
          : "No prizes in this status. Switch filters to see the rest of the queue.";

  return (
    <div className="max-w-[780px]">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
          Prize queue
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* PR-07: the queue (current status filter) as a spreadsheet. */}
          <a href={`/api/redemptions/export${filter === "all" ? "" : `?status=${filter}`}`} download className={ghostBtn} data-testid="queue-export">
            Export CSV
          </a>
          <button type="button" onClick={refresh} className={ghostBtn}>
            <Glyph d={P.refresh} size={14} />
            Refresh
          </button>
        </div>
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

      {!loading && !data && error != null && (
        <LoadFailed error={error} what="the fulfilment queue" onRetry={refresh} testId="prizes-load-failed" />
      )}

      {!loading && (data || error == null) && shown.length === 0 && (
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
            <RedemptionRow key={r.id} r={r} onSet={setStatus} onPatch={patchRow} onOpenFan={onOpenFan} onMessageFan={onMessageFan} deliveryDays={deliveryDays} />
          ))}
        </ul>
      )}

      {!loading && (shown.length > 0 || canLoadOlder) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <span className="tnum">
            Showing {shown.length} of {all.length}
            {capped && " loaded"}
          </span>
          {olderError && (
            <span role="alert" className="text-[#fca5a5]">
              Couldn&rsquo;t load older wins.
            </span>
          )}
          {canLoadOlder && (
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={olderBusy}
              data-testid="prizes-load-older"
              className={`${ghostBtn} text-ink`}
            >
              {olderBusy ? "Loading…" : "Load older wins"}
            </button>
          )}
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
  onOpenFan,
  onMessageFan,
  deliveryDays = null,
}: {
  r: RedemptionItem;
  onSet: (id: string, status: RedemptionStatus) => void;
  onPatch: (id: string, patch: Patch) => void;
  onOpenFan?: (fanId: string) => void;
  onMessageFan?: (fanId: string) => void;
  /** PR-10: the creator's delivery promise in days, when one is set. */
  deliveryDays?: number | null;
}) {
  const fanId = r.fanId ?? null;
  const color = RARITY_COLORS[r.rarity];
  const toast = useToast();
  const [notes, setNotes] = useState(r.notes ?? "");
  // Keep the local draft in sync when the row is refreshed from the server.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to refreshed prop
    setNotes(r.notes ?? "");
  }, [r.notes]);

  // RD-06: the due date is a draft until it is a complete, sane day; it is
  // committed on blur / Enter / a picker choice, never per keystroke.
  const savedDue = dueDateValue(r.dueAt);
  const [dueDraft, setDueDraft] = useState(savedDue);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync draft to refreshed prop
    setDueDraft(savedDue);
  }, [savedDue]);
  const now = useNow(60_000);
  const overdue = now !== null && isOverdue(r.dueAt, r.status, now);
  // PR-10: a win with no due date inherits the creator's delivery promise as
  // its suggested expected-by day; one click makes it the due date.
  const suggestedDue =
    deliveryDays && !r.auto && !savedDue && (r.status === "pending" || r.status === "in_progress")
      ? localDayPlus(deliveryDays, new Date(r.at).getTime())
      : "";
  const subject = `${r.prizeLabel} for ${r.fanName}`;
  const canCancel = !r.auto && r.status !== "cancelled" && r.status !== "fulfilled";
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
  function commitDue(value: string, { onBlur = false } = {}) {
    if (value === savedDue) return;
    if (value === "") {
      // Clearing is only final once the field is left (typing passes through "").
      if (onBlur) onPatch(r.id, { dueAt: null });
      return;
    }
    if (!dueDateInRange(value)) {
      if (onBlur) {
        toast("Pick a date within the last year or the next ten years.", { tone: "error" });
        setDueDraft(savedDue);
      }
      return;
    }
    onPatch(r.id, { dueAt: value });
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
              ·{" "}
              {fanId && onOpenFan ? (
                <button
                  type="button"
                  data-testid="redemption-fan"
                  onClick={() => onOpenFan(fanId)}
                  aria-label={`Open ${r.fanName}'s fan details`}
                  className="font-semibold text-ink underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >
                  {r.fanName}
                </button>
              ) : (
                r.fanName
              )}{" "}
              ·{" "}
              <time dateTime={r.at} className="tnum">
                {formatWhen(r.at)}
              </time>
            </p>
            {r.auto && (
              <p data-testid="reward-view-count" className="mt-1 break-words text-xs text-muted">
                {r.auto.views > 0 ? `Viewed by fan · ${r.auto.views}×` : "Not viewed by fan yet"}
                {r.auto.lastViewedAt && Number.isFinite(Date.parse(r.auto.lastViewedAt)) && (
                  <> · last <time dateTime={r.auto.lastViewedAt}>{formatWhen(r.auto.lastViewedAt)}</time></>
                )}
              </p>
            )}
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
          {r.auto && <span data-testid="redemption-auto" title="Reward delivered instantly to the winning fan" className="rounded-full border border-[#22c55e]/30 bg-[#22c55e]/10 px-[11px] py-1 text-xs font-bold text-[#86efac]">Auto · {r.auto.kind === "link" ? "Link" : r.auto.kind === "code" ? "Code" : "Text"}</span>}
          {r.focusKind && <span data-testid="redemption-focus" title={r.chaseAwarded ? "This win completed the Chase guarantee" : "Won while a Focus or Chase pack was active"} className="rounded-full border border-[var(--brand)]/30 px-[11px] py-1 text-xs font-bold text-ink">Focus{r.focusKind === "chase" ? r.chaseAwarded ? " · Chase guaranteed" : " · Chase" : ""}</span>}
          {!r.auto && (
          <button
            type="button"
            onClick={() => onSet(r.id, STATUS_NEXT[r.status])}
            aria-label={`${STATUS_CTA[r.status]}: ${subject}`}
            className="btn-brand min-h-9 rounded-[9px] px-3.5 text-[12.5px] font-bold"
          >
            {STATUS_CTA[r.status]}
          </button>
          )}
          {fanId && onMessageFan && (
            <button
              type="button"
              data-testid="redemption-message"
              onClick={() => onMessageFan(fanId)}
              aria-label={`Message ${r.fanName}`}
              className={ghostBtn}
            >
              Message
            </button>
          )}
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
            value={dueDraft}
            disabled={!!r.auto}
            title={r.auto ? "Already delivered instantly" : undefined}
            onChange={(e) => {
              setDueDraft(e.target.value);
              commitDue(e.target.value);
            }}
            onBlur={(e) => commitDue(e.target.value, { onBlur: true })}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          {suggestedDue && (
            <span className="text-[11.5px] text-muted" data-testid="expected-by">
              Expected by {dueDayLabel(suggestedDue)} ({deliveryDays}-day promise).{" "}
              <button
                type="button"
                className="font-semibold text-brand underline-offset-2 hover:underline"
                onClick={() => {
                  setDueDraft(suggestedDue);
                  commitDue(suggestedDue);
                }}
              >
                Use it
              </button>
            </span>
          )}
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
        Cancel {subject}? It leaves the queue and a limited prize&apos;s unit goes back to stock; you can reopen it from the Cancelled filter.
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
