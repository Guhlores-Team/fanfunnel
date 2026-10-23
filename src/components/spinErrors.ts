/**
 * Fan-facing copy for the error codes POST /api/spin can return (SpinError in
 * src/lib/data/index.ts, plus the route's own `bad_request`). Pure so it can be
 * unit-tested; raw server codes/text are never shown to the fan.
 */
export interface SpinErrorInfo {
  message: string;
  /** The fan can continue by (re-)acknowledging the age gate / terms. */
  reopenAgeGate?: boolean;
}

const GENERIC: SpinErrorInfo = { message: "Something went wrong. Try again." };

const MESSAGES: Record<string, SpinErrorInfo> = {
  no_spins: { message: "You're out of spins! Tip your creator to get more. 💖" },
  rate_limited: { message: "Whoa, slow down a sec — try again in a moment. 😅" },
  blocked: { message: "This link isn't active. Reach out to your creator." },
  needs_ack: {
    message: "Please confirm your age and accept the terms to keep spinning.",
    reopenAgeGate: true,
  },
  no_prizes: { message: "This wheel isn't ready yet — check back soon. 🎡" },
  not_found: { message: "We couldn't find this link. Double-check it with your creator." },
  db_error: { message: "We hit a snag on our end. Give it another try in a moment." },
  bad_request: { message: "That didn't go through. Refresh the page and try again." },
};

export function spinErrorInfo(code: unknown): SpinErrorInfo {
  return typeof code === "string" && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : GENERIC;
}

const ACK_GENERIC = "Couldn't save that — check your connection and try again.";

const ACK_MESSAGES: Record<string, string> = {
  rate_limited: "Too many attempts — wait a moment, then try again.",
  not_found: "We couldn't find this link. Double-check it with your creator.",
  db_error: "We hit a snag saving that on our end. Give it another try in a moment.",
  bad_request: "That didn't go through. Refresh the page and try again.",
};

/** Fan-facing copy for a failed POST /api/fans/ack (age gate / ToS). */
export function ackErrorMessage(code: unknown): string {
  return typeof code === "string" && Object.hasOwn(ACK_MESSAGES, code)
    ? ACK_MESSAGES[code]
    : ACK_GENERIC;
}
