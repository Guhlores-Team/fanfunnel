import { NextResponse } from "next/server";

/**
 * Shared API route helpers.
 *
 * Goals:
 *  - one place to parse a JSON body (consistent 400 `{ error: "bad_request" }`),
 *  - one place to map a data-layer error string to an HTTP status, so the same
 *    code never means 401 in one route and 403 in another.
 *
 * Routes return `{ error }` (never the raw data-layer result) on the error path.
 */

/** Sentinel returned by {@link parseJsonBody} when the request body isn't JSON. */
export const BAD_REQUEST: unique symbol = Symbol("bad_request");

/**
 * Parse a JSON request body. Returns the parsed value, or the {@link BAD_REQUEST}
 * sentinel when the body is missing/malformed — callers turn that into a 400.
 *
 *   const body = await parseJsonBody<{ token?: string }>(req);
 *   if (body === BAD_REQUEST) return badRequest();
 */
export async function parseJsonBody<T = unknown>(
  req: Request,
): Promise<T | typeof BAD_REQUEST> {
  try {
    return (await req.json()) as T;
  } catch {
    return BAD_REQUEST;
  }
}

/** A ready-to-send 400 `{ error }` response (default code `bad_request`). */
export function badRequest(code = "bad_request"): NextResponse {
  return NextResponse.json({ error: code }, { status: 400 });
}

/**
 * Map a data-layer error string to an HTTP status, CONSISTENTLY across routes.
 *
 * Conventions (audited against existing routes):
 *  - `unauthorized`            → 401 (not signed in / no capability)
 *  - `forbidden`, `blocked`,
 *    `needs_ack`, `locked`,
 *    `not_allowed`,
 *    `not_configured`          → 403 (allowed-in-principle but gated)
 *  - `not_found`               → 404
 *  - `has_history`, `conflict` → 409
 *  - `rate_limited`            → 429
 *  - anything else             → 400
 */
export function statusForError(code: string): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "forbidden":
    case "blocked":
    case "needs_ack":
    case "locked":
    case "not_allowed":
    case "not_configured":
      return 403;
    case "not_found":
      return 404;
    case "has_history":
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    default:
      return 400;
  }
}

/**
 * Build the standard error response for a data-layer error code. Always emits
 * `{ error: code }` — never the raw result object — so internal fields don't
 * leak to clients.
 */
export function errorResponse(code: string): NextResponse {
  return NextResponse.json({ error: code }, { status: statusForError(code) });
}
