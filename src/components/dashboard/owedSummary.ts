import type { CreatorOverview, FanAccountSummary } from "@/lib/data/types";

/**
 * C4: what fans are still owed, from data the dashboard already reads (the
 * overview and the fan list), shown before "Clear all data" wipes it.
 *  - prizes: every won prize not yet delivered or cancelled (the server's
 *    pending count, across all rows).
 *  - fans: distinct fans among the open prizes in the overview's newest-200
 *    window; when the window does not hold them all, it is a floor ("at least").
 *  - paidSpins: unplayed spins held by fans who have paid anything. The fan
 *    list does not split paid from free spins on one fan, so this counts a
 *    paying fan's whole balance (an exact split is a server-side follow-up).
 */
export interface OwedSummary {
  fans: number;
  fansAtLeast: boolean;
  prizes: number;
  paidSpins: number;
  payingFans: number;
}

export function owedSummary(overview: Pick<CreatorOverview, "metrics" | "redemptions">, fans: readonly Pick<FanAccountSummary, "fanId" | "spinsRemaining" | "totalSpent">[]): OwedSummary {
  const open = overview.redemptions.filter((r) => r.status === "pending" || r.status === "in_progress");
  const prizes = Math.max(overview.metrics.pending ?? 0, open.length);
  const owedFans = new Set(open.map((r) => r.fanId ?? `name:${r.fanName}`));
  const paying = fans.filter((f) => f.totalSpent > 0 && f.spinsRemaining > 0);
  return {
    fans: owedFans.size,
    fansAtLeast: prizes > open.length,
    prizes,
    paidSpins: paying.reduce((n, f) => n + f.spinsRemaining, 0),
    payingFans: paying.length,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One plain sentence; "" when nothing is owed. */
export function owedSentence(s: OwedSummary): string {
  const parts: string[] = [];
  if (s.prizes > 0) {
    const who = `${s.fansAtLeast ? "At least " : ""}${plural(s.fans, "fan is", "fans are")}`;
    parts.push(`${who} owed ${plural(s.prizes, "prize", "prizes")}`);
  }
  if (s.paidSpins > 0) {
    const holders = plural(s.payingFans, "fan with recorded tips holds", "fans with recorded tips hold");
    parts.push(`${parts.length ? "and " : ""}${parts.length ? holders.charAt(0).toLowerCase() + holders.slice(1) : holders} ${plural(s.paidSpins, "unplayed spin", "unplayed spins")}`);
  }
  return parts.length ? parts.join(", ").replace(", and", " and") + "." : "";
}
