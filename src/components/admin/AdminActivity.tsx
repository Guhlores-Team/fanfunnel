"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { auditActionLabel, auditDetailsSummary, shortId } from "./auditLabels";

interface Entry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  actorLabel: string | null;
  targetLabel: string | null;
}

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";

/**
 * Admin › Activity: the admin activity log, newest first. Read through
 * GET /api/admin/audit (active admin on a two-factor session only). Entries
 * store ids; the server labels them with the account's current email, which
 * admins already see in the account list. OPS-04: filter by action (code or
 * wording) and load older pages from the server, beyond the first page.
 */
export default function AdminActivity() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");

  const fetchPage = useCallback(async (action: string, before?: string) => {
    const q = new URLSearchParams();
    if (action) q.set("action", action);
    if (before) q.set("before", before);
    const r = await fetch(`/api/admin/audit${q.size ? `?${q}` : ""}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as { entries?: Entry[]; more?: boolean };
  }, []);

  useEffect(() => {
    let live = true;
    fetchPage(filter)
      .then((page) => {
        if (!live) return;
        setFailed(false);
        setEntries(page.entries ?? []);
        setMore(page.more === true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [fetchPage, filter]);

  async function loadOlder() {
    if (!entries?.length || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(filter, entries[entries.length - 1].createdAt);
      setEntries((prev) => [...(prev ?? []), ...(page.entries ?? [])]);
      setMore(page.more === true);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (next === filter) return;
    setEntries(null);
    setFilter(next);
  }

  return (
    <section aria-labelledby="admin-activity" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f1b27] px-4 py-3.5 sm:px-[18px] sm:py-4">
        <h2 id="admin-activity" className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
          Activity
        </h2>
        <span className="text-xs text-muted">Who did what in the admin area. Kept 1 year.</span>
      </div>
      <form role="search" aria-label="Filter activity" onSubmit={applyFilter} className="flex flex-wrap items-end gap-2 border-b border-[#1f1b27] px-4 py-3 sm:px-[18px]">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted">
          Filter by action
          <input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={40}
            pattern="[A-Za-z0-9 ._\-]*"
            placeholder="e.g. suspend, two-factor, lookup"
            className="rounded-lg border border-[var(--hair)] bg-transparent px-3 py-2 text-[13px] text-ink"
          />
        </label>
        <button type="submit" className="rounded-lg border border-[var(--hair)] px-3 py-2 text-xs font-semibold text-ink">Filter</button>
        {filter && (
          <button type="button" onClick={() => { setDraft(""); setEntries(null); setFilter(""); }} className="px-1 py-2 text-xs font-semibold text-ink underline underline-offset-4">
            Clear
          </button>
        )}
      </form>
      {failed ? (
        <p role="alert" className="px-[18px] py-6 text-center text-[13.5px] text-muted">
          Couldn&rsquo;t load the activity log.
        </p>
      ) : entries === null ? (
        <div className="flex flex-col gap-px" aria-busy="true" aria-label="Loading activity">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-[52px] border-b border-[#1f1b27] last:border-b-0" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="px-[18px] py-6 text-center text-[13.5px] text-muted">{filter ? "No activity matches this filter." : "No admin activity yet."}</p>
      ) : (
        <>
          <ol className="divide-y divide-[#1f1b27]">
            {entries.map((e) => {
              const actor = e.actorLabel ?? (e.actorId ? shortId(e.actorId) : "System");
              const target =
                e.targetType === "profile" && e.targetId && e.targetId !== e.actorId
                  ? e.targetLabel ?? `account ${shortId(e.targetId)}`
                  : null;
              const extra = auditDetailsSummary(e.details);
              return (
                <li key={e.id} className="px-4 py-3 sm:px-[18px]">
                  <p className="break-words text-[13px] text-ink">
                    <span className="font-semibold">{actor}</span> {auditActionLabel(e.action)}
                    {target && (
                      <>
                        {" "}
                        <span className="text-muted">for</span> <span className="font-semibold">{target}</span>
                      </>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
                    {extra && <span className="break-words"> · {extra}</span>}
                  </p>
                </li>
              );
            })}
          </ol>
          {more && (
            <div className="border-t border-[#1f1b27] px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingMore}
                className="text-xs font-semibold text-ink underline underline-offset-4"
              >
                {loadingMore ? "Loading…" : "Load older"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
