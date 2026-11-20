import { safeNext } from "./safeNext";

// Pure routing rules for e-mail links: which page a link type lands on, and
// where a visitor who is ALREADY signed in goes when a link fails. No imports
// beyond safeNext, so the proxy (src/lib/supabase/middleware.ts), the route
// handlers (authLink.ts) and the pages share one definition.

export const OTP_TYPES: ReadonlySet<string> = new Set(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

/** Every reason a failed link can carry (authCopy.ts words each one). */
export const LINK_REASONS: ReadonlySet<string> = new Set(["expired", "invalid", "malformed", "banned", "busy"]);

/** Where a link of this type goes when it carries no (usable) `next`. */
export function defaultNextFor(type: string | null): string {
  if (type === "recovery") return "/reset-password";
  if (type === "invite") return "/set-password";
  if (type === "signup" || type === "email") return "/pending";
  return "/dashboard";
}

/** The query flags the signed-in pages read to show a fixed-text notice. */
export interface SessionNoticeParams {
  /** "1": this browser was just switched to another account by an e-mail link. */
  switched?: string;
  /** A failed link's reason (LINK_REASONS). */
  auth_link?: string;
  /** The failed link's type (OTP_TYPES). */
  type?: string;
}

/** Only the known flags with known values, as a query string ("" or "?…"). */
export function sessionNoticeQuery(params: SessionNoticeParams | URLSearchParams): string {
  const read = (k: keyof SessionNoticeParams) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return typeof v === "string" ? v : null;
  };
  const q = new URLSearchParams();
  if (read("switched") === "1") q.set("switched", "1");
  const reason = read("auth_link");
  if (reason && LINK_REASONS.has(reason)) {
    q.set("auth_link", reason);
    const type = read("type");
    if (type && OTP_TYPES.has(type)) q.set("type", type);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** `path` (same-site) with one more query flag. */
export function withQueryFlag(path: string, key: string, value: string): string {
  const safe = safeNext(path);
  const hashAt = safe.indexOf("#");
  const base = hashAt === -1 ? safe : safe.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : safe.slice(hashAt);
  const [pathname, query = ""] = base.split("?", 2);
  const q = new URLSearchParams(query);
  q.set(key, value);
  return `${pathname}?${q}${hash}`;
}

const NEW_PASSWORD_PAGES = new Set(["/reset-password", "/set-password"]);

/**
 * Review A5 / A6: where a visitor who already has a session goes when an
 * e-mail link fails. The sign-in page is no use to them (the proxy sends a
 * signed-in visitor on to the dashboard), so:
 *   - a used or expired recovery / invitation link → its new-password page,
 *     whose own rule decides (a session the link opened in the last hour may
 *     still set the password; any other must give the current one). This is
 *     the double-tap and Back-then-Continue case: the first tap already
 *     signed them in.
 *   - anything else → the dashboard with a fixed-text notice saying why
 *     nothing changed (`?auth_link=<reason>&type=<type>`). The dashboard
 *     forwards the flags to /pending for an account that is not approved, and
 *     a suspended account sees them above its read-only dashboard, so no
 *     account type loops.
 */
export function signedInLinkFailurePath(type: string | null, reason: string | null, next?: string | null): string {
  const t = type && OTP_TYPES.has(type) ? type : null;
  const r = reason && LINK_REASONS.has(reason) ? reason : "invalid";
  if ((t === "recovery" || t === "invite") && (r === "expired" || r === "invalid")) {
    const intended = typeof next === "string" ? safeNext(next, "") : "";
    return NEW_PASSWORD_PAGES.has(intended.split(/[?#]/)[0]) ? intended : defaultNextFor(t);
  }
  return `/dashboard${sessionNoticeQuery({ auth_link: r, type: t ?? undefined })}`;
}
