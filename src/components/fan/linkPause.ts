/** Pure state logic for the fan page's "Pause my link" (self-exclusion). */

export interface SpinControlInput {
  spinsRemaining: number;
  busy: boolean;
  paused: boolean;
  /** RM-6: the fan is on a break (the server refuses spins until it ends). */
  onBreak?: boolean;
  /** A previous request may have committed; reconcile it before spending again. */
  spinPending?: boolean;
}

export interface SpinControl {
  canSpin: boolean;
  /** Label for the big SPIN button. */
  label: string;
  /** Text inside the "Spins left" chip's value slot. */
  balanceLabel: string;
}

/**
 * A paused link always wins: SPIN is off no matter the balance or spin state.
 * A break (RM-6) comes next: SPIN is off, and the balance stays on show
 * because the fan's spins are kept for when the break ends.
 */
export function spinControl({ spinsRemaining, busy, paused, onBreak = false, spinPending = false }: SpinControlInput): SpinControl {
  if (paused) {
    return { canSpin: false, label: "Link paused", balanceLabel: "Paused" };
  }
  if (onBreak) {
    return { canSpin: false, label: "On a break", balanceLabel: String(spinsRemaining) };
  }
  if (spinPending) {
    return { canSpin: false, label: "Check your last spin", balanceLabel: "Checking…" };
  }
  return {
    canSpin: spinsRemaining > 0 && !busy,
    label: busy ? "Spinning…" : spinsRemaining > 0 ? "SPIN" : "Out of spins",
    balanceLabel: String(spinsRemaining),
  };
}

/** Fan-facing copy for a failed pause. Never echoes the raw server code. */
export function pauseErrorMessage(code: string | undefined): string {
  switch (code) {
    case "rate_limited":
      return "Too many tries — wait a moment and pause again.";
    case "not_found":
      return "We couldn't find this link — it may already be paused.";
    case "network":
      return "Connection problem. Check your network and try again.";
    default:
      return "Couldn't pause your link. Please try again.";
  }
}

/** The pause dialog's warning (T3): pausing is permanent and the wins page goes read-only. */
export const PAUSE_WARNING =
  "This permanently stops your link with this creator. You can still see your wins on this link, but it can't play or chat again, so copy any codes you won first. This can't be undone.";

/** Confirmation shown right after a successful pause. */
export const PAUSED_CONFIRMATION =
  "Your link is paused for good. SPIN and chat are now off. Your wins stay on this link to look back on.";

/** The fan page's note under a paused SPIN button. */
export const PAUSED_STATUS = "Your link is paused for good. It can't play again.";
