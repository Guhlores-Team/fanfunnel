"use client";

import { formatCents } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { useFetch } from "@/lib/hooks/useFetch";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";

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
 */
export default function CrmPanel() {
  const toast = useToast();
  const origin = useOrigin();
  // A failed read leaves `crm` null and the panel renders its empty sections —
  // same as before, but the error is owned by the hook, not silently swallowed.
  const { data: crm } = useFetch<CreatorCrm>("/api/crm", { refreshOnVisible: false });

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
    <div className="space-y-8">
      <section>
        <h3 className="text-sm font-bold text-ink">Lifetime value</h3>
        <p className="mt-0.5 text-xs text-muted">
          Total and average spend across fans who&rsquo;ve paid.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Stat label="Total LTV" value={formatCents(crm?.totalLtv ?? 0)} />
          <Stat label="Avg LTV / fan" value={formatCents(crm?.avgLtv ?? 0)} />
        </div>
      </section>

      <FanList
        title="🐳 Whales — your top spenders"
        hint="Nurture these relationships: VIP perks, personal attention, first dibs on rare drops."
        fans={crm?.whales ?? []}
        empty="No paid fans yet."
        onCopy={copyLink}
      />

      <FanList
        title="💤 Win-back — spent before, quiet 14+ days"
        hint="The cheapest revenue is a fan you already converted. Send them a fresh link."
        fans={crm?.dormant ?? []}
        empty="No dormant spenders — nice."
        onCopy={copyLink}
        showDays
      />
    </div>
  );
}

function FanList({
  title,
  hint,
  fans,
  empty,
  onCopy,
  showDays,
}: {
  title: string;
  hint: string;
  fans: CrmFan[];
  empty: string;
  onCopy: (token: string | null) => void;
  showDays?: boolean;
}) {
  return (
    <section>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
      {fans.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {fans.map((f) => (
            <li
              key={f.fanId}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
              {showDays && f.daysSince !== null && (
                <span className="shrink-0 text-xs text-muted">{f.daysSince}d quiet</span>
              )}
              <span className="tnum shrink-0 font-bold text-ink">
                {formatCents(f.totalSpent)}
              </span>
              <button
                onClick={() => onCopy(f.primaryToken)}
                className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition hover:border-[var(--brand)]"
              >
                Copy link
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5 text-center">
      <p className="tnum text-xl font-extrabold text-ink">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  );
}
