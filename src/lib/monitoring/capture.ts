// Server-side capture pipeline for monitored errors:
//   redact -> truncate -> drop noise -> fingerprint -> upsert -> alert decision.
// Used by POST /api/errors (browser reports) and src/instrumentation.ts
// (server errors). Nothing here throws: a monitoring failure must never break
// the request that hit the error.
import { runAfterResponse } from "@/lib/afterResponse";
import { rateLimit } from "@/lib/rateLimit";
import { claimAppErrorAlert, recordAppError } from "@/lib/data/appErrors";
import {
  DIGEST_CHECK_INTERVAL_MS,
  MAX_MESSAGE,
  MAX_STACK,
  MAX_USER_AGENT,
  SERVER_CAPTURE_PER_WINDOW,
  currentEnvironment,
  type ErrorEnvironment,
  type ErrorSource,
} from "./config";
import { scrub, scrubRoute, truncate } from "./scrub";
import { fingerprint } from "./fingerprint";
import { isNoise } from "./report";
import {
  adminErrorsUrl,
  alertConfig,
  buildDigestEmail,
  buildErrorEmail,
  noteAlertsOff,
  sendAlertEmail,
  shouldAlert,
  type RecordOutcome,
} from "./alert";

export interface CaptureInput {
  source: ErrorSource;
  message: string;
  stack?: string | null;
  route?: string | null;
  userAgent?: string | null;
  environment?: ErrorEnvironment;
}

/** A redacted, size-bounded occurrence ready to store. */
export interface CleanError {
  source: ErrorSource;
  environment: ErrorEnvironment;
  message: string;
  stack?: string;
  route?: string;
  userAgent?: string;
}

/** Redact and bound every field. Null when nothing worth storing is left. */
export function cleanError(input: CaptureInput): CleanError | null {
  const message = truncate(scrub(input.message)?.trim(), MAX_MESSAGE);
  if (!message) return null;
  const stack = truncate(scrub(input.stack ?? undefined), MAX_STACK);
  if (isNoise(message, stack)) return null;
  return {
    source: input.source,
    environment: input.environment ?? currentEnvironment(),
    message,
    ...(stack ? { stack } : {}),
    ...(input.route ? { route: scrubRoute(input.route) } : {}),
    ...(input.userAgent ? { userAgent: truncate(scrub(input.userAgent), MAX_USER_AGENT) } : {}),
  };
}

/** Upsert one cleaned occurrence. Null on any failure. */
export async function storeError(e: CleanError): Promise<RecordOutcome | null> {
  try {
    const fp = await fingerprint({ message: e.message, stack: e.stack, source: e.source });
    return await recordAppError({ fingerprint: fp, ...e });
  } catch {
    return null;
  }
}

/**
 * E-mail the first occurrence of a fingerprint (or a resolved one returning)
 * within the global hourly budget; a repeat instead checks, at most once per
 * DIGEST_CHECK_INTERVAL_MS per instance, whether throttled errors are waiting
 * for a digest. Never throws.
 */
export async function alertFor(e: CleanError, outcome: RecordOutcome): Promise<void> {
  try {
    const cfg = alertConfig();
    if (!cfg.enabled) {
      noteAlertsOff(cfg);
      return;
    }
    const link = adminErrorsUrl();
    if (shouldAlert(outcome, e.environment, cfg)) {
      const claim = await claimAppErrorAlert(cfg.maxPerHour, outcome.id);
      if (!claim.send) return;
      await sendAlertEmail(
        cfg,
        buildErrorEmail(
          {
            environment: e.environment,
            source: e.source,
            route: e.route ?? null,
            message: e.message,
            count: outcome.count,
            firstSeen: outcome.firstSeen,
            reopened: outcome.reopened,
          },
          { pending: claim.pending, link },
        ),
      );
      return;
    }
    if (!cfg.environments.includes(e.environment)) return;
    if (!rateLimit("monitoring:digest-check", 1, DIGEST_CHECK_INTERVAL_MS).ok) return;
    const digest = await claimAppErrorAlert(cfg.maxPerHour);
    if (digest.send && digest.pending > 0) {
      await sendAlertEmail(cfg, buildDigestEmail(digest.pending, e.environment, link));
    }
  } catch {
    /* alerts are best-effort */
  }
}

/** Store now, alert after the response. For callers that can await. */
export async function captureNow(input: CaptureInput): Promise<void> {
  const e = cleanError(input);
  if (!e) return;
  const outcome = await storeError(e);
  if (outcome) runAfterResponse(() => alertFor(e, outcome));
}

/** Fire-and-forget: store and alert entirely after the response. */
export function captureAfterResponse(input: CaptureInput): void {
  const e = cleanError(input);
  if (!e) return;
  runAfterResponse(async () => {
    const outcome = await storeError(e);
    if (outcome) await alertFor(e, outcome);
  });
}

// Next's control-flow "errors" (redirect(), notFound(), dynamic bail-outs) are
// not bugs.
const CONTROL_FLOW = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

type ServerRequestInfo = { path?: string; headers?: Record<string, string | string[] | undefined> };
type ServerContext = { routePath?: string; routeType?: string };

/** instrumentation.ts onRequestError → app_errors. Never throws. */
export async function captureServerError(
  err: unknown,
  request: ServerRequestInfo,
  context: ServerContext,
): Promise<void> {
  try {
    const e = err as { message?: unknown; stack?: unknown; digest?: unknown } | null;
    const digest = typeof e?.digest === "string" ? e.digest : "";
    const message = typeof e?.message === "string" && e.message ? e.message : String(err);
    if (CONTROL_FLOW.test(digest) || CONTROL_FLOW.test(message)) return;
    // A hot failure loop must not become a write storm (per instance).
    if (!rateLimit("monitoring:server-capture", SERVER_CAPTURE_PER_WINDOW, 60_000).ok) return;
    const ua = request.headers?.["user-agent"];
    await captureNow({
      source: "server",
      message,
      stack: typeof e?.stack === "string" ? e.stack : null,
      // The route FILE path ("/spin/[token]") when known: no token to leak.
      route: context.routePath || request.path || null,
      userAgent: Array.isArray(ua) ? ua[0] : ua ?? null,
    });
  } catch {
    /* never let monitoring break a request */
  }
}
