import { CLOSE_ACCOUNT_PHRASE, FAN_DELETE_PHRASE } from "./config";

/** T4: why the account can't close yet; the card links to Fulfilment next to it. */
export const PRIZES_OWED_MESSAGE =
  "Fans are still waiting for prizes they won. Deliver or cancel every pending prize in Fulfilment first, then close your account.";

/** Server error code → the sentence the creator sees (Close my account). */

export function closeAccountErrorMessage(code: unknown): string {
  switch (code) {
    case "wrong_password":
      return "Your current password is incorrect.";
    case "confirm_mismatch":
      return `Type ${CLOSE_ACCOUNT_PHRASE} exactly to confirm.`;
    case "last_admin":
      return "You're the last admin. Make someone else an admin first.";
    case "suspended":
      return "This account is suspended, so it can't be closed from here. Contact us to close it.";
    case "reports_open":
      return "A safety report about this account is still under review. It can be closed once the review is done.";
    case "prizes_owed":
      return PRIZES_OWED_MESSAGE;
    case "mfa_required":
      return "Sign in with your two-factor code first, then try again.";
    case "rate_limited":
      return "Too many tries. Wait a while and try again.";
    case "demo_mode":
      return "Closing an account needs Supabase configured (demo mode).";
    default:
      return "Account deletion was not confirmed. Some cleanup may already have finished. Try again or ask an administrator to check cleanup.";
  }
}

/** Server error code → the sentence a fan sees (Download / Delete my data). */
export function fanDataErrorMessage(code: unknown, action: "export" | "delete"): string {
  switch (code) {
    case "rate_limited":
      return "You've tried a few times already. Wait an hour and try again.";
    case "confirm_mismatch":
      return `Type ${FAN_DELETE_PHRASE} to confirm.`;
    case "not_found":
      return "This link isn't connected to any data any more.";
    case "not_allowed":
      return "The demo fan can't be deleted. Try it with a link the creator made for you.";
    default:
      return action === "export"
        ? "Couldn't prepare your download. Try again."
        : "Couldn't delete your data. Nothing was deleted; try again.";
  }
}
