export function formatCents(c: number): string {
  return "$" + (c / 100).toFixed(2);
}

/**
 * Normalize a user-entered external link so it always works as an absolute URL.
 * "onlyfans.com/x" → "https://onlyfans.com/x" (otherwise the browser treats it
 * as a same-site relative path and 404s). Leaves http(s)/mailto links as-is;
 * returns "" for blank input.
 */
export function externalUrl(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  return "https://" + s.replace(/^\/+/, "");
}

export interface TimeAgoOptions {
  /** Returned for an unparseable timestamp. Default "—". */
  invalid?: string;
  /**
   * When set, timestamps older than this many days are rendered as an absolute
   * locale date (month + day) instead of "Nd ago". When omitted, the full
   * weeks/months/years ladder is used.
   */
  absoluteAfterDays?: number;
}

/**
 * Compact relative time, e.g. "just now", "2h ago", "3d ago".
 *
 * Shared by the dashboard and the fan wins gallery. By default it uses the full
 * seconds→years ladder; pass `absoluteAfterDays` to switch to an absolute date
 * past a cutoff (the gallery shows "Mar 4" for older wins).
 */
export function timeAgo(iso: string, opts: TimeAgoOptions = {}): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return opts.invalid ?? "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (opts.absoluteAfterDays !== undefined) {
    if (days < opts.absoluteAfterDays) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
