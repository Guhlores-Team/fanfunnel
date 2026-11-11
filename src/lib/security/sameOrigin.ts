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
  /** The server runs on Vercel (`VERCEL=1`); see forwardedHost. */
  onVercel?: boolean;
}

/**
 * Batch 6 N5: `X-Forwarded-Host` is only a proxy's word for the host. On
 * Vercel the edge overwrites it (with its own `x-vercel-id` and
 * `x-vercel-deployment-url`), so there it is the host the browser used. Off
 * Vercel (a self-hosted `next start`) nothing overwrites it, so a client could
 * name any host and pass the comparison. Rule: trust it only when the server
 * runs on Vercel AND Vercel's header set is on the request; otherwise compare
 * with `Host` and the configured site URL only.
 */
function forwardedHost(headers: Headers, onVercel: boolean): string | null {
  if (!onVercel || !headers.get("x-vercel-id") || !headers.get("x-vercel-deployment-url")) return null;
  return headers.get("x-forwarded-host")?.split(",")[0]?.trim() || null;
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
 *     browser connected to, X-Forwarded-Host only under forwardedHost's rule,
 *     or a configured site URL); `null` never passes;
 *   - neither header: not a browser (curl, server-side fetch, the e2e
 *     harness), which cannot hold a victim's cookies, so it passes.
 */
export function isCrossOriginWrite({ method, path, headers, allowedOrigins = [], onVercel = false }: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (!path.startsWith("/api/") || isOriginExemptApi(path)) return false;
  if (!headers.get("cookie")) return false;

  const site = headers.get("sec-fetch-site");
  if (site) return site.trim().toLowerCase() !== "same-origin";

  const origin = headers.get("origin");
  if (origin === null) return false;
  const sent = originOf(origin);
  if (!sent) return true;
  if (ownHosts(headers, onVercel).includes(new URL(sent).host.toLowerCase())) return false;
  return !allowedOrigins.some((o) => originOf(o) === sent);
}

/** The host(s) the browser connected to: `Host`, and X-Forwarded-Host only under forwardedHost's rule. */
function ownHosts(headers: Headers, onVercel: boolean): string[] {
  return [forwardedHost(headers, onVercel), headers.get("host")?.trim()]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
}

export interface OwnPagePostInput {
  headers: Headers;
  /** The request's own URL (`req.url`); its origin always counts as ours. */
  requestUrl: string;
  /** Extra allowed origins (the deployment's configured site URL). */
  allowedOrigins?: readonly (string | undefined)[];
  /** The server runs on Vercel (`VERCEL=1`); see forwardedHost. */
  onVercel?: boolean;
}

/**
 * The strict variant (review A2), for a POST that must come from one of this
 * site's own pages whether or not it carries a cookie. isCrossOriginWrite
 * lets a cookie-less request through (no session to ride on), which is the
 * wrong rule for a request that CREATES a session: a cross-site form that
 * posts an attacker's own e-mail-link token would sign the victim's browser
 * in as the attacker (login CSRF), and that needs no cookie at all.
 *
 * True only when the browser itself says the request came from this origin:
 *   - `Sec-Fetch-Site` present: only `same-origin` passes. `none` (typed
 *     URL, bookmark) cannot be a form POST from our page; `same-site` is a
 *     sibling subdomain; `cross-site` is another site;
 *   - otherwise `Origin` present (browsers without Sec-Fetch-Site, e.g.
 *     Safari before 16.4, still send Origin on every form POST): it must be
 *     the request's own origin, a configured site URL, or `https://` + the
 *     host the browser connected to (a TLS-terminating proxy may hand the
 *     server an http:// request URL). `null` never passes;
 *   - neither header: refused. Unlike the cookie check there is no "not a
 *     browser" pass: nothing but our own page has a reason to send this.
 * A page must not be served with `Referrer-Policy: no-referrer`, which makes
 * browsers send `Origin: null` on its form POSTs (next.config.ts sets
 * strict-origin-when-cross-origin for every route).
 */
export function isOwnPagePost({ headers, requestUrl, allowedOrigins = [], onVercel = false }: OwnPagePostInput): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site.trim().toLowerCase() === "same-origin";
  const sent = originOf(headers.get("origin"));
  if (!sent) return false;
  if (sent === originOf(requestUrl)) return true;
  if (allowedOrigins.some((o) => originOf(o) === sent)) return true;
  const u = new URL(sent);
  return u.protocol === "https:" && ownHosts(headers, onVercel).includes(u.host.toLowerCase());
}
