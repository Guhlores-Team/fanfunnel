// E-mail ALERT_EMAIL_TO when a fan sends an urgent safety report (a minor,
// illegal content, an inappropriate photo), through the error-monitoring
// sender (Resend). Server-only by use. The e-mail carries the reason and the
// time only: never the fan's name, link, message or anything they typed.
// Throttled to REPORT_ALERTS_PER_HOUR (shared across instances when Upstash is
// configured); everything stays in Admin › Reports regardless.
import { rateLimitShared } from "@/lib/rateLimit";
import { adminErrorsUrl, alertConfig, sendAlertEmail, type AlertConfig, type AlertMail } from "@/lib/monitoring/alert";
import { currentEnvironment } from "@/lib/monitoring/config";
import { CHILD_SAFETY_ALERTS_PER_HOUR, REPORT_ALERTS_PER_HOUR, isChildSafetyReportReason, isUrgentReportReason } from "./config";

const HOUR = 60 * 60 * 1000;

/** Throttle keys: the shared urgent budget, child safety's own (T6), and the once-an-hour summary. */
export const URGENT_ALERT_KEY = "alerts:urgent-report";
export const CHILD_SAFETY_ALERT_KEY = "alerts:urgent-report:child-safety";
export const SUPPRESSED_SUMMARY_KEY = "alerts:urgent-report:suppressed-summary";

/** The budget a report's alert draws on. */
export function alertBudgetFor(reason: string): { key: string; perHour: number } {
  return isChildSafetyReportReason(reason)
    ? { key: CHILD_SAFETY_ALERT_KEY, perHour: CHILD_SAFETY_ALERTS_PER_HOUR }
    : { key: URGENT_ALERT_KEY, perHour: REPORT_ALERTS_PER_HOUR };
}

// Alerts held back in this process, per hourly window (for the summary's count).
const suppressed = { windowStart: 0, count: 0 };
function countSuppressed(now: number): number {
  const windowStart = now - (now % HOUR);
  if (suppressed.windowStart !== windowStart) {
    suppressed.windowStart = windowStart;
    suppressed.count = 0;
  }
  return ++suppressed.count;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Absolute link to Admin › Reports, or null when no origin is known. */
export function adminReportsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const errors = adminErrorsUrl(env);
  return errors ? errors.replace(/#errors$/, "#reports") : null;
}

/** The alert e-mail for one urgent report. Pure; no fan data in, none out. */
export function buildReportAlertEmail(
  report: { reason: string; at: string },
  environment: string,
  link: string | null,
): AlertMail {
  const when = new Date(report.at);
  const at = Number.isNaN(when.getTime()) ? report.at : when.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const reason = report.reason.replace(/[\r\n]+/g, " ").slice(0, 120);
  const subject = `[FanFunnel ${environment}] Urgent safety report: ${reason}`;
  const where = link ? `Review it in Admin › Reports: ${link}` : "Review it in the dashboard › Admin › Reports.";
  const text = [
    `A fan sent an urgent safety report on FanFunnel (${environment}).`,
    "",
    `Reason: ${reason}`,
    `Received: ${at}`,
    "",
    where,
    "",
    "This e-mail never includes who sent the report or what they wrote.",
  ].join("\n");
  const button = link
    ? `<p style="margin:20px 0 0 0;"><a href="${esc(link)}" style="display:inline-block;background:#ec4899;color:#0c0a0e;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px;">Open Admin &rsaquo; Reports</a></p>`
    : `<p style="margin:20px 0 0 0;">Open the dashboard &rsaquo; Admin &rsaquo; Reports.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FanFunnel</title></head>
<body style="margin:0;padding:24px;background:#0c0a0e;color:#f4f1f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<h1 style="margin:0 0 12px 0;font-size:20px;">Urgent safety report</h1>
<p style="margin:0 0 8px 0;color:#c9c3cf;">A fan sent a report that needs a prompt review.</p>
<p style="margin:0;"><strong>Reason:</strong> ${esc(reason)}<br><strong>Received:</strong> ${esc(at)}</p>
${button}
<p style="margin:24px 0 0 0;font-size:12px;color:#a09aa8;">This e-mail never includes who sent the report or what they wrote.</p>
</body></html>`;
  return { subject, html, text };
}

/**
 * T6: the one e-mail an hour that says alerts are being held back, so a spent
 * budget is never silent. Pure; carries counts and links only.
 */
export function buildSuppressedSummaryEmail(
  summary: { suppressed: number; perHour: number; childSafety: boolean },
  environment: string,
  link: string | null,
): AlertMail {
  const n = Math.max(1, Math.floor(summary.suppressed));
  const what = summary.childSafety ? "child-safety report alerts" : "urgent report alerts";
  const subject = `[FanFunnel ${environment}] ${n} ${n === 1 ? "alert" : "alerts"} suppressed this hour`;
  const where = link ? `Review every report in Admin › Reports: ${link}` : "Review every report in the dashboard › Admin › Reports.";
  const text = [
    `The hourly limit of ${summary.perHour} ${what} was reached on FanFunnel (${environment}).`,
    `${n} ${n === 1 ? "alert has" : "alerts have"} been suppressed so far this hour, and more may follow until the hour resets.`,
    "Every report is still saved. Nothing was lost; only the e-mails were held back.",
    "",
    where,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FanFunnel</title></head>
<body style="margin:0;padding:24px;background:#0c0a0e;color:#f4f1f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<h1 style="margin:0 0 12px 0;font-size:20px;">${esc(`${n} ${n === 1 ? "alert" : "alerts"} suppressed this hour`)}</h1>
<p style="margin:0 0 8px 0;color:#c9c3cf;">${esc(`The hourly limit of ${summary.perHour} ${what} was reached. Every report is still saved; only the e-mails were held back.`)}</p>
${link ? `<p style="margin:20px 0 0 0;"><a href="${esc(link)}" style="display:inline-block;background:#ec4899;color:#0c0a0e;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px;">Open Admin &rsaquo; Reports</a></p>` : `<p style="margin:20px 0 0 0;">Open the dashboard &rsaquo; Admin &rsaquo; Reports.</p>`}
</body></html>`;
  return { subject, html, text };
}

/**
 * Send the alert for one new report when its reason is urgent and its hourly
 * budget allows (child-safety reasons have their own, T6). When a budget is
 * spent, one summary e-mail an hour says alerts are being held back. Never
 * throws; resolves whether the report's own e-mail was accepted.
 */
export async function alertUrgentReport(
  report: { reason: string; at: string },
  deps: {
    cfg?: AlertConfig;
    send?: (cfg: AlertConfig, mail: AlertMail) => Promise<boolean>;
    limit?: (key: string, limit: number, windowMs: number) => Promise<{ ok: boolean }>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  try {
    if (!isUrgentReportReason(report.reason)) return false;
    const cfg = deps.cfg ?? alertConfig();
    const environment = currentEnvironment();
    if (!cfg.enabled || !cfg.environments.includes(environment)) return false;
    const limit = deps.limit ?? rateLimitShared;
    const send = deps.send ?? ((c: AlertConfig, m: AlertMail) => sendAlertEmail(c, m));
    const budget = alertBudgetFor(report.reason);
    if (!(await limit(budget.key, budget.perHour, HOUR)).ok) {
      const count = countSuppressed(deps.now?.() ?? Date.now());
      if ((await limit(SUPPRESSED_SUMMARY_KEY, 1, HOUR)).ok) {
        await send(cfg, buildSuppressedSummaryEmail(
          { suppressed: count, perHour: budget.perHour, childSafety: budget.key === CHILD_SAFETY_ALERT_KEY },
          environment,
          adminReportsUrl(),
        ));
      }
      return false;
    }
    return await send(cfg, buildReportAlertEmail(report, environment, adminReportsUrl()));
  } catch {
    return false;
  }
}
