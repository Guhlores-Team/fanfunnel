import { NextResponse } from "next/server";
import { readCappedText } from "@/lib/monitoring/report";

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
 * The largest JSON body any route parses (1 MiB). The biggest legitimate
 * payload is a 500-row fan import (IMPORT_MAX_ROWS) of about 100 KB; a wheel
 * save with 50 described prizes is well under that. Vercel's 4.5 MB request
 * cap bounds the wire; this keeps a multi-megabyte body from being parsed and
 * validated (A26 H9: 6 MB bodies were parsed before validation refused them).
 */
export const JSON_BODY_MAX_BYTES = 1024 * 1024;

/**
 * Parse a JSON request body. Returns the parsed value, or the {@link BAD_REQUEST}
 * sentinel when the body is missing/malformed or larger than
 * {@link JSON_BODY_MAX_BYTES} — callers turn that into a 400. The cap is
 * enforced while reading (declared Content-Length first, then the stream), so
 * an oversized body is never buffered or parsed.
 *
 *   const body = await parseJsonBody<{ token?: string }>(req);
 *   if (body === BAD_REQUEST) return badRequest();
 */
export async function parseJsonBody<T = unknown>(
  req: Request,
): Promise<T | typeof BAD_REQUEST> {
  try {
    const text = await readCappedText(req, JSON_BODY_MAX_BYTES);
    if (text === "too_large") return BAD_REQUEST;
    return JSON.parse(text) as T;
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
 *    `not_allowed`, `on_break`,
 *    `not_configured`          → 403 (allowed-in-principle but gated)
 *  - `not_found`               → 404
 *  - `has_history`, `conflict`,
 *    `sold_out`                → 409
 *  - `rate_limited`            → 429
 *  - anything else             → 400
 */
export function statusForError(code: string): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "feature_disabled":
    case "forbidden":
    case "blocked":
    case "needs_ack":
    case "locked":
    case "not_allowed":
    case "not_configured":
    case "on_break":
    case "mfa_required":
      return 403;
    case "not_found":
      return 404;
    case "game_kind_locked":
    case "game_in_use":
    case "game_not_ready":
    case "bingo_active_card":
    case "stock_changed":
    case "sold_out":
    case "already_delivered":
    case "has_history":
    case "game_busy":
    case "conflict":
    case "last_admin":
    case "account_cleanup_pending":
      return 409;
    case "expired":
      return 410;
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
