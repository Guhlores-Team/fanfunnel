// OPS-12: a site-wide pause. With FF_MAINTENANCE=1 (server env, then redeploy:
// Vercel applies env changes on the next deployment) fans and visitors see a
// friendly "back soon, nothing was spent" page, API writes answer 503
// {error:"maintenance"} with Retry-After, and the owner's way in stays open:
// /dashboard, /admin, /login (+ /mfa and /auth for two-factor sign-in),
// /api/admin/*, /api/health and static assets.
//
// How it is enforced. The proxy's matcher is deliberately narrow (PERF-4,
// src/proxy.test.ts: fan pages and cookieless API calls never run it), and a
// matcher cannot depend on an env var. So:
//   - next.config.ts adds rewrites built from MAINTENANCE_* below, ONLY when
//     FF_MAINTENANCE=1 at build time: every non-exempt page → /maintenance,
//     every non-exempt cookieless API call → /api/maintenance (503 for any
//     method). Zero cost when the switch is off.
//   - src/proxy.ts already sees every cookie-carrying API request: there a
//     write gets the 503 and a read (a signed-in dashboard poll) passes.
// Pure and dependency-free: imported by next.config.ts.

export const MAINTENANCE_RETRY_AFTER_SECONDS = 300;
export const MAINTENANCE_PAGE = "/maintenance";
export const MAINTENANCE_API = "/api/maintenance";

/** Page path prefixes that stay reachable: `x` matches `/x` and `/x/...`. */
export const MAINTENANCE_PAGE_EXEMPT = ["dashboard", "admin", "login", "mfa", "auth", "maintenance", "app-icon", "privacy", "terms", "_next"] as const;
/** API path prefixes (after /api/) that stay reachable. */
export const MAINTENANCE_API_EXEMPT = ["admin", "health", "maintenance"] as const;

export function maintenanceOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.FF_MAINTENANCE === "1";
}

const prefix = (list: readonly string[]) => `(?:${list.join("|")})(?:/|$)`;
/** Regex body (path-to-regexp param) for pages NOT exempt: no /api, no exempt prefix, no file with an extension. */
export const MAINTENANCE_PAGE_PARAM = `(?!api(?:/|$)|${prefix(MAINTENANCE_PAGE_EXEMPT)}|.*\\.[A-Za-z0-9]+$).*`;
/** Regex body for /api/<rest> NOT exempt. */
export const MAINTENANCE_API_PARAM = `(?!${prefix(MAINTENANCE_API_EXEMPT)}).*`;

const PAGE_RE = new RegExp(`^/${MAINTENANCE_PAGE_PARAM}$`);
const API_RE = new RegExp(`^/api/${MAINTENANCE_API_PARAM}$`);

export type MaintenanceRoute = "exempt" | "page" | "api";
/** Which side of the pause a path is on (the rewrites use the same patterns). */
export function maintenanceRoute(path: string): MaintenanceRoute {
  if (path === "/api" || path.startsWith("/api/")) return API_RE.test(path) ? "api" : "exempt";
  return PAGE_RE.test(path) ? "page" : "exempt";
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The proxy's decision for a request it sees: block an API write, else let it through. */
export function maintenanceBlocksWrite(path: string, method: string): boolean {
  return maintenanceRoute(path) === "api" && !READS.has(method.toUpperCase());
}

export const MAINTENANCE_HEADERS = {
  "Cache-Control": "no-store",
  "Retry-After": String(MAINTENANCE_RETRY_AFTER_SECONDS),
} as const;

/** next.config.ts rewrites while the switch is on (empty otherwise). */
export function maintenanceRewrites(env: Record<string, string | undefined> = process.env) {
  if (!maintenanceOn(env)) return [];
  return [
    { source: "/", destination: MAINTENANCE_PAGE },
    { source: `/:path(${MAINTENANCE_PAGE_PARAM})`, destination: MAINTENANCE_PAGE },
    { source: `/api/:path(${MAINTENANCE_API_PARAM})`, missing: [{ type: "header" as const, key: "cookie" }], destination: MAINTENANCE_API },
  ];
}
