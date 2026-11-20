import "server-only";
import { ACCOUNT_EMAIL_LOCAL_PART, ACCOUNT_EMAIL_NAME, DEFAULT_ALERT_EMAIL_FROM, currentEnvironment } from "@/lib/monitoring/config";

// Account e-mail (C5): mail about a person's own account — "you're approved",
// agency invitations, the admin's "new access request" note — sent through
// Resend's HTTP API (plain fetch, like the error alerts) from a dedicated
// "FanFunnel <account@…>" sender on the owner's verified domain, in the same
// branded look as the Supabase auth e-mails (supabase/templates/*.html).
// Needs RESEND_API_KEY (docs/handoff/GO_LIVE_KEYS.md: required for creator
// e-mail). Local development never sends. Nothing here throws.

export interface AccountMailConfig {
  apiKey: string | null;
  from: string;
}

export interface AccountMail {
  subject: string;
  html: string;
  text: string;
}

const ADDRESS = /<([^<>\s@]+@([^<>\s@]+\.[^<>\s@]+))>\s*$|^\s*([^<>\s@]+@([^<>\s@]+\.[^<>\s@]+))\s*$/;

/** The sender: ACCOUNT_EMAIL_FROM, else "FanFunnel <account@domain of the alert sender>". */
export function accountMailConfig(env: NodeJS.ProcessEnv = process.env): AccountMailConfig {
  const apiKey = env.RESEND_API_KEY?.trim() || null;
  const explicit = env.ACCOUNT_EMAIL_FROM?.trim();
  if (explicit) return { apiKey, from: explicit };
  const alertFrom = env.ALERT_EMAIL_FROM?.trim() || DEFAULT_ALERT_EMAIL_FROM;
  const m = ADDRESS.exec(alertFrom) ?? ADDRESS.exec(DEFAULT_ALERT_EMAIL_FROM)!;
  const domain = m[2] ?? m[4];
  return { apiKey, from: `${ACCOUNT_EMAIL_NAME} <${ACCOUNT_EMAIL_LOCAL_PART}@${domain}>` };
}

/** Whether this server can send account e-mail now: a Resend key, and not local development. */
export function canSendAccountEmail(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!accountMailConfig(env).apiKey && currentEnvironment(env) !== "development";
}

/** This site's absolute origin (NEXT_PUBLIC_SITE_URL, else Vercel's), or null. */
export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim() || (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) || env.VERCEL_URL?.trim() || "";
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return null;
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface BrandedEmailInput {
  subject: string;
  /** Inbox preview line. */
  preheader: string;
  heading: string;
  /** Plain-text paragraphs (escaped here). */
  paragraphs: string[];
  button?: { label: string; url: string } | null;
  /** Small print under a divider. */
  footnote: string;
}

/** The sign-in e-mails' look (supabase/templates/confirmation.html), as html + text. Pure. */
export function brandedEmail(m: BrandedEmailInput): AccountMail {
  const paras = m.paragraphs
    .map((p, i) => `<p style="margin:0 0 ${i === m.paragraphs.length - 1 ? 28 : 14}px 0;font-size:16px;line-height:1.55;color:#c9c3cf;">${esc(p)}</p>`)
    .join("\n                  ");
  const button = m.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#ec4899" style="border-radius:12px;background:#ec4899;">
                        <a href="${esc(m.button.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:700;color:#160d12;text-decoration:none;border-radius:12px;">${esc(m.button.label)} &rarr;</a>
                      </td>
                    </tr>
                  </table>`
    : "";
  const plainLink = m.button
    ? `<p style="margin:0 0 6px 0;font-size:13px;line-height:1.5;color:#a09aa8;">Button not working? Copy this link into your browser:</p>
                  <p style="margin:0 0 20px 0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(m.button.url)}" target="_blank" style="color:#f472b6;text-decoration:underline;">${esc(m.button.url)}</a></p>
                  `
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>FanFunnel</title>
</head>
<body style="margin:0;padding:0;background:#0c0a0e;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(m.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0c0a0e;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
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
                <td style="padding:32px 28px 8px 28px;font-family:${FONT};">
                  <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;color:#f4f1f6;">${esc(m.heading)}</h1>
                  ${paras}
                  ${button}
                </td>
              </tr>
              <tr>
                <td style="padding:24px 28px 28px 28px;font-family:${FONT};">
                  ${plainLink}<p style="margin:0;padding-top:16px;border-top:1px solid #2a2533;font-size:13px;line-height:1.5;color:#a09aa8;">${esc(m.footnote)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:1.5;color:#6f6878;">
            Sent by FanFunnel &middot; You're receiving this because of an action on your account.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  const text = [m.heading, "", ...m.paragraphs.flatMap((p) => [p, ""]), ...(m.button ? [`${m.button.label}: ${m.button.url}`, ""] : []), m.footnote].join("\n");
  return { subject: m.subject, html, text };
}

/** One account e-mail through Resend. Never throws; true when Resend accepted it. */
export async function sendAccountEmail(
  cfg: AccountMailConfig,
  to: string[],
  mail: AccountMail,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.apiKey || to.length === 0) return false;
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.from, to, subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) console.warn(`[account-mail] e-mail was not accepted (HTTP ${res.status}).`);
    return res.ok;
  } catch {
    console.warn("[account-mail] e-mail could not be sent.");
    return false;
  }
}
