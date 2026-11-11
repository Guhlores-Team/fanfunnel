// Screening for text a creator or fan publishes to other people (TS-04):
// no links, phone numbers, other-app handles or slurs in a tagline, prize
// name or description, creator note, display name or board name. Chat is
// different: flagText() only reports what it finds, it never blocks a
// message. Pure (no React, no server imports): the editor, every route and
// the tests share one rule.
//
// The database does not mirror these patterns; the routes are the authority
// (set_public_profile/set_creator_note only cap lengths). Rendering stays
// plain text everywhere, so this is about copy/paste scams and offensive
// text, not script injection.

export type PublicTextField =
  | "displayName"
  | "slug"
  | "tagline"
  | "creatorNote"
  | "prizeLabel"
  | "prizeDescription"
  | "boardName"
  | "chatIntro"
  | "chatOutro"
  | "pageText";

export type PublicTextProblem = "link" | "email" | "phone" | "handle" | "slur";

/** The stable `{ error }` code a route answers for each problem. */
export const PUBLIC_TEXT_CODES = {
  link: "contains_link",
  email: "contains_email",
  phone: "contains_phone",
  handle: "contains_handle",
  slur: "contains_slur",
} as const;
export type PublicTextCode = (typeof PUBLIC_TEXT_CODES)[PublicTextProblem];

export type PublicTextResult =
  | { ok: true }
  | { ok: false; problem: PublicTextProblem; code: PublicTextCode; message: string };

const FIELD_NOUN: Record<PublicTextField, string> = {
  displayName: "Your display name",
  slug: "Your link name",
  tagline: "Your tagline",
  creatorNote: "Your note to fans",
  prizeLabel: "Prize names",
  prizeDescription: "Prize descriptions",
  boardName: "Board names",
  chatIntro: "Your greeting",
  chatOutro: "Your follow-up message",
  pageText: "Public text",
};

const PROBLEM_TEXT: Record<PublicTextProblem, string> = {
  link: "can't include links or web addresses.",
  email: "can't include e-mail addresses.",
  phone: "can't include phone numbers.",
  handle: "can't include @handles or usernames for other apps.",
  slur: "can't include that word.",
};

// --- links -----------------------------------------------------------------

const TLDS =
  "com|net|org|io|co|me|app|gg|tv|xyz|link|page|site|online|club|cash|shop|store|info|biz|dev|ly|to|be|it|us|uk|ca|de|fr|es|nl|au|ru|in|br|live|fun|vip|pro|top|one|icu|cc|ws|fm|ai|so|sh|lol|wtf|chat|social|bio|fans|sex|xxx|adult|cam|tube|ee|gl|is|la|st|do|at|ch|se|no|dk|fi|pl|jp|kr|mx|cl|za|ng|il|tr|gr|pt|ie|cz|hu|ro|ua|id|my|ph|sg|th|vn|nz|hk|tw|cn";

const LINK_PATTERNS: RegExp[] = [
  /\b(?:https?|ftp|ftps|sftp):\/\//i,
  /\bwww\.[a-z0-9-]/i,
  // A bare domain: one or more labels, a known TLD, not followed by a letter
  // ("t.me", "cash.app", "jane.onlyfans.com") and not part of a longer token.
  new RegExp(`(?<![a-z0-9@._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![a-z0-9-])`, "i"),
  // Spelled-out dots: "example dot com", "example [dot] com", "example(dot)com".
  new RegExp(`\\b[a-z0-9-]{2,}\\s*(?:\\(\\s*dot\\s*\\)|\\[\\s*dot\\s*\\]|\\s+dot\\s+|\\{\\s*dot\\s*\\})\\s*(?:${TLDS})\\b`, "i"),
];

// --- e-mail addresses --------------------------------------------------------

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;

// --- phone numbers ----------------------------------------------------------

// Nine or more digits in a row, with spaces, dots, dashes or brackets between
// them: "+1 555 123 4567", "(555) 123-4567", "555.123.4567", "0044 20 7946 0958".
// Seven-digit runs are left alone (prices, counts, order numbers).
const PHONE_PATTERN = /(?:\+|\b00)?\d(?:[\s().-]*\d){8,}/;

// --- handles ---------------------------------------------------------------

const HANDLE_PATTERNS: RegExp[] = [
  // "@name" (not an e-mail: nothing word-like right before the @).
  /(?<![a-z0-9._-])@[a-z0-9_.]{2,}/i,
  // "ig: name", "snap - name", "telegram=name": a known app followed by a
  // separator and a username.
  /\b(?:ig|insta|instagram|snap|snapchat|telegram|tg|kik|whatsapp|discord|tiktok|twitter|onlyfans|fansly|cashapp|cash\s?app|venmo|paypal|zelle|signal|wickr|threema)\s*[:=]\s*\S{2,}/i,
];

// --- slurs -----------------------------------------------------------------

// A short list of the words that have no place in public text on this
// service. Matched on folded text (lowercase, accents and look-alikes
// removed, leet digits read as letters), with the vowels optionally starred
// out and one separator allowed between letters, so "n*gger", "f@gg0t" and
// "f.a.g" are caught. Plural "s" allowed. Word-bounded: "assassin" and
// "raccoon" are fine.
const SLUR_WORDS = [
  "nigger", "nigga", "faggot", "fag", "tranny", "trannie", "kike", "spic", "chink", "wetback", "raghead", "gook",
  "retard", "retarded", "dyke", "coon", "paki", "beaner", "towelhead",
];
const SLUR_LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a", "!": "i", "|": "i" };
const SLUR_CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "һ": "h",
  "ԁ": "d", "ɡ": "g", "ո": "n", "ս": "u", "ν": "v", "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ρ": "p", "τ": "t",
  "υ": "u", "ω": "w", "ı": "i",
};
const SLUR_PATTERNS: RegExp[] = SLUR_WORDS.map((word) => {
  const letters = [...word].map((l) => (/[aeiou]/.test(l) ? `(?:${l}|\\*)` : l)).join("[*._\\- ]?");
  return new RegExp(`(?<![a-z])${letters}s?(?![a-z])`);
});

function foldForSlurs(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKD").toLowerCase()) {
    if (/\p{M}/u.test(ch)) continue;
    out += SLUR_LEET[ch] ?? SLUR_CONFUSABLES[ch] ?? ch;
  }
  return out;
}

// --- API -------------------------------------------------------------------

/** Every problem in `text`, in reporting order (link, email, phone, handle, slur). */
export function flagText(text: unknown): PublicTextProblem[] {
  if (typeof text !== "string" || !text) return [];
  const problems: PublicTextProblem[] = [];
  if (LINK_PATTERNS.some((re) => re.test(text))) problems.push("link");
  if (EMAIL_PATTERN.test(text)) problems.push("email");
  if (PHONE_PATTERN.test(text)) problems.push("phone");
  if (HANDLE_PATTERNS.some((re) => re.test(text))) problems.push("handle");
  const folded = foldForSlurs(text);
  if (SLUR_PATTERNS.some((re) => re.test(folded))) problems.push("slur");
  return problems;
}

/**
 * Whether `text` may be published in `field`. The first problem found is
 * reported with a plain sentence the editor can show inline; routes answer
 * the `code`. Blank and non-string values pass (presence and length are the
 * caller's rules).
 */
export function publicTextCheck(text: unknown, { field }: { field: PublicTextField }): PublicTextResult {
  const [problem] = flagText(text);
  if (!problem) return { ok: true };
  return { ok: false, problem, code: PUBLIC_TEXT_CODES[problem], message: `${FIELD_NOUN[field]} ${PROBLEM_TEXT[problem]}` };
}

/** Creator-facing copy for a route's public-text `error` code; null for any other code. */
export function publicTextErrorMessage(code: unknown): string | null {
  switch (code) {
    case PUBLIC_TEXT_CODES.link:
      return "Public text can't include links or web addresses. Fans see it, so keep contact details off it.";
    case PUBLIC_TEXT_CODES.email:
      return "Public text can't include e-mail addresses.";
    case PUBLIC_TEXT_CODES.phone:
      return "Public text can't include phone numbers.";
    case PUBLIC_TEXT_CODES.handle:
      return "Public text can't include @handles or usernames for other apps.";
    case PUBLIC_TEXT_CODES.slur:
      return "Public text can't include that word.";
    default:
      return null;
  }
}

/** Whether `code` is one of the public-text refusal codes. */
export function isPublicTextCode(code: unknown): code is PublicTextCode {
  return typeof code === "string" && (Object.values(PUBLIC_TEXT_CODES) as string[]).includes(code);
}
