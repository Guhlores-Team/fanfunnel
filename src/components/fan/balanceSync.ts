/**
 * WF-06 / RF-03: how an open fan page learns its balance from the server.
 * Pure rules, shared by the controller and the unit test.
 */

/** A visible, idle, out-of-plays page re-reads the server this often… */
export const BALANCE_POLL_MS = 30_000;
/** …at most this many times per page load (ten minutes), then only on return to the tab. */
export const BALANCE_POLL_MAX = 20;

export interface BalancePollState {
  spinsRemaining: number;
  idle: boolean;
  visible: boolean;
  online: boolean;
  /** Paused link, a break, or a blocked fan: nothing to wait for. */
  stopped: boolean;
  polls: number;
}

/** Should this tick re-read the server payload? Only when a top-up is the one thing the page waits for. */
export function shouldPollBalance(s: BalancePollState): boolean {
  return s.spinsRemaining === 0 && s.idle && s.visible && s.online && !s.stopped && s.polls < BALANCE_POLL_MAX;
}

/** Plays the server added since the page last agreed with it (null: none, or the balance went down). */
export function topUpDelta(shown: number, server: number): number | null {
  return Number.isSafeInteger(shown) && Number.isSafeInteger(server) && server > shown ? server - shown : null;
}

/** "+3 spins from Mia" / "+1 play from Mia": the note shown when a top-up reaches the open page. */
export function topUpNote(delta: number, creatorTitle: string, gameKind: "wheel" | "scratch" | "bingo"): string {
  const unit = gameKind === "wheel" ? "spin" : "play";
  return `+${delta} ${unit}${delta === 1 ? "" : "s"} from ${creatorTitle}`;
}
