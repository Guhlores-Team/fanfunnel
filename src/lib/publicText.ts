/**
 * TS-04: screening for text a creator publishes to fans (tagline, personal
 * note, prize names, game subtitle). It blocks the three ways scam copy
 * gets into a public page — links (incl. bare domains), phone numbers and
 * off-platform @handles — plus a short slur list. Pure; the API routes and
 * the editors share it, so the editor refuses the same text the server
 * refuses. Chat messages are not screened here (flag-only is a later step).
 */
export type PublicTextReason = "url" | "phone" | "handle" | "slur";
export interface PublicTextIssue {
  reason: PublicTextReason;
  /** The offending fragment, for the message ("remove 't.me/xxx'"). */
  match: string;
}

/** One cap for prize names on the editor, the API and the data layer (RD-17 / TS-18). */
export const MAX_PUBLIC_LABEL = 80;
/** The creator note shown atop every fan's page (TS-04: capped). */
export const MAX_CREATOR_NOTE = 500;

const URL_RE = /(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|me|app|link|ly|gg|tv|xyz|info|biz|us|uk|de|fr|es|it|nl|ca|au|to|cc|page|site|online|shop|store|club|live|fans|vip|chat)\b(?:\/[^\s]*)?/i;
// +1 555 123 4567, (555) 123-4567, 555.123.4567, 0049 171 1234567: 9+ digits with separators.
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const HANDLE_RE = /(?:^|[\s(,;:])@[a-z0-9_.]{3,}/i;
// A deliberately short, unambiguous list; the report menu covers the rest.
const SLURS = ["nigger", "faggot", "retard", "tranny", "kike", "spic", "chink"];

function digitsOf(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/** Null when the text may be published; otherwise why not. */
export function publicTextCheck(text: unknown): PublicTextIssue | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const url = URL_RE.exec(text);
  if (url) return { reason: "url", match: url[0] };
  const phone = PHONE_RE.exec(text);
  if (phone && digitsOf(phone[0]) >= 9) return { reason: "phone", match: phone[0].trim() };
  const handle = HANDLE_RE.exec(text);
  if (handle) return { reason: "handle", match: handle[0].trim() };
  const lower = text.toLowerCase();
  for (const slur of SLURS) {
    const at = lower.indexOf(slur);
    if (at >= 0) return { reason: "slur", match: text.slice(at, at + slur.length) };
  }
  return null;
}

/** Plain words for the creator, naming the fragment to remove. */
export function publicTextMessage(issue: PublicTextIssue, what = "This text"): string {
  switch (issue.reason) {
    case "url":
      return `${what} can't contain a link or web address (remove “${issue.match}”). Fans reach you through your tip link in Settings.`;
    case "phone":
      return `${what} can't contain a phone number (remove “${issue.match}”).`;
    case "handle":
      return `${what} can't contain an @handle (remove “${issue.match}”). Fans reach you through your tip link in Settings.`;
    default:
      return `${what} contains a word fans must not see (“${issue.match}”).`;
  }
}

/** The API's refusal code for an issue ("public_text_url"…). */
export function publicTextErrorCode(issue: PublicTextIssue): string {
  return `public_text_${issue.reason}`;
}
