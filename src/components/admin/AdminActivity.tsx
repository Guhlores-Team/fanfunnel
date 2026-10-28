"use client";

import { useEffect, useState } from "react";
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
const PAGE = 25;

/**
 * Admin › Activity: the admin activity log, newest first. Read through
 * GET /api/admin/audit (active admin on a two-factor session only). Entries
 * store ids; the server labels them with the account's current email, which
 * admins already see in the account list.
 */
export default function AdminActivity() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/audit", { cache: "no-store" })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) {
          setFailed(true);
          return;
        }
        setEntries(((await r.json()) as { entries?: Entry[] }).entries ?? []);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section aria-labelledby="admin-activity" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f1b27] px-4 py-3.5 sm:px-[18px] sm:py-4">
        <h2 id="admin-activity" className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
          Activity
        </h2>
        <span className="text-xs text-muted">Who did what in the admin area. Kept 1 year.</span>
      </div>
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
        <p className="px-[18px] py-6 text-center text-[13.5px] text-muted">No admin activity yet.</p>
      ) : (
        <>
          <ol className="divide-y divide-[#1f1b27]">
            {entries.slice(0, shown).map((e) => {
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
          {entries.length > shown && (
            <div className="border-t border-[#1f1b27] px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="text-xs font-semibold text-ink underline underline-offset-4"
              >
                Show older
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
