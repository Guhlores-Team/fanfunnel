// F6 engagement gate: may FanFunnel suggest a "come back / keep going" nudge
// for this fan? Isomorphic (no server imports) so the dashboard can use it too.
//
// Every surface that nudges a specific fan (the win-back queue, the Fans tab's
// shareable link, later streak glow / install nudges / push about a fan) asks
// this one function, so the exclusions can't drift apart.

import { fanEngagementAllowed, type EngagementState } from "@/lib/play/playGuard";

// The one gate lives with the guardrail (RM-6); re-exported so callers here
// and in the dashboard keep one import.
export { fanEngagementAllowed };
export type EngagementFacts = EngagementState;

/**
 * The link FanFunnel hands out for a fan (win-back, the Fans tab's Copy link,
 * the drawer's Copy DM): the newest ACTIVE, non-paused link, and none at all
 * when the fan fails the engagement gate.
 */
export function contactToken(
  f: EngagementState & { activeToken: string | null },
  now: number = Date.now(),
): string | null {
  return fanEngagementAllowed(f, now) ? f.activeToken : null;
}
