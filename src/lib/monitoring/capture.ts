// Server-side capture pipeline for monitored errors:
//   redact -> truncate -> drop noise -> fingerprint -> upsert -> alert decision.
// Used by POST /api/errors (browser reports) and src/instrumentation.ts
// (server errors). Nothing here throws: a monitoring failure must never break
// the request that hit the error.
import { runAfterResponse } from "@/lib/afterResponse";
import { rateLimit, rateLimitShared } from "@/lib/rateLimit";
import { claimAppErrorAlert, clientRowAllowed, recordAppError, releaseAppErrorAlert, type AlertClaim } from "@/lib/data/appErrors";
import {
  CLIENT_ALERT_MAX_PER_HOUR,
  CLIENT_OPEN_ROWS_MAX,
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
  type AlertConfig,
  type AlertMail,
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

/**
 * Upsert one cleaned occurrence. Null on any failure, and (C3) for a NEW
 * browser fingerprint once the open client rows reach CLIENT_OPEN_ROWS_MAX.
 */
export async function storeError(e: CleanError): Promise<RecordOutcome | null> {
  try {
    const fp = await fingerprint({ message: e.message, stack: e.stack, source: e.source });
    if (e.source === "client" && !(await clientRowAllowed({ environment: e.environment, fingerprint: fp }, CLIENT_OPEN_ROWS_MAX))) return null;
    return await recordAppError({ fingerprint: fp, ...e });
  } catch {
    return null;
  }
}

/**
 * Send the e-mail for a claimed slot. A27: when Resend refuses it (or cannot be
 * reached) the slot is released, so the failure neither burns the hourly budget
 * nor loses the alert: its errors wait, pending, for the next digest.
 */
async function sendClaimed(claim: AlertClaim, cfg: AlertConfig, mail: AlertMail): Promise<boolean> {
  const ok = await sendAlertEmail(cfg, mail);
  if (!ok && claim.alertId) await releaseAppErrorAlert(claim.alertId);
  return ok;
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
    // C3: browser reports draw on their own small hourly share first, so they
    // can never use up the alert budget that server errors depend on.
    const clientShare = async () =>
      e.source !== "client" || (await rateLimitShared("monitoring:client-alerts", CLIENT_ALERT_MAX_PER_HOUR, 60 * 60 * 1000)).ok;
    if (shouldAlert(outcome, e.environment, cfg)) {
      if (!(await clientShare())) return;
      const claim = await claimAppErrorAlert(cfg.maxPerHour, outcome.id);
      if (!claim.send) return;
      await sendClaimed(
        claim,
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
    if (!(await clientShare())) return;
    const digest = await claimAppErrorAlert(cfg.maxPerHour);
    if (digest.send && digest.pending > 0) {
      await sendClaimed(digest, cfg, buildDigestEmail(digest.pending, e.environment, link));
    }
  } catch {
    /* alerts are best-effort */
  }
}

/**
 * A27: send a waiting digest of throttled errors even when no new error comes
 * along to trigger the check in alertFor. Run by the maintenance cron, so a
 * burst that stops still reaches ALERT_EMAIL_TO within a day. Never throws.
 */
export async function flushAlertDigest(environment: ErrorEnvironment = currentEnvironment()): Promise<"sent" | "none" | "off" | "failed"> {
  try {
    const cfg = alertConfig();
    if (!cfg.enabled) {
      noteAlertsOff(cfg);
      return "off";
    }
    if (!cfg.environments.includes(environment)) return "off";
    const digest = await claimAppErrorAlert(cfg.maxPerHour);
    if (!digest.send || digest.pending <= 0) return "none";
    return (await sendClaimed(digest, cfg, buildDigestEmail(digest.pending, environment, adminErrorsUrl()))) ? "sent" : "failed";
  } catch {
    return "failed";
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
