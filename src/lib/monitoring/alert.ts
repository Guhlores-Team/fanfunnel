// E-mail alerts for monitored errors, sent through Resend's HTTP API with plain
// fetch (no SDK). Server-only by use: it reads RESEND_API_KEY. The pieces are
// pure (config, decision, e-mail body) so they are unit-tested without I/O;
// sendAlertEmail() is the one network call and it never throws.
import {
  ALERT_MAX_PER_HOUR,
  DEFAULT_ALERT_EMAIL_FROM,
  DEFAULT_ALERT_ENVIRONMENTS,
  type ErrorEnvironment,
  type ErrorSource,
} from "./config";

export interface AlertConfig {
  /** All of RESEND_API_KEY and ALERT_EMAIL_TO are set. */
  enabled: boolean;
  apiKey: string | null;
  to: string[];
  from: string;
  environments: string[];
  maxPerHour: number;
}

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** Read the alert settings from the environment (server-only vars). */
export function alertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const apiKey = env.RESEND_API_KEY?.trim() || null;
  const to = (env.ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => EMAIL.test(s))
    .slice(0, 10);
  const environments = (env.ALERT_ENVIRONMENTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: !!apiKey && to.length > 0,
    apiKey,
    to,
    from: env.ALERT_EMAIL_FROM?.trim() || DEFAULT_ALERT_EMAIL_FROM,
    environments: environments.length ? environments : [...DEFAULT_ALERT_ENVIRONMENTS],
    maxPerHour: ALERT_MAX_PER_HOUR,
  };
}

/** What recording one occurrence told us. */
export interface RecordOutcome {
  id: string;
  isNew: boolean;
  reopened: boolean;
  count: number;
  firstSeen: string;
}

/**
 * The send decision before throttling: only the FIRST occurrence of a
 * fingerprint, or a resolved one coming back, and only in an alerting
 * environment, and only when alerts are configured.
 */
export function shouldAlert(
  outcome: Pick<RecordOutcome, "isNew" | "reopened">,
  environment: ErrorEnvironment,
  cfg: Pick<AlertConfig, "enabled" | "environments">,
): boolean {
  if (!cfg.enabled) return false;
  if (!cfg.environments.includes(environment)) return false;
  return outcome.isNew || outcome.reopened;
}

let loggedOff = false;
/** Log once per process that alerts are off because env vars are missing. */
export function noteAlertsOff(cfg: AlertConfig, log: (msg: string) => void = console.info): void {
  if (cfg.enabled || loggedOff) return;
  loggedOff = true;
  log("[monitoring] error e-mail alerts are off: set RESEND_API_KEY and ALERT_EMAIL_TO to turn them on.");
}

/** Absolute link to the admin Errors view, or null when no origin is known. */
export function adminErrorsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.NEXT_PUBLIC_SITE_URL?.trim() ||
    (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) ||
    env.VERCEL_URL?.trim() ||
    "";
  if (!raw) return null;
  try {
    const origin = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin;
    return `${origin}/dashboard?section=admin#errors`;
  } catch {
    return null;
  }
}

export interface AlertMail {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The shared branded shell (same look as supabase/templates/*.html). */
function shell(preheader: string, heading: string, bodyHtml: string, link: string | null): string {
  const button = link
    ? `<tr><td style="padding:8px 28px 8px 28px;font-family:${FONT};"><a href="${esc(link)}" style="display:inline-block;background:#ec4899;color:#0c0a0e;font-size:15px;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px;">Open Admin &rsaquo; Errors</a></td></tr>
<tr><td style="padding:8px 28px 0 28px;font-family:${FONT};font-size:12px;line-height:1.5;color:#a09aa8;word-break:break-all;">${esc(link)}</td></tr>`
    : `<tr><td style="padding:8px 28px 0 28px;font-family:${FONT};font-size:14px;color:#c9c3cf;">Open the dashboard &rsaquo; Admin &rsaquo; Errors.</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>FanFunnel</title>
</head>
<body style="margin:0;padding:0;background:#0c0a0e;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0c0a0e;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 20px 4px;font-family:${FONT};font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#f4f1f6;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:#ec4899;margin-right:8px;vertical-align:middle;"></span>Fan<span style="color:#ec4899;">Funnel</span>
          </td>
        </tr>
        <tr>
          <td style="background:#16131c;border:1px solid #2a2533;border-radius:16px;overflow:hidden;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:4px;line-height:4px;font-size:0;background:#ec4899;background-image:linear-gradient(90deg,#ec4899,#a855f7);">&nbsp;</td></tr>
              <tr>
                <td style="padding:28px 28px 8px 28px;font-family:${FONT};">
                  <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:800;letter-spacing:-0.02em;color:#f4f1f6;">${esc(heading)}</h1>
                  ${bodyHtml}
                </td>
              </tr>
              ${button}
              <tr><td style="height:24px;line-height:24px;font-size:0;">&nbsp;</td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:1.5;color:#6f6878;">
            FanFunnel error monitoring &middot; Sent to the addresses in ALERT_EMAIL_TO.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function row(label: string, value: string, mono = false): string {
  const v = mono
    ? `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#f4f1f6;word-break:break-word;">${esc(value)}</code>`
    : esc(value);
  return `<tr><td style="padding:6px 12px 6px 0;font-size:13px;color:#a09aa8;white-space:nowrap;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;font-size:14px;color:#f4f1f6;vertical-align:top;">${v}</td></tr>`;
}

/** The e-mail for one new or reopened error. Every field is already redacted. */
export function buildErrorEmail(
  e: {
    environment: ErrorEnvironment;
    source: ErrorSource;
    route: string | null;
    message: string;
    count: number;
    firstSeen: string;
    reopened: boolean;
  },
  opts: { pending: number; link: string | null },
): AlertMail {
  const what = e.reopened ? "Resolved error is back" : "New error";
  const short = e.message.length > 90 ? e.message.slice(0, 89) + "…" : e.message;
  const subject = `[FanFunnel ${e.environment}] ${what}: ${short}`.replace(/[\r\n]+/g, " ");
  const first = new Date(e.firstSeen);
  const firstSeen = Number.isNaN(first.getTime()) ? e.firstSeen : first.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const more =
    opts.pending > 0
      ? `<p style="margin:16px 0 0 0;font-size:14px;line-height:1.5;color:#fcd34d;">Plus ${opts.pending} more new ${opts.pending === 1 ? "error" : "errors"} held back by the hourly alert limit.</p>`
      : "";
  const body = `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.55;color:#c9c3cf;">${
    e.reopened ? "An error you marked resolved has happened again." : "A new error was recorded."
  }</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;font-family:${FONT};">
${row("Environment", e.environment)}
${row("Source", e.source === "server" ? "Server" : "Browser")}
${row("Route", e.route || "(unknown)", true)}
${row("Message", e.message, true)}
${row("Count", String(e.count))}
${row("First seen", firstSeen)}
</table>${more}`;
  const text = [
    `${what} on FanFunnel (${e.environment})`,
    "",
    `Source: ${e.source === "server" ? "Server" : "Browser"}`,
    `Route: ${e.route || "(unknown)"}`,
    `Message: ${e.message}`,
    `Count: ${e.count}`,
    `First seen: ${firstSeen}`,
    ...(opts.pending > 0 ? ["", `Plus ${opts.pending} more new error(s) held back by the hourly alert limit.`] : []),
    "",
    opts.link ? `Admin › Errors: ${opts.link}` : "Open the dashboard › Admin › Errors.",
  ].join("\n");
  return { subject, html: shell(`${what}: ${short}`, what, body, opts.link), text };
}

/** The catch-up e-mail for errors that were throttled earlier. */
export function buildDigestEmail(
  count: number,
  environment: ErrorEnvironment,
  link: string | null,
): AlertMail {
  const noun = count === 1 ? "error" : "errors";
  const subject = `[FanFunnel ${environment}] ${count} more new ${noun}`;
  const body = `<p style="margin:0;font-size:15px;line-height:1.55;color:#c9c3cf;">${count} more new ${noun} came in while the hourly alert limit was reached. They are listed, newest first, in Admin &rsaquo; Errors.</p>`;
  const text = `${count} more new ${noun} on FanFunnel (${environment}) came in while the hourly alert limit was reached.\n\n${
    link ? `Admin › Errors: ${link}` : "Open the dashboard › Admin › Errors."
  }`;
  return { subject, html: shell(subject, `${count} more new ${noun}`, body, link), text };
}

/**
 * POST the e-mail to Resend. Resolves true on a 2xx, false otherwise; never
 * throws and never logs the key or the response body.
 */
export async function sendAlertEmail(
  cfg: AlertConfig,
  mail: AlertMail,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.enabled || !cfg.apiKey) return false;
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) console.warn(`[monitoring] alert e-mail was not accepted (HTTP ${res.status}).`);
    return res.ok;
  } catch {
    console.warn("[monitoring] alert e-mail could not be sent.");
    return false;
  }
}
