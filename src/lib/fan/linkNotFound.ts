import { redirect } from "next/navigation";

/**
 * WA-02: a branded 404 with a real 404 status AND server-rendered markup.
 *
 * `notFound()` thrown from a dynamic page cannot give both: before any
 * streaming Next answers 404 with an empty `__next_error__` shell and renders
 * not-found.tsx on the client (app-render.js getErrorRSCPayload: the shell is
 * fixed), and inside a Suspense boundary the markup is streamed but the status
 * is already 200 (docs: loading.js, "Status codes"). The only render that
 * gives 404 + markup is an unmatched route, so a dead link is sent to one:
 * /not-found/<kind>/<id>. The proxy tags the kind on the request and the root
 * not-found.tsx renders the matching branded page.
 */
export const NOT_FOUND_PREFIX = "/not-found";
export const NOT_FOUND_KIND_HEADER = "x-ff-not-found";
export const NOT_FOUND_RETRY_HEADER = "x-ff-not-found-retry";
export const NOT_FOUND_KINDS = ["spin", "share", "verify", "c", "leaderboard", "busy"] as const;
export type NotFoundKind = (typeof NOT_FOUND_KINDS)[number];

export function isNotFoundKind(value: unknown): value is NotFoundKind {
  return typeof value === "string" && (NOT_FOUND_KINDS as readonly string[]).includes(value);
}

/** The unmatched path a dead link is sent to. `detail` is the id (or the retry seconds for `busy`). */
export function notFoundPath(kind: NotFoundKind, detail: string | number | null = null): string {
  const tail = detail === null || detail === "" ? "" : `/${encodeURIComponent(String(detail)).slice(0, 160)}`;
  return `${NOT_FOUND_PREFIX}/${kind}${tail}`;
}

/** Read the kind and detail back from such a path (the proxy does this). */
export function parseNotFoundPath(pathname: string): { kind: NotFoundKind; detail: string | null } | null {
  const m = new RegExp(`^${NOT_FOUND_PREFIX}/([a-z]+)(?:/([^/]+))?/?$`).exec(pathname);
  if (!m || !isNotFoundKind(m[1])) return null;
  let detail: string | null = m[2] ?? null;
  try { if (detail) detail = decodeURIComponent(detail); } catch { detail = null; }
  return { kind: m[1], detail };
}

/** A dead link: answer with the branded 404 (status 404, markup included). Never returns. */
export function linkNotFound(kind: Exclude<NotFoundKind, "busy">, detail: string | null = null): never {
  redirect(notFoundPath(kind, detail));
}

/** WF-03: the address is over its link-attempt budget; an honest page, not "mistyped". */
export function linkAttemptsBlocked(retryAfterMs: number): never {
  redirect(notFoundPath("busy", Math.max(1, Math.ceil(retryAfterMs / 1000))));
}
