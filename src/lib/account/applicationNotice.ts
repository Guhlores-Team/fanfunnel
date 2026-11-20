import "server-only";
import { alertConfig } from "@/lib/monitoring/alert";
import { currentEnvironment } from "@/lib/monitoring/config";
import { accountMailConfig, brandedEmail, sendAccountEmail, siteOrigin, type AccountMail, type AccountMailConfig } from "./accountMail";

// C6: a new access request used to show up only when an admin happened to
// open Admin. Admins now see it in the bell (notifications.ts reads pending
// requests, which RLS shows to admins only) and, when Resend is configured,
// one e-mail goes to ALERT_EMAIL_TO per new request (never for an edit). The
// e-mail names nobody: it only says a request is waiting, with a link to Admin.

/** The admin e-mail. Pure: carries no applicant data. */
export function buildApplicationAlertEmail(origin: string | null): AccountMail {
  const link = origin ? `${origin}/dashboard?section=admin` : null;
  return brandedEmail({
    subject: "New creator access request on FanFunnel",
    preheader: "Someone asked for a FanFunnel creator account.",
    heading: "New access request",
    paragraphs: [
      "Someone asked for a FanFunnel creator account and is waiting for review.",
      link ? "Open Admin to approve or reject it." : "Open the dashboard › Admin to approve or reject it.",
    ],
    button: link ? { label: "Review requests", url: link } : null,
    footnote: "Sent to the addresses in ALERT_EMAIL_TO.",
  });
}

/** E-mail the admins about one new request. Never throws. */
export async function sendApplicationAlert(
  deps: {
    cfg?: AccountMailConfig;
    to?: string[];
    send?: (cfg: AccountMailConfig, to: string[], mail: AccountMail) => Promise<boolean>;
    environment?: string;
  } = {},
): Promise<"sent" | "skipped" | "failed"> {
  try {
    const cfg = deps.cfg ?? accountMailConfig();
    const to = deps.to ?? alertConfig().to;
    if (!cfg.apiKey || to.length === 0 || (deps.environment ?? currentEnvironment()) === "development") return "skipped";
    const send = deps.send ?? sendAccountEmail;
    return (await send(cfg, to, buildApplicationAlertEmail(siteOrigin()))) ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
