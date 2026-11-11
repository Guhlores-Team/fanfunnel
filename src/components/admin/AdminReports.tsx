"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { PHOTO_REPORT_REASON } from "@/lib/creatorTheme/config";
import { REPORT_NOTE_MAX, REPORT_REASONS, REPORTS_CHANGED_EVENT, type ReportStatus } from "@/lib/reports/config";
import type { AdminReport, ReportPage } from "@/lib/reports/types";
import { P, Glyph, SectionTitle, raised, recessed, btnGhost, pill } from "./adminUi";
import RemoveCreatorPhotosButton from "./RemoveCreatorPhotosButton";

// Admin › Reports: the fan safety queue (creator_reports). Rendered inside the
// Admin section, which only exists behind the server-side is_admin() gate;
// /api/admin/reports re-checks is_admin() and RLS checks again.

type Filter = ReportStatus | "all";

const STATUS_LABEL: Record<Filter, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
  all: "All",
};

function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function AdminReports() {
  const [status, setStatus] = useState<Filter>("open");
  const [reason, setReason] = useState("");
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ open: number; urgent: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const sectionRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const scrolled = useRef(false);
  const reasonId = useId();
  const toast = useToast();

  const fetchPage = useCallback(
    async (before: string | null): Promise<ReportPage | null> => {
      const qs = new URLSearchParams({ status, ...(reason ? { reason } : {}), ...(before ? { before } : {}) });
      const res = await fetch(`/api/admin/reports?${qs}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return null;
      return (await res.json().catch(() => null)) as ReportPage | null;
    },
    [status, reason],
  );

  const load = useCallback(async () => {
    const page = await fetchPage(null);
    setFailed(page === null);
    setReports(page?.reports ?? []);
    setNext(page?.next ?? null);
    if (page) setCounts({ open: page.openCount, urgent: page.urgentOpenCount });
  }, [fetchPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state is only set once the response arrives
    void load();
  }, [load]);

  // The urgent-report e-mail links to /dashboard?section=admin#reports.
  useEffect(() => {
    if (reports === null || scrolled.current) return;
    scrolled.current = true;
    if (window.location.hash === "#reports") sectionRef.current?.scrollIntoView({ block: "start" });
  }, [reports]);

  async function loadMore() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(next);
      if (!page) {
        toast("Couldn't load more reports — try again.", { tone: "error" });
        return;
      }
      setReports((list) => [...(list ?? []), ...page.reports.filter((r) => !(list ?? []).some((x) => x.id === r.id))]);
      setNext(page.next);
    } finally {
      setLoadingMore(false);
    }
  }

  async function review(item: AdminReport, to: ReportStatus, note: string): Promise<boolean> {
    if (busy.has(item.id)) return false;
    setBusy((s) => new Set(s).add(item.id));
    try {
      const res = await fetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: to, note: note.trim() || null }),
      });
      if (!res.ok) throw new Error();
      const { report } = (await res.json()) as { report: AdminReport };
      // It leaves a filtered list once its status no longer matches.
      setReports((list) =>
        (list ?? []).flatMap((r) => (r.id !== item.id ? [r] : status === "all" || status === report.status ? [report] : [])),
      );
      setCounts((c) => {
        if (!c) return c;
        const delta = (to === "open" ? 1 : 0) - (item.status === "open" ? 1 : 0);
        return { open: Math.max(0, c.open + delta), urgent: Math.max(0, c.urgent + (item.urgent ? delta : 0)) };
      });
      window.dispatchEvent(new Event(REPORTS_CHANGED_EVENT));
      toast(to === "resolved" ? "Report resolved" : to === "dismissed" ? "Report dismissed" : "Report reopened", { tone: "success" });
      statusRef.current?.focus();
      return true;
    } catch {
      toast("Couldn't update the report — try again.", { tone: "error" });
      return false;
    } finally {
      setBusy((s) => {
        const nextBusy = new Set(s);
        nextBusy.delete(item.id);
        return nextBusy;
      });
    }
  }

  const list = reports ?? [];
  return (
    <section
      ref={sectionRef}
      id="reports"
      aria-labelledby="admin-reports"
      className={`lift-in scroll-mt-20 overflow-hidden rounded-2xl ${raised}`}
    >
      <SectionTitle
        id="admin-reports"
        extra={
          <span className="flex items-center gap-3">
            {counts && (
              <span className="tnum text-xs text-muted" data-testid="admin-reports-open-count">
                {counts.open} open{counts.urgent > 0 ? ` · ${counts.urgent} urgent` : ""}
              </span>
            )}
            <button type="button" onClick={() => void load()} className={btnGhost}>
              <Glyph d={P.refresh} size={14} />
              Refresh
            </button>
          </span>
        }
      >
        Reports
      </SectionTitle>

      <div className="flex flex-wrap items-end gap-3 border-b border-[#1f1b27] px-4 py-3 sm:px-[18px]">
        <div role="group" aria-label="Show reports" className={`inline-flex flex-wrap rounded-[10px] p-[3px] ${recessed}`}>
          {(["open", "resolved", "dismissed", "all"] as const).map((s) => (
            <button
              key={s}
              ref={s === "open" ? statusRef : undefined}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`min-h-8 rounded-[8px] px-3 text-xs font-semibold transition-colors ${
                status === s
                  ? "bg-[color-mix(in_oklab,var(--brand-ui)_18%,transparent)] text-ink ring-1 ring-[color-mix(in_oklab,var(--brand-ui)_40%,transparent)]"
                  : "text-muted hover:text-ink"
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <label htmlFor={reasonId} className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Reason</span>
          <select
            id={reasonId}
            className="ff-input min-w-0 max-w-full text-xs sm:min-w-52"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">All reasons</option>
            {REPORT_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {reports === null ? (
        <div className="flex flex-col gap-px" aria-busy="true" aria-label="Loading reports">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-[88px] border-b border-[#1f1b27] last:border-b-0" />
          ))}
        </div>
      ) : failed ? (
        <p role="alert" className="px-[18px] py-8 text-center text-[13.5px] text-muted">
          Couldn&rsquo;t load reports.{" "}
          <button type="button" onClick={() => void load()} className="font-semibold text-ink underline">
            Try again
          </button>
        </p>
      ) : list.length === 0 ? (
        <p className="px-[18px] py-8 text-center text-[13.5px] text-muted" data-testid="admin-reports-empty">
          {status === "open" ? "No open reports." : `No ${status === "all" ? "" : STATUS_LABEL[status].toLowerCase() + " "}reports.`}
        </p>
      ) : (
        <>
          <ul aria-label={`${STATUS_LABEL[status]} reports`}>
            {list.map((r) => (
              <ReportRow key={r.id} item={r} busy={busy.has(r.id)} onReview={review} />
            ))}
          </ul>
          {next && (
            <div className="flex justify-center border-t border-[#1f1b27] px-4 py-3">
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className={btnGhost}>
                {loadingMore ? "Loading…" : "Load more reports"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const STATUS_PILL: Record<ReportStatus, string> = {
  open: "bg-[#f59e0b]/15 text-[#fcd34d]",
  resolved: "bg-[#10b981]/15 text-[#6ee7b7]",
  dismissed: "bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted",
};

function ReportRow({
  item,
  busy,
  onReview,
}: {
  item: AdminReport;
  busy: boolean;
  onReview: (item: AdminReport, to: ReportStatus, note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const detailId = useId();
  const [showDetail, setShowDetail] = useState(false);
  const label = `${item.reason} report about ${item.creator.name}`;
  return (
    <li className="border-b border-[#1f1b27] last:border-b-0" data-testid="admin-report">
      <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:px-[18px]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {item.urgent && <span className={`${pill} bg-[#ef4444]/15 text-[#fca5a5]`}>Urgent</span>}
          <span className={`${pill} ${STATUS_PILL[item.status]}`}>{STATUS_LABEL[item.status]}</span>
          <span className="tnum text-xs text-muted">
            <time dateTime={item.createdAt}>{fullTime(item.createdAt)}</time>
          </span>
        </p>
        <p className="break-words text-[14px] font-semibold leading-snug text-ink">{item.reason}</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Reported creator</dt>
            <dd className="mt-0.5 break-words text-ink">
              {item.creator.name}
              {item.creator.email && item.creator.email !== item.creator.name && (
                <span className="text-muted"> · {item.creator.email}</span>
              )}
              {item.creator.publicSlug && (
                <>
                  {" · "}
                  <a
                    href={`/c/${encodeURIComponent(item.creator.publicSlug)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-ink underline"
                  >
                    Public page
                  </a>
                </>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Sent by</dt>
            <dd className="mt-0.5 break-words text-ink">
              {item.fan ? item.fan.name : <span className="text-muted">A fan who has since deleted their data</span>}
              {item.linkHint && <span className="font-mono text-muted"> · link {item.linkHint}</span>}
            </dd>
          </div>
        </dl>
        {item.detail && (
          <div>
            <button
              type="button"
              onClick={() => setShowDetail((o) => !o)}
              aria-expanded={showDetail}
              aria-controls={detailId}
              className={btnGhost}
            >
              <Glyph d={P.chevron} size={14} className={`transition-transform ${showDetail ? "rotate-180" : ""}`} />
              What the fan wrote
            </button>
            <p
              id={detailId}
              hidden={!showDetail}
              className={`mt-2 whitespace-pre-wrap break-words rounded-[11px] p-3 text-[13px] text-ink ${recessed}`}
            >
              {item.detail}
            </p>
          </div>
        )}
        {item.status !== "open" && (
          <p className="text-xs text-muted">
            {STATUS_LABEL[item.status]}
            {item.resolvedAt && (
              <>
                {" "}
                <time dateTime={item.resolvedAt}>{fullTime(item.resolvedAt)}</time>
              </>
            )}
            {item.resolutionNote && <span className="text-ink"> — {item.resolutionNote}</span>}
          </p>
        )}
        {item.reason === PHOTO_REPORT_REASON && item.status === "open" && (
          <RemoveCreatorPhotosButton accountId={item.creator.id} displayName={item.creator.name} />
        )}
        {item.status === "open" ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={noteId} className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">
              Note (optional, admins only)
            </label>
            <textarea
              id={noteId}
              rows={2}
              maxLength={REPORT_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What you checked or did"
              className="ff-input w-full text-[13px]"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void onReview(item, "resolved", note)}
                aria-label={`Resolve: ${label}`}
                className={`${btnGhost} border-[#10b981]/40 text-[#6ee7b7] hover:text-[#a7f3d0]`}
              >
                <Glyph d={P.check} size={14} />
                Resolve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onReview(item, "dismissed", note)}
                aria-label={`Dismiss: ${label}`}
                className={btnGhost}
              >
                <Glyph d={P.x} size={14} />
                Dismiss
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onReview(item, "open", "")}
              aria-label={`Reopen: ${label}`}
              className={btnGhost}
            >
              <Glyph d={P.undo} size={14} />
              Reopen
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
