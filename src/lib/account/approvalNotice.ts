import "server-only";
import { alertConfig, sendAlertEmail, type AlertConfig, type AlertMail } from "@/lib/monitoring/alert";
import { currentEnvironment } from "@/lib/monitoring/config";
import type { createServiceClient } from "@/lib/supabase/server";

// A30: approving a creator used to leave no trace for them; a pending creator
// had to keep reloading /pending. On approval the server now leaves an in-app
// notice (creator_notices, kind creator_approved, 0066; it shows in the bell)
// and, when the Resend sender is configured, e-mails the account's own address
// a short "you're approved" note through the existing alert sender. The
// e-mail carries no data beyond a link to the dashboard; it is an account
// e-mail (the privacy notice lists Resend for those). Local development never
// sends; a missing key or address just skips it. Nothing here throws, and the
// approval stands whatever happens to the notice or the e-mail.

type Service = Pick<ReturnType<typeof createServiceClient>, "from" | "auth">;
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Absolute dashboard link, or null when no origin is configured. */
export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim() || (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) || env.VERCEL_URL?.trim() || "";
  if (!raw) return null;
  try {
    return `${new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin}/dashboard`;
  } catch {
    return null;
  }
}

/** The approval e-mail. Pure: no account data in, none out. */
export function buildApprovalEmail(link: string | null): AlertMail {
  const where = link ? `Sign in to set up your first game: ${link}` : "Sign in to FanFunnel to set up your first game.";
  const text = ["Good news: your FanFunnel creator account has been approved.", "", where, "", "If you did not apply to FanFunnel, you can ignore this e-mail."].join("\n");
  const button = link
    ? `<p style="margin:20px 0 0 0;"><a href="${esc(link)}" style="display:inline-block;background:#ec4899;color:#0c0a0e;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px;">Open your dashboard</a></p>`
    : `<p style="margin:20px 0 0 0;">Sign in to FanFunnel to set up your first game.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FanFunnel</title></head>
<body style="margin:0;padding:24px;background:#0c0a0e;color:#f4f1f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<h1 style="margin:0 0 12px 0;font-size:20px;">You're approved</h1>
<p style="margin:0;color:#c9c3cf;">Your FanFunnel creator account has been approved.</p>
${button}
<p style="margin:24px 0 0 0;font-size:12px;color:#a09aa8;">If you did not apply to FanFunnel, you can ignore this e-mail.</p>
</body></html>`;
  return { subject: "You're approved on FanFunnel", html, text };
}

/** Leave the in-app notice. Never throws; false when it could not be written. */
export async function leaveApprovalNotice(svc: Service, creatorId: string): Promise<boolean> {
  try {
    const { error } = await svc.from("creator_notices").insert({ creator_id: creatorId, kind: "creator_approved", details: {} });
    if (error) console.error("approval notice: insert failed", error.code ?? "error");
    return !error;
  } catch {
    return false;
  }
}

/** E-mail the approved account's own address. Never throws. */
export async function sendApprovalEmail(
  svc: Service,
  creatorId: string,
  deps: { cfg?: AlertConfig; send?: (cfg: AlertConfig, mail: AlertMail) => Promise<boolean>; environment?: string } = {},
): Promise<"sent" | "skipped" | "failed"> {
  try {
    const cfg = deps.cfg ?? alertConfig();
    if (!cfg.apiKey || (deps.environment ?? currentEnvironment()) === "development") return "skipped";
    const { data, error } = await svc.auth.admin.getUserById(creatorId);
    const email = data?.user?.email ?? "";
    // Only a confirmed address of this very account: never one typed by anyone.
    if (error || !data?.user?.email_confirmed_at || !EMAIL.test(email)) return "skipped";
    const send = deps.send ?? sendAlertEmail;
    return (await send({ ...cfg, enabled: true, to: [email] }, buildApprovalEmail(dashboardUrl()))) ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
