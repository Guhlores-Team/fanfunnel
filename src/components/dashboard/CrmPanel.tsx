"use client";

import type { ReactNode } from "react";
import { formatCents } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { useFetch } from "@/lib/hooks/useFetch";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { CardHeader, Glyph, ICON, LoadError, StatCell, hairGrid, raised } from "./analyticsUi";

interface CrmFan {
  fanId: string;
  name: string;
  totalSpent: number;
  spinsRemaining: number;
  lastActiveAt: string | null;
  daysSince: number | null;
  primaryToken: string | null;
}
interface CreatorCrm {
  totalLtv: number;
  avgLtv: number;
  whales: CrmFan[];
  dormant: CrmFan[];
}

/**
 * Fan intelligence: lifetime value, your top spenders (whales) to nurture, and
 * fans who spent before but went quiet (win-back worklist). One tap copies that
 * fan's spin link so you can drop it in a DM.
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

      <FanList
        icon={ICON.moon}
        title="Win-back — spent before, quiet 14+ days"
        hint="The cheapest revenue is a fan you already converted. Send them a fresh link."
        fans={crm?.dormant ?? []}
        empty="No dormant spenders — nice."
        onCopy={copyLink}
        failed={failed}
        onRetry={retry}
        showDays
      />
    </div>
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
  showDays,
}: {
  icon: string;
  title: string;
  hint: string;
  fans: CrmFan[];
  empty: string;
  onCopy: (token: string | null) => void;
  failed: boolean;
  onRetry: () => void;
  showDays?: boolean;
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
              {showDays && f.daysSince !== null && (
                <span className="tnum shrink-0 text-xs text-muted">{f.daysSince}d quiet</span>
              )}
              <span className="tnum shrink-0 font-bold text-ink">{formatCents(f.totalSpent)}</span>
              <button
                type="button"
                onClick={() => onCopy(f.primaryToken)}
                aria-label={`Copy link for ${f.name}`}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:border-[var(--brand)]"
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
