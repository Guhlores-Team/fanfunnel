"use client";

import { useEffect, useState } from "react";
import type { ReferralOverview } from "@/lib/data/types";

/**
 * A fan's referral panel: share a code, watch credited referrals roll in. Both
 * the fan and a referred new fan get bonus spins on the referred fan's first
 * paid top-up (capped). The code is shared as text — the creator applies it when
 * minting the new fan's link.
 */
export default function ReferralWidget({
  token,
  code,
  bonusPerReferral,
}: {
  token: string;
  code: string;
  bonusPerReferral: number;
}) {
  const [overview, setOverview] = useState<ReferralOverview | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/referrals/overview?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setOverview(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token]);

  if (!code) return null;
  const credited = overview?.creditedCount ?? 0;
  const cap = overview?.cap ?? 3;
  const bonus = overview?.bonusPerReferral ?? bonusPerReferral;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is visible to copy by hand */
    }
  };

  return (
    <div className="card w-full rounded-2xl p-5">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        Refer a friend
      </p>
      <p className="mt-1 text-sm text-ink text-pretty">
        Share your code. When a friend you bring in makes their first top-up, you
        <span className="font-bold text-[var(--brand)]"> both get +{bonus} spins</span>.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="tnum flex-1 rounded-xl border border-line bg-surface/70 px-3 py-2 text-center text-base font-bold tracking-widest text-ink">
          {code}
        </code>
        <button
          onClick={copy}
          className="rounded-xl border border-line bg-surface/70 px-4 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {credited} of {cap} referrals credited
      </p>
    </div>
  );
}
