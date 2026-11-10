// Names nobody may present under (TS-03): the operator, its staff roles and
// the words a scammer uses to look like them. One rule for every public name
// a person picks: a creator's display name, a public page slug and a fan's
// leaderboard board name. Pure: safe in client bundles, routes and tests.
//
// The database mirrors this list in public._reserved_name() (0073), which
// set_display_name and set_public_profile call. Change the list here and
// there in the same change; reservedNames.test.ts pins the exported words.

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
 * contain one ("supportive_fan", "modesty") are fine.
 */
export const RESERVED_WORDS = [
  "admin", "admins", "administrator", "administrators", "sysadmin", "root", "system", "owner", "operator",
  "support", "staff", "team", "official", "help", "helpdesk", "mod", "mods", "moderator", "moderators",
  "security", "safety", "trustandsafety", "trustsafety", "abuse", "compliance", "legal", "privacy", "dmca",
  "billing", "payment", "payments", "account", "accounts", "verify", "verified", "verification",
  "bot", "noreply", "webmaster", "postmaster", "hostmaster", "info", "contact", "service", "customerservice",
] as const;

const RESERVED = new Set<string>(RESERVED_WORDS);

/** Non-ASCII letters that look like ASCII ones (Cyrillic, Greek, fullwidth-folded). */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "һ": "h",
  "ԁ": "d", "ɡ": "g", "ո": "n", "ս": "u", "ν": "v", "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ρ": "p",
  "τ": "t", "υ": "u", "ω": "w", "ℓ": "l", "ı": "i", "ł": "l", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe",
};

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
 * operator or its domain anywhere, or is a staff word (alone, digit-padded or
 * joined to another), read plainly or through leet and look-alike letters.
 */
export function isReservedName(raw: string | null | undefined): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  for (const key of nameKeys(raw)) {
    if (RESERVED_BRAND_WORDS.some((brand) => key.includes(brand))) return true;
    if (composedOfReserved(key)) return true;
  }
  return false;
}

/** What to tell someone whose chosen name is reserved. */
export const RESERVED_NAME_MESSAGE = "That name is reserved for FanFunnel and its staff. Pick another.";
