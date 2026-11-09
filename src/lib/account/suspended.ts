import { LEGAL } from "@/lib/legal";

// C11: a suspended creator used to get no explanation; saves just failed with
// a generic line. The dashboard now shows a banner on every section, and every
// error toast says why while the account is suspended. Pure + client-safe.
// The flag is display only: the server (can_act_for, which requires
// is_active) is what refuses the writes.

export const SUSPENDED_TITLE = "Your account is suspended";
export const SUSPENDED_MESSAGE = `An admin has suspended this account. You can still sign in and look around, but changes can't be saved and your games don't work for fans until it's reactivated. Questions? Email ${LEGAL.contactEmail}.`;
export const SUSPENDED_SAVE_SUFFIX = `Your account is suspended, so changes can't be saved. Email ${LEGAL.contactEmail}.`;

let suspended = false;

/** Set from the signed-in account (DashboardClient); read by the toasts. */
export function markAccountSuspended(value: boolean): void {
  suspended = value;
}

export function isAccountSuspended(): boolean {
  return suspended;
}

/** An error toast's text while suspended: the reason is always attached. */
export function withSuspendedReason(message: string): string {
  return suspended && !message.includes(LEGAL.contactEmail) ? `${message} ${SUSPENDED_SAVE_SUFFIX}` : message;
}
