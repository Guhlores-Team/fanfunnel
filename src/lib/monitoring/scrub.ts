// Redaction for monitored errors. Runs in the browser before a report is sent
// AND again on the server before anything is stored or e-mailed, so a report
// that skipped the client step (or was hand-crafted) is still cleaned.
//
// Builds on the debug console's redact() (fan /spin/<token> links, URL query
// strings, token=/code= params) and adds: e-mail addresses, bearer/JWT tokens,
// Supabase auth cookies, password/secret/key fields, bare 32+ hex tokens (the
// fan-link format), UUIDs and IPv4 addresses.
import { redact } from "@/components/debug/debug";

// Field names whose values are secrets (`*token*`, `*password*`, `*_key`, ...).
const SECRET_KEYS =
  "[\\w-]*(?:password|passwd|secret|token|api[_-]?key|apikey|service[_-]?role)[\\w-]*|pwd|authorization|cookie|session|otp|signature";

const RULES: [RegExp, string][] = [
  // Supabase session cookies: sb-<ref>-auth-token(.N)=<value>
  [/\b(sb-[\w-]*auth-token[\w.]*=)[^;\s"'`]+/gi, "$1[redacted]"],
  // Authorization: Bearer <token>
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]"],
  // JWTs anywhere (header.payload.signature).
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[jwt]"],
  // key=value / "key": "value" / key: value for secret-looking keys (a
  // value already handled above, e.g. "Bearer [redacted]", is left as is).
  [
    new RegExp(`\\b(${SECRET_KEYS})(["']?\\s*[:=]\\s*["']?)(?!Bearer\\b|Basic\\b|\\[)[^"'\\s&,;}\\])]+`, "gi"),
    "$1$2[redacted]",
  ],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  // UUIDs (fan / creator / row ids).
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]"],
  // Bare 32+ hex runs: fan-link tokens are 32 hex chars.
  [/\b[0-9a-f]{32,}\b/gi, "[redacted]"],
  // IPv4 addresses.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
];

/** Redact secrets and personal data from free text (message, stack, UA). */
export function scrub(text: string): string;
export function scrub(text: string | undefined | null): string | undefined;
export function scrub(text: string | undefined | null): string | undefined {
  if (text == null) return undefined;
  let out = redact(String(text));
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

/**
 * A route path safe to store: no origin, query or hash; a fan's spin token
 * replaced; id-like segments collapsed so `/api/fans/<uuid>` groups as one.
 */
export function scrubRoute(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  let p = String(path);
  try {
    // Absolute URL → just its path.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* not a URL; treat as a path */
  }
  p = p.split(/[?#]/)[0] || "/";
  if (!p.startsWith("/")) p = "/" + p;
  const parts = p.split("/").map((seg, i, all) => {
    if (!seg) return seg;
    if (all[i - 1] === "spin" && !/^\[.*\]$/.test(seg)) return "[token]";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "[id]";
    if (/^[0-9a-f]{16,}$/i.test(seg) || /^\d+$/.test(seg)) return "[id]";
    if (seg.length > 40) return "[id]";
    return scrub(seg);
  });
  return parts.join("/").slice(0, 512);
}

/** Cut to `max` characters (code units), marking the cut. */
export function truncate(text: string | undefined, max: number): string | undefined {
  if (text == null) return undefined;
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}
