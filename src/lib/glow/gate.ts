// Visit glow (RM-3): may this fan get the glow, and may a visit be recorded?
//
// RM-6 SEAM. This is the glow's side of the shared engagement gate (F6,
// `fanEngagementAllowed`, built by RM-6). Until RM-6 lands it checks what the
// schema has today: a creator block and a paused (self-excluded) link. When it
// lands, make this delegate to fanEngagementAllowed and have the two callers
// pass the fan's break end:
//   - src/lib/data/checkins.ts (fan select: add `break_until`)
//   - src/lib/data/mock.ts     (mockGlowGateInput: add the mock fan's break)
// No other glow code decides engagement.

export interface GlowGateInput {
  /** fans.blocked_at: the creator blocked this fan. */
  blockedAt?: string | null;
  /** The fan paused (self-excluded) this link. */
  paused?: boolean;
  /** RM-6: the fan is taking a break until this instant. */
  breakUntil?: string | null;
}

export function glowGateOpen(fan: GlowGateInput, now: Date = new Date()): boolean {
  if (fan.blockedAt) return false;
  if (fan.paused) return false;
  if (fan.breakUntil && Date.parse(fan.breakUntil) > now.getTime()) return false;
  return true;
}
