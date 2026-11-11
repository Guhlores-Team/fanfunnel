/** Shared focus/chase policy. No account identifiers or server secrets. */
export const MAX_COMBINED_BOOST = 5;
export const MIN_FOCUS_MULTIPLIER = 1.5;
export const DEFAULT_FOCUS_MULTIPLIER = 3;
export const MIN_FOCUS_SPINS = 5;
export const MAX_FOCUS_SPINS = 50;
export const DEFAULT_FOCUS_SPINS = 10;
export const DEFAULT_CHASE_WITHIN = 10;
/** A paid focus is kept when it cannot actually increase the target's odds. */
export const FOCUS_PAUSE_WITHOUT_ODDS_INCREASE = true;
/** New modifier math is explicit; historical v3 snapshots keep their old rules. */
export const FOCUS_WEIGHT_RULE = "focus-v1" as const;

export const isFocusMultiplier = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= MIN_FOCUS_MULTIPLIER && value <= MAX_COMBINED_BOOST;

export const isFocusLength = (value: unknown): value is number =>
  Number.isInteger(value) && typeof value === "number" && value >= MIN_FOCUS_SPINS && value <= MAX_FOCUS_SPINS;
