import type { CreatorOverview, FanAccountSummary } from "./types";

/**
 * What the creator still owes fans (C4): shown before "Clear all data" and
 * "Close my account". With 0073 it is one SQL call (creator_obligations);
 * before that it is computed from the overview and the complete fan list.
 */
export interface CreatorObligations {
  /** Won prizes not yet delivered or cancelled. */
  prizes: number;
  /** Distinct fans among those prizes (a floor when `fansAtLeast`). */
  fans: number;
  fansAtLeast: boolean;
  /** Unplayed spins held by fans with recorded tips. */
  paidSpins: number;
  payingFans: number;
  /** Every unplayed spin, tipped or not (null when the reader cannot tell). */
  unplayedSpins: number | null;
  activeLinks: number | null;
}

/** The pre-0073 shape, from data the dashboard already reads. */
export function obligationsFrom(overview: Pick<CreatorOverview, "metrics" | "redemptions">, fans: readonly Pick<FanAccountSummary, "fanId" | "spinsRemaining" | "totalSpent">[]): CreatorObligations {
  const open = overview.redemptions.filter((r) => r.status === "pending" || r.status === "in_progress");
  const prizes = Math.max(overview.metrics.pending ?? 0, open.length);
  const owedFans = new Set(open.map((r) => r.fanId ?? `name:${r.fanName}`));
  const paying = fans.filter((f) => f.totalSpent > 0 && f.spinsRemaining > 0);
  return {
    prizes,
    fans: owedFans.size,
    fansAtLeast: prizes > open.length,
    paidSpins: paying.reduce((n, f) => n + f.spinsRemaining, 0),
    payingFans: paying.length,
    unplayedSpins: fans.reduce((n, f) => n + f.spinsRemaining, 0),
    activeLinks: null,
  };
}
