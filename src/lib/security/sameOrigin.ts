// I4: a same-origin check for state-changing API requests that carry cookies,
// on top of the session cookie's SameSite=Lax (src/lib/supabase/cookies.ts).
// Lax still sends the cookie on requests from a sibling subdomain (same-site),
// and an older browser may not honour it; a browser always says where a
// request came from (Sec-Fetch-Site, or at least Origin on a non-GET), so a
// cross-origin write is refused before any route handler runs.
//
// Pure (no Next, no env reads beyond the argument), so src/proxy.ts and the
// unit tests share it.

/** Methods that never change state; the check skips them. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * API routes the check skips, each because it is not cookie-authenticated:
 *   - fan endpoints: authenticated only by the link token in the JSON body
 *     (src/lib/api/fanToken.ts), never by a session, so a cross-site page
 *     holding a creator's cookies gains nothing there;
 *   - /api/cron/: the scheduler's bearer secret (src/lib/privacy/cron.ts).
 * There is no inbound third-party webhook: /api/webhooks is the creator's
 * cookie-authenticated settings and stays checked.
 * routeOrigin.test.ts proves every listed route reads no session.
 */
export const ORIGIN_EXEMPT_API: readonly string[] = [
  "/api/spin",
  "/api/spin/status",
  "/api/fan/",
  "/api/fan-data/",
  "/api/fans/ack",
  "/api/leaderboard/opt-in",
  "/api/messages/fan",
  "/api/messages/fan/thread",
  "/api/messages/auto-intro",
  "/api/messages/auto-outro",
  "/api/report",
  "/api/self-exclude",
  "/api/wishlists",
  "/api/cron/",
];

export function isOriginExemptApi(path: string): boolean {
  return ORIGIN_EXEMPT_API.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

export interface OriginCheckInput {
  method: string;
  path: string;
  headers: Headers;
  /** Extra allowed origins (the deployment's configured site URL). */
  allowedOrigins?: readonly (string | undefined)[];
}

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether a request must be refused as a cross-origin write (403):
 *   - only non-GET/HEAD/OPTIONS requests under /api/ that carry a Cookie
 *     header and are not exempt are checked (a cookie-less request has no
 *     session to ride on);
 *   - `Sec-Fetch-Site` present: only `same-origin` passes;
 *   - otherwise `Origin` present: it must name this host (the Host the
 *     browser connected to, or a configured site URL); `null` never passes;
 *   - neither header: not a browser (curl, server-side fetch, the e2e
 *     harness), which cannot hold a victim's cookies, so it passes.
 */
export function isCrossOriginWrite({ method, path, headers, allowedOrigins = [] }: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (!path.startsWith("/api/") || isOriginExemptApi(path)) return false;
  if (!headers.get("cookie")) return false;

  const site = headers.get("sec-fetch-site");
  if (site) return site.trim().toLowerCase() !== "same-origin";

  const origin = headers.get("origin");
  if (origin === null) return false;
  const sent = originOf(origin);
  if (!sent) return true;
  const sentHost = new URL(sent).host.toLowerCase();
  const hosts = [headers.get("x-forwarded-host")?.split(",")[0]?.trim(), headers.get("host")?.trim()]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
  if (hosts.includes(sentHost)) return false;
  return !allowedOrigins.some((o) => originOf(o) === sent);
}
