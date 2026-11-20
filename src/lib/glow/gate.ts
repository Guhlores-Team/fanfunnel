// Visit glow (RM-3): may this fan get the glow, and may a visit be recorded?
//
// This is the glow's side of the shared engagement gate (F6,
// `fanEngagementAllowed`, RM-6): a blocked fan, a paused (self-excluded) link
// and a fan on a break all close it. No other glow code decides engagement.

import { fanEngagementAllowed } from "@/lib/play/playGuard";

export interface GlowGateInput {
  /** fans.blocked_at: the creator blocked this fan. */
  blockedAt?: string | null;
  /** The fan paused (self-excluded) this link. */
  paused?: boolean;
  /** RM-6: the fan is taking a break until this instant. */
  breakUntil?: string | null;
}

export function glowGateOpen(fan: GlowGateInput, now: Date = new Date()): boolean {
  return fanEngagementAllowed(
    { blocked: !!fan.blockedAt, selfExcluded: !!fan.paused, breakUntil: fan.breakUntil ?? null },
    now.getTime()
  );
}
