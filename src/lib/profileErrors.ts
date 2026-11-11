// Display name and link-in-bio validation errors, shared by the routes, the
// data layer and the Settings UI. Pure: safe to import from client code.
//
// Migration 0071 (L2, M1) made set_display_name and set_public_profile (and
// the profiles trigger behind them) raise SQLSTATE 22023 for a value they
// refuse, and the unique public_slug raises 23505. Those become stable codes
// and a 400/409; the database's own text never reaches the client.

import { RESERVED_NAME_MESSAGE, isReservedName } from "@/lib/reservedNames";
import { publicTextCheck, publicTextErrorMessage, type PublicTextCode } from "@/lib/publicText";

type DbError = { code?: string | null; message?: string | null } | null | undefined;

/** An e-mail-shaped string: the shape public._looks_like_email refuses. */
export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type DisplayNameInputError =
  | "name_too_long"
  | "invalid_display_name"
  | "name_looks_like_email"
  | "name_reserved"
  | PublicTextCode;

/**
 * The route's own check of a trimmed, non-blank display name, so the demo
 * answers like the database. The database stays the authority: it also
 * refuses a name containing the account's own e-mail. TS-03/TS-04: a name
 * that presents as FanFunnel or its staff, or carries a link, e-mail, phone
 * number, other-app handle or slur, is refused too (fans see it on every
 * surface, including the installed app's name). `allowReserved` is for an
 * admin naming a staff account.
 */
export function displayNameInputError(name: string, opts: { allowReserved?: boolean } = {}): DisplayNameInputError | null {
  if (name.length > 80) return "name_too_long";
  if (CONTROL_CHARS.test(name)) return "invalid_display_name";
  if (looksLikeEmail(name)) return "name_looks_like_email";
  if (!opts.allowReserved && isReservedName(name)) return "name_reserved";
  const text = publicTextCheck(name, { field: "displayName" });
  if (!text.ok) return text.code;
  return null;
}

/** set_display_name's error as a stable code (0073 adds a "reserved" refusal). */
export function displayNameRpcError(error: DbError): string {
  if (error?.code !== "22023") return "db_error";
  const message = error.message ?? "";
  if (/reserved/i.test(message)) return "name_reserved";
  return /e-?mail/i.test(message) ? "name_looks_like_email" : "invalid_display_name";
}

/** set_public_profile's (or the profiles trigger's) error as a stable code. */
export function publicProfileRpcError(error: DbError): string {
  if (error?.code === "23505") return "slug_taken";
  if (error?.code !== "22023") return "db_error";
  const message = error.message ?? "";
  if (/reserved/i.test(message)) return "slug_reserved";
  if (/slug/i.test(message)) return "invalid_slug";
  if (/tagline/i.test(message)) return "invalid_tagline";
  if (/tip url/i.test(message)) return "invalid_tip_url";
  return "invalid_profile";
}

/** What the Profile card says for an /api/account/profile error code. */
export function displayNameErrorMessage(code: unknown): string {
  switch (code) {
    case "name_required":
      return "Enter a display name.";
    case "name_too_long":
      return "Keep your display name to 80 characters or fewer.";
    case "name_looks_like_email":
      return "Your display name can't be or contain an e-mail address. Fans see it, so pick a name instead.";
    case "invalid_display_name":
      return "That display name has characters we can't show. Use letters, numbers and punctuation.";
    case "name_reserved":
      return RESERVED_NAME_MESSAGE;
    case "rate_limited":
      return "Too many changes in a row. Wait a minute and try again.";
    case "forbidden":
      // A suspended account; the Profile card adds the reason and who to e-mail.
      return "Your name wasn't changed.";
    default:
      return publicTextErrorMessage(code) ?? "Couldn't save your name. Please try again.";
  }
}

/** What the Public page card says for an /api/public-profile error code. */
export function publicProfileErrorMessage(code: unknown): string {
  switch (code) {
    case "invalid_slug":
      return "Use letters, numbers, spaces, dashes or underscores in your link name.";
    case "slug_taken":
      return "That link name is taken. Try another one.";
    case "slug_reserved":
      return "That link name is reserved for FanFunnel and its staff. Try another one.";
    case "invalid_tip_url":
      return "That tip link doesn't look like a web address. Use an https:// link.";
    case "invalid_tagline":
      return "Keep your tagline to 200 characters or fewer.";
    case "invalid_note":
      return "Keep your note to 2,000 characters or fewer.";
    case "rate_limited":
      return "Too many changes in a row. Wait a minute and try again.";
    default:
      return publicTextErrorMessage(code) ?? "Couldn't save your public page. Please try again.";
  }
}
