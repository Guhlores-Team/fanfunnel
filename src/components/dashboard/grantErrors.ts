/**
 * RD-05 / RD-10: a 4xx answer to a grant (new fan link or top-up) is a
 * definitive refusal — the server did not add spins and never will for that
 * request — so the form is released and the reason is said plainly. Only a
 * 5xx, a network failure or an unreadable body leaves the outcome unknown and
 * keeps the receipt for "Check this link again".
 */
export class GrantRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GrantRefusedError";
    this.code = code;
  }
}

/** HTTP statuses that mean "refused for this request": retrying the same request can never succeed. */
export function isDefinitiveRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function grantRefusalMessage(code: string): string {
  switch (code) {
    case "no_wheel":
      return "Create and save a game first, then generate fan links.";
    case "name_required":
      return "Enter the fan's handle or name before creating a link.";
    case "bad_request":
      return "Spins must be a whole number of 1 or more, and the amount a plain number. Fix the details and try again.";
    case "not_found":
      return "That fan or game no longer exists. Refresh the list and try again.";
    case "blocked":
      return "This fan is blocked. Unblock them before adding spins.";
    case "forbidden":
      return "You can't add spins for this fan.";
    case "upgrade_required":
      return "This page is out of date. Reload it and try again.";
    default:
      return "The server refused this request, so no spins were added. Check the details and try again.";
  }
}

/** Client-side check that mirrors the API's integer rule (1..1,000,000). */
export function parseSpinCount(value: string): number | null {
  const n = Number(value.trim());
  if (value.trim() === "" || !Number.isInteger(n) || n < 1 || n > 1_000_000) return null;
  return n;
}
