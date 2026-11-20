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
 * /not-found/<kind>/<id>#<section>.
 *
 * The root not-found.tsx must stay static: Next serialises it as the
 * not-found boundary of EVERY page, so a request API (headers(), cookies())
 * in it turns the ISR creator page (/c/[slug]) into a runtime 500. The page
 * therefore carries all three explanations (link, verify, busy) and shows the
 * right one by URL fragment (`:target`, no script needed) and, once hydrated,
 * by the path (src/components/fan/NotFoundKinds.tsx).
 */
export const NOT_FOUND_PREFIX = "/not-found";
export const NOT_FOUND_KINDS = ["spin", "share", "verify", "c", "leaderboard", "busy"] as const;
export type NotFoundKind = (typeof NOT_FOUND_KINDS)[number];
/** The section of the root not-found page that explains each kind. */
export const NOT_FOUND_SECTIONS = ["nf-link", "nf-verify", "nf-busy"] as const;
export type NotFoundSection = (typeof NOT_FOUND_SECTIONS)[number];

export function isNotFoundKind(value: unknown): value is NotFoundKind {
  return typeof value === "string" && (NOT_FOUND_KINDS as readonly string[]).includes(value);
}

export function sectionFor(kind: NotFoundKind | null): NotFoundSection {
  return kind === "verify" ? "nf-verify" : kind === "busy" ? "nf-busy" : "nf-link";
}

/** The unmatched path a dead link is sent to. `detail` is the id (or the retry seconds for `busy`). */
export function notFoundPath(kind: NotFoundKind, detail: string | number | null = null): string {
  const tail = detail === null || detail === "" ? "" : `/${encodeURIComponent(String(detail)).slice(0, 160)}`;
  return `${NOT_FOUND_PREFIX}/${kind}${tail}`;
}

/** Read the kind and detail back from such a path (the not-found page does this in the browser). */
export function parseNotFoundPath(pathname: string): { kind: NotFoundKind; detail: string | null } | null {
  const m = new RegExp(`^${NOT_FOUND_PREFIX}/([a-z]+)(?:/([^/]+))?/?$`).exec(pathname);
  if (!m || !isNotFoundKind(m[1])) return null;
  let detail: string | null = m[2] ?? null;
  try { if (detail) detail = decodeURIComponent(detail); } catch { detail = null; }
  return { kind: m[1], detail };
}

/** The retry wait a busy path carries, in whole seconds, or null. */
export function busyRetrySeconds(pathname: string): number | null {
  const parsed = parseNotFoundPath(pathname);
  if (!parsed || parsed.kind !== "busy" || !parsed.detail || !/^\d{1,5}$/.test(parsed.detail)) return null;
  return Number(parsed.detail);
}

/** A dead link: answer with the branded 404 (status 404, markup included). Never returns. */
export function linkNotFound(kind: Exclude<NotFoundKind, "busy">, detail: string | null = null): never {
  redirect(`${notFoundPath(kind, detail)}#${sectionFor(kind)}`);
}

/** WF-03: the address is over its link-attempt budget; an honest page, not "mistyped". */
export function linkAttemptsBlocked(retryAfterMs: number): never {
  redirect(`${notFoundPath("busy", Math.max(1, Math.ceil(retryAfterMs / 1000)))}#nf-busy`);
}
