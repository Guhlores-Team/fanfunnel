// Names nobody may present under (TS-03): the operator, its staff roles and
// the words a scammer uses to look like them. One rule for every public name
// a person picks: a creator's display name, a public page slug and a fan's
// leaderboard board name. Pure: safe in client bundles, routes and tests.
//
// The database has its own, simpler rule in public._reserved_name() (0073),
// which set_display_name, set_public_profile and the profiles trigger call.
// This rule is at least as strict as that one in every case, so a name the
// route accepts is never refused by the database afterwards;
// reservedNames.test.ts runs a port of the SQL rule (and the SQL's own word
// lists, read from the migration) against this one to keep it that way.

/**
 * Words that may not appear ANYWHERE in a name (after normalisation): the
 * brand and the operator's domain. "thefanfunnel", "fanfunnel2",
 * "fan_funnel.support" are all refused.
 */
export const RESERVED_BRAND_WORDS = ["fanfunnel", "easysimplesites"] as const;

/**
 * Words a name may not BE (after normalisation), alone, with digits around
 * them ("admin1", "2support") or joined to another word from this list
 * ("supportteam", "official_mod", "help.desk"). Ordinary names that merely
 * contain the letters ("supportive_fan", "modesty") are fine.
 */
export const RESERVED_WORDS = [
  "admin", "admins", "administrator", "administrators", "sysadmin", "root", "system", "owner", "operator",
  "support", "staff", "team", "official", "help", "helpdesk", "mod", "mods", "moderator", "moderators",
  "security", "safety", "trustandsafety", "trustsafety", "abuse", "compliance", "legal", "privacy", "dmca",
  "billing", "payment", "payments", "account", "accounts", "verify", "verified", "verification",
  "bot", "noreply", "webmaster", "postmaster", "hostmaster", "info", "contact", "service", "customerservice",
  "api", "www", "mail", "terms",
] as const;

/**
 * Words that reserve a name when they appear as a SEPARATE word in it
 * ("Alice Support", "The Admin Guy", "mod_dan"), the database's word rule.
 * The first six are the SQL list; the plurals are this side's addition.
 * official, system, root, security, billing and abuse are NOT here: they
 * are reserved as a name (alone, digit-padded or joined to another reserved
 * word, see RESERVED_WORDS), so "Jane Official", "Root Beer Fan", "System
 * Shock" and "Security Sam" are allowed while "Official Support" and
 * "Security Team" are not.
 */
export const RESERVED_WORD_TOKENS = [
  "admin", "administrator", "support", "staff", "moderator", "mod",
  "admins", "administrators", "moderators", "mods",
] as const;
const TOKENS = new Set<string>(RESERVED_WORD_TOKENS);

const RESERVED = new Set<string>(RESERVED_WORDS);

/** Non-ASCII letters that look like ASCII ones (Cyrillic, Greek, fullwidth-folded). */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "һ": "h",
  "ԁ": "d", "ɡ": "g", "ո": "n", "ս": "u", "ν": "v", "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ρ": "p",
  "τ": "t", "υ": "u", "ω": "w", "ℓ": "l", "ı": "i", "ł": "l", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe",
};

/**
 * Characters nobody sees (zero-width spaces and joiners, direction marks,
 * variation selectors, fillers, tags). The database drops them before it
 * splits a name into words (public._reserved_name, 0073), so this side does
 * too: "mo<zero-width space>d dan" has the word "mod".
 */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E0FFF}]/gu;

/** Digits and symbols used in place of letters. Ambiguous ones list every reading. */
const LEET: Record<string, readonly string[]> = {
  "0": ["o"], "1": ["i", "l"], "3": ["e"], "4": ["a"], "5": ["s"], "7": ["t"], "8": ["b"], "9": ["g"],
  "$": ["s"], "@": ["a"], "!": ["i", "l"], "|": ["i", "l"], "+": ["t"], "(": ["c"], "€": ["e"], "£": ["l"], "¢": ["c"],
};
const LEET_CHARS = new Set(Object.keys(LEET));
/** Cap on ambiguous characters expanded combinatorially; beyond it the first reading is used. */
const MAX_AMBIGUOUS = 6;

/**
 * Lowercase, accents stripped, look-alike letters folded to ASCII, with every
 * separator (spaces, `_ . -`, punctuation) removed. Digits and leet symbols
 * are kept so {@link nameKeys} can read them both ways.
 */
export function foldName(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFKD").toLowerCase()) {
    if (/\p{M}/u.test(ch)) continue;
    const folded = CONFUSABLES[ch] ?? ch;
    for (const c of folded) {
      if (/[a-z0-9]/.test(c) || LEET_CHARS.has(c)) out += c;
    }
  }
  return out;
}

/**
 * Every way a name can be read: as typed, with leet characters read as
 * letters (each ambiguous one both ways), and each of those with digits
 * trimmed from the ends. Letters-only keys, deduplicated, blanks dropped.
 */
export function nameKeys(raw: string): string[] {
  const folded = foldName(raw);
  const readings = new Set<string>([folded.replace(/[^a-z0-9]/g, "")]);
  let variants = [""];
  let ambiguous = 0;
  for (const ch of folded) {
    const options = LEET[ch];
    if (!options) {
      variants = variants.map((v) => v + ch);
      continue;
    }
    const use = options.length > 1 && ambiguous++ < MAX_AMBIGUOUS ? options : [options[0]];
    variants = variants.flatMap((v) => use.map((o) => v + o));
  }
  for (const v of variants) readings.add(v);
  const keys = new Set<string>();
  for (const r of readings) {
    const clean = r.replace(/[^a-z0-9]/g, "");
    if (clean) keys.add(clean);
    const trimmed = clean.replace(/^[0-9]+|[0-9]+$/g, "");
    if (trimmed) keys.add(trimmed);
  }
  return [...keys];
}

/**
 * The name's separate words, split the two ways the database can split them
 * (on anything that is not an ASCII letter or digit, and on anything that is
 * not a letter or digit in any script), plus the same with accents and
 * look-alike letters folded. Invisible characters are dropped first.
 */
export function nameWords(raw: string): string[] {
  const visible = raw.replace(INVISIBLE, "");
  const lower = visible.toLowerCase();
  let folded = "";
  for (const ch of visible.normalize("NFKD").toLowerCase()) {
    if (/\p{M}/u.test(ch)) continue;
    folded += CONFUSABLES[ch] ?? ch;
  }
  const words = new Set<string>();
  for (const text of [lower, folded]) {
    for (const w of text.split(/[^a-z0-9]+/)) if (w) words.add(w);
    for (const w of text.split(/[^\p{L}\p{N}]+/u)) if (w) words.add(w);
  }
  return [...words];
}

/** Whether `key` is one reserved word or several joined together (up to three). */
function composedOfReserved(key: string, depth = 3): boolean {
  if (RESERVED.has(key)) return true;
  if (depth <= 1) return false;
  for (let i = 2; i < key.length - 1; i++) {
    if (RESERVED.has(key.slice(0, i)) && composedOfReserved(key.slice(i), depth - 1)) return true;
  }
  return false;
}

/**
 * Whether a display name, slug or board name is reserved: it names the
 * operator or its domain anywhere, has a staff word as one of its words, or
 * is a reserved word (alone, digit-padded or joined to another), read plainly
 * or through leet and look-alike letters.
 */
export function isReservedName(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  if (nameWords(raw).some((word) => TOKENS.has(word))) return true;
  for (const key of nameKeys(raw)) {
    if (RESERVED_BRAND_WORDS.some((brand) => key.includes(brand))) return true;
    if (composedOfReserved(key)) return true;
  }
  return false;
}

/** What to tell someone whose chosen name is reserved. */
export const RESERVED_NAME_MESSAGE = "That name is reserved for FanFunnel and its staff. Pick another.";
