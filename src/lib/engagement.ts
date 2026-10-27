// F6 engagement gate: may FanFunnel suggest a "come back / keep going" nudge
// for this fan? Isomorphic (no server imports) so the dashboard can use it too.
//
// Every surface that nudges a specific fan (the win-back queue, the Fans tab's
// shareable link, later streak glow / install nudges / push about a fan) asks
// this one function, so the exclusions can't drift apart.

export interface EngagementFacts {
  /** The creator blocked this fan (fans.blocked_at set). */
  blocked: boolean;
  /** The fan paused (self-excluded) one of their links. */
  selfExcluded: boolean;
  /**
   * The fan is taking a break until this time (RM-6, fans.break_until): the
   * RM-6 seam. Absent / null = not on a break, which is every fan until RM-6
   * (0049) fills FanAccountSummary.breakUntil. Win-back (getCreatorCrm) and
   * the Fans tab's Copy link pass the whole summary here, so once RM-6 fills
   * it nothing else needs wiring. A future time means "on a break".
   */
  breakUntil?: string | null;
}

export function fanEngagementAllowed(f: EngagementFacts, now: number = Date.now()): boolean {
  if (f.blocked || f.selfExcluded) return false;
  if (f.breakUntil) {
    const until = Date.parse(f.breakUntil);
    // An unreadable break date fails closed: treat the fan as on a break.
    if (Number.isNaN(until) || until > now) return false;
  }
  return true;
}

/**
 * The link FanFunnel hands out for a fan (win-back, the Fans tab's Copy link,
 * the drawer's Copy DM): the newest ACTIVE, non-paused link, and none at all
 * when the fan fails the engagement gate.
 */
export function contactToken(
  f: EngagementFacts & { activeToken: string | null },
  now: number = Date.now(),
): string | null {
  return fanEngagementAllowed(f, now) ? f.activeToken : null;
}
