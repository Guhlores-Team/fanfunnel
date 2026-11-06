// In-house error monitoring: every tunable in one place. The owner flips these
// here (or through the env vars named below), not in the code that uses them.

/** Most alert e-mails sent per rolling hour, across all server instances. */
export const ALERT_MAX_PER_HOUR = 10;

/** Environments that e-mail by default (`ALERT_ENVIRONMENTS` overrides). */
export const DEFAULT_ALERT_ENVIRONMENTS = ["production"] as const;

/** Sender used when `ALERT_EMAIL_FROM` is unset (domain verified in Resend). */
export const DEFAULT_ALERT_EMAIL_FROM = "FanFunnel Alerts <alerts@easysimplesites.org>";

/** Rows kept in app_errors; a new fingerprint prunes the oldest resolved first. */
export const APP_ERRORS_MAX_ROWS = 1000;

/** POST /api/errors: largest accepted request body, in bytes. */
export const ERROR_REPORT_MAX_BYTES = 16 * 1024;

/** POST /api/errors: reports per IP per window, and the window. */
export const ERROR_REPORT_PER_IP = 20;
export const ERROR_REPORT_WINDOW_MS = 60_000;

/** POST /api/errors: reports accepted from everyone together per window. */
export const ERROR_REPORT_GLOBAL = 300;

/** Server-side capture: errors recorded per instance per window (a hot loop
 *  must not turn into a database write storm). */
export const SERVER_CAPTURE_PER_WINDOW = 60;

/** How often (per instance) a recorded repeat checks for a waiting digest. */
export const DIGEST_CHECK_INTERVAL_MS = 60_000;

/** Stored field limits (the migration's CHECKs match these). */
export const MAX_MESSAGE = 1000;
export const MAX_STACK = 8000;
export const MAX_ROUTE = 512;
export const MAX_USER_AGENT = 256;

export type ErrorEnvironment = "production" | "preview" | "development";
export type ErrorSource = "client" | "server";

/** The deploy this server runs as (Vercel's `VERCEL_ENV`), else development. */
export function currentEnvironment(env: NodeJS.ProcessEnv = process.env): ErrorEnvironment {
  const v = env.VERCEL_ENV;
  return v === "production" || v === "preview" ? v : "development";
}
