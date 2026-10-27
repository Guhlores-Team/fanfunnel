"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatCents } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { useFetch } from "@/lib/hooks/useFetch";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { DEFAULT_WINBACK_TEMPLATE, WINBACK_MODE, WINBACK_QUIET_DAYS, WINBACK_RESULTS_WINDOW_DAYS } from "@/lib/winback/config";
import { contactedLabel } from "@/lib/winback/list";
import type { DmTemplate } from "@/lib/data/types";
import { CardHeader, Glyph, ICON, LoadError, StatCell, hairGrid, raised } from "./analyticsUi";
import WinbackQueue from "./WinbackQueue";
import { postOutreach, winbackMessage, type WinbackFan, type WinbackTemplate } from "./winbackActions";
import { takeWinbackQueueRequest } from "./winbackIntent";

interface CrmFan extends WinbackFan {
  spinsRemaining: number;
  lastActiveAt: string | null;
}
interface CreatorCrm {
  totalLtv: number;
  avgLtv: number;
  whales: CrmFan[];
  dormant: CrmFan[];
  winback?: {
    contacted: number;
    cameBack: number;
    recent: { fanId: string; name: string; contactedAt: string; daysAgo: number; cameBack: boolean }[];
  };
}

const smallBtn =
  "flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:border-[var(--brand)] disabled:opacity-50";

/**
 * Fan intelligence: lifetime value, your top spenders (whales) to nurture, and
 * fans who spent before but went quiet (the win-back list, RM-5). Whales copy a
 * spin link; win-back rows copy a filled DM (and log the contact) or the link,
 * and "Start win-back" works through them one at a time (WinbackQueue).
 *
 * Renders as a 2-column card grid (single column on phones); `leading` takes
 * the first slot so the Audience group reads Conversion | LTV, Whales | Win-back.
 */
export default function CrmPanel({ leading }: { leading?: ReactNode }) {
  const toast = useToast();
  const origin = useOrigin();
  // A failed read leaves `crm` null; the hook owns the error and the cards
  // show fixed retry copy instead of a misleading "no fans" empty state.
  const { data: crm, error, reload } = useFetch<CreatorCrm>("/api/crm", { refreshOnVisible: false });
  const failed = !!error && !crm;
  const retry = () => void reload();

  const copyLink = async (token: string | null) => {
    if (!token) {
      toast("No link for this fan yet.", { tone: "error" });
      return;
    }
    if (await copyToClipboard(`${origin}/spin/${token}`)) {
      toast("Spin link copied — paste it in a DM.", { tone: "success" });
    } else {
      toast("Couldn't copy.", { tone: "error" });
    }
  };

  return (
    <div className="grid gap-[18px] lg:grid-cols-2">
      {leading}

      <section className={`rounded-2xl p-5 ${raised}`}>
        <CardHeader
          icon={ICON.dollar}
          title="Lifetime value"
          hint={<>Total and average spend across fans who&rsquo;ve paid.</>}
        />
        <div className="mt-4">
          {failed ? (
            <LoadError what="lifetime value" onRetry={retry} />
          ) : (
            <dl className={`${hairGrid} grid-cols-2`}>
              <StatCell label="Total LTV" value={formatCents(crm?.totalLtv ?? 0)} />
              <StatCell label="Avg LTV / fan" value={formatCents(crm?.avgLtv ?? 0)} />
            </dl>
          )}
        </div>
      </section>

      <FanList
        icon={ICON.crown}
        title="Whales — your top spenders"
        hint="Nurture these relationships: VIP perks, personal attention, first dibs on rare drops."
        fans={crm?.whales ?? []}
        empty="No paid fans yet."
        onCopy={copyLink}
        failed={failed}
        onRetry={retry}
      />

      <WinbackCard crm={crm} failed={failed} onRetry={retry} onChanged={retry} onCopyLink={copyLink} origin={origin} />
    </div>
  );
}

function WinbackCard({
  crm,
  failed,
  onRetry,
  onChanged,
  onCopyLink,
  origin,
}: {
  crm: CreatorCrm | null;
  failed: boolean;
  onRetry: () => void;
  onChanged: () => void;
  onCopyLink: (token: string | null) => void;
  origin: string;
}) {
  const toast = useToast();
  const selectId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const { data: saved } = useFetch<{ templates: DmTemplate[] }>("/api/dm-templates", { refreshOnVisible: false });
  const { data: account } = useFetch<{ displayName: string | null }>("/api/account", { refreshOnVisible: false });
  const templates: WinbackTemplate[] = [DEFAULT_WINBACK_TEMPLATE, ...(saved?.templates ?? [])];
  const [templateId, setTemplateId] = useState<string>(DEFAULT_WINBACK_TEMPLATE.id);
  const template = templates.find((t) => t.id === templateId) ?? templates[0];
  const creator = account?.displayName?.trim() || null;
  const [queue, setQueue] = useState<CrmFan[] | null>(null);
  const [busyFan, setBusyFan] = useState<string | null>(null);
  // Today's "Start win-back" card asked for the queue before this mounted.
  const [wantQueue, setWantQueue] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of a cross-panel request on mount
    if (takeWinbackQueueRequest()) setWantQueue(true);
  }, []);
  useEffect(() => {
    if (!wantQueue || !crm) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the request resolves once the list has loaded
    setWantQueue(false);
    cardRef.current?.scrollIntoView({ block: "start" });
    if (crm.dormant.length > 0) setQueue(crm.dormant);
    else toast("Nobody to win back right now.", { tone: "info" });
  }, [wantQueue, crm, toast]);

  const dormant = crm?.dormant ?? [];
  const stats = crm?.winback;
  const queueMode = WINBACK_MODE === "queue";

  async function copyDm(f: CrmFan) {
    if (!f.primaryToken || busyFan) return;
    setBusyFan(f.fanId);
    try {
      if (!(await copyToClipboard(winbackMessage(f, template, origin, creator)))) {
        toast("Couldn't copy.", { tone: "error" });
        return;
      }
      const logged = await postOutreach(f.fanId, "contacted", template.id === DEFAULT_WINBACK_TEMPLATE.id ? null : template.id);
      toast(logged ? `DM copied for ${f.name} — marked as contacted.` : "DM copied, but couldn't mark the fan as contacted.", {
        tone: logged ? "success" : "error",
      });
      if (logged) onChanged();
    } finally {
      setBusyFan(null);
    }
  }

  return (
    <section ref={cardRef} className={`scroll-mt-24 rounded-2xl p-5 ${raised}`} data-testid="winback-card">
      <CardHeader
        icon={ICON.moon}
        title={`Win-back — spent before, quiet ${WINBACK_QUIET_DAYS}+ days`}
        hint="The cheapest revenue is a fan you already converted. Copy a filled message and paste it in your DMs."
        right={
          queueMode && !failed && dormant.length > 0 ? (
            <button
              type="button"
              onClick={() => setQueue(dormant)}
              className="btn-brand min-h-9 shrink-0 rounded-[10px] px-3.5 text-[13px] font-bold"
            >
              Start win-back
            </button>
          ) : undefined
        }
      />

      {failed ? (
        <div className="mt-4">
          <LoadError what="this list" onRetry={onRetry} />
        </div>
      ) : (
        <>
          {stats && stats.contacted > 0 && (
            <p className="tnum mt-3 text-xs text-muted" data-testid="winback-stats">
              Last {WINBACK_RESULTS_WINDOW_DAYS} days: {stats.contacted} contacted · {stats.cameBack} came back
            </p>
          )}
          {dormant.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No dormant spenders — nice.</p>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <label htmlFor={selectId} className="text-xs font-semibold text-muted">
                  Message
                </label>
                <select
                  id={selectId}
                  className="ff-input min-h-9 min-w-0 flex-1 py-1 text-[13px]"
                  value={template.id}
                  onChange={(e) => setTemplateId(e.target.value)}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </div>
              <ul className="mt-3 divide-y divide-[var(--hair)] overflow-hidden rounded-xl border border-[var(--hair)] [background:var(--s2)]">
                {dormant.map((f) => (
                  <li key={f.fanId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm" data-testid="winback-row">
                    <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
                    {f.daysSince !== null && <span className="tnum shrink-0 text-xs text-muted">{f.daysSince}d quiet</span>}
                    <span className="tnum shrink-0 font-bold text-ink">{formatCents(f.totalSpent)}</span>
                    <span className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => copyDm(f)}
                        disabled={busyFan !== null}
                        aria-label={`Copy DM for ${f.name}`}
                        className={smallBtn}
                      >
                        <Glyph d={ICON.fans} size={13} className="text-muted" />
                        Copy DM
                      </button>
                      <button
                        type="button"
                        onClick={() => onCopyLink(f.primaryToken)}
                        aria-label={`Copy link for ${f.name}`}
                        className={smallBtn}
                      >
                        <Glyph d={ICON.link} size={13} className="text-muted" />
                        Copy link
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {stats && stats.recent.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-muted">Recently contacted</h4>
              <ul className="mt-2 flex flex-col gap-1.5" data-testid="winback-recent">
                {stats.recent.map((r) => (
                  <li key={r.fanId} className="flex items-center gap-3 text-[13px]">
                    <span className="min-w-0 flex-1 truncate text-ink">{r.name}</span>
                    {r.cameBack ? (
                      <span className="shrink-0 rounded-full bg-[#22c55e]/15 px-2 py-0.5 text-[11px] font-bold text-[#86efac]">
                        Came back ✓
                      </span>
                    ) : (
                      <span className="tnum shrink-0 text-xs text-muted">{contactedLabel(r.daysAgo)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {queue && (
        <WinbackQueue
          fans={queue}
          templates={templates}
          templateId={template.id}
          onTemplate={setTemplateId}
          origin={origin}
          creator={creator}
          onClose={(changed) => {
            setQueue(null);
            if (changed) onChanged();
          }}
        />
      )}
    </section>
  );
}

function FanList({
  icon,
  title,
  hint,
  fans,
  empty,
  onCopy,
  failed,
  onRetry,
}: {
  icon: string;
  title: string;
  hint: string;
  fans: CrmFan[];
  empty: string;
  onCopy: (token: string | null) => void;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <section className={`rounded-2xl p-5 ${raised}`}>
      <CardHeader icon={icon} title={title} hint={hint} />
      {failed ? (
        <div className="mt-4">
          <LoadError what="this list" onRetry={onRetry} />
        </div>
      ) : fans.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--hair)] overflow-hidden rounded-xl border border-[var(--hair)] [background:var(--s2)]">
          {fans.map((f) => (
            <li key={f.fanId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
              <span className="tnum shrink-0 font-bold text-ink">{formatCents(f.totalSpent)}</span>
              <button
                type="button"
                onClick={() => onCopy(f.primaryToken)}
                aria-label={`Copy link for ${f.name}`}
                className={smallBtn}
              >
                <Glyph d={ICON.link} size={13} className="text-muted" />
                Copy link
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
