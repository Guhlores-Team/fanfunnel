// What an unauthenticated visitor may learn about a creator: the name shown on
// public surfaces (fan link, share card, link-in-bio page, leaderboard, home
// screen app) and whether those surfaces exist at all. Pure, so pages, the
// data layer and tests share one rule.

/** The label every public surface shows when a creator has no safe name. */
export const NEUTRAL_CREATOR_TITLE = "Creator";

/**
 * A creator's display name as public pages may show it (M1). An account
 * created before the sign-up form stopped sending the e-mail as the display
 * name can still have its address stored there, so any value containing "@"
 * is treated as an address and never shown; a missing, blank or address-like
 * name becomes the neutral label.
 */
export function publicCreatorTitle(raw: string | null | undefined): string {
  return publicCreatorName(raw) ?? NEUTRAL_CREATOR_TITLE;
}

/** {@link publicCreatorTitle} without the fallback: null when there is no safe name. */
export function publicCreatorName(raw: string | null | undefined): string | null {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return !name || name.includes("@") ? null : name;
}

/** The profile columns {@link isPublicCreator} reads. */
export const PUBLIC_CREATOR_COLUMNS = "id, display_name, is_active, approval_status, role";

export interface PublicCreatorRow {
  id: string;
  display_name: string | null;
  is_active: boolean | null;
  approval_status: string | null;
  role: string | null;
}

/**
 * Whether a creator's public pages may be served (L5): the account is active
 * and approved (an admin needs no approval). A suspended, pending or rejected
 * account answers exactly like an unknown one, so the pages are no oracle for
 * an account's state.
 */
export function isPublicCreator(row: Partial<PublicCreatorRow> | null | undefined): boolean {
  if (!row || row.is_active !== true) return false;
  return row.approval_status === "approved" || row.role === "admin";
}
