import "server-only";
import { currentEnvironment } from "@/lib/monitoring/config";
import { accountMailConfig, brandedEmail, sendAccountEmail, siteOrigin, type AccountMail, type AccountMailConfig } from "./accountMail";
import type { createServiceClient } from "@/lib/supabase/server";

// A30: approving a creator used to leave no trace for them; a pending creator
// had to keep reloading /pending. On approval the server now leaves an in-app
// notice (creator_notices, kind creator_approved, 0066; it shows in the bell)
// and, when the Resend sender is configured, e-mails the account's own address
// a short "you're approved" note from the account sender (accountMail.ts,
// "FanFunnel", branded like the sign-in e-mails). The
// e-mail carries no data beyond a link to the dashboard; it is an account
// e-mail (the privacy notice lists Resend for those). Local development never
// sends; a missing key or address just skips it. Nothing here throws, and the
// approval stands whatever happens to the notice or the e-mail.

type Service = Pick<ReturnType<typeof createServiceClient>, "from" | "auth">;
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** Absolute dashboard link, or null when no origin is configured. */
export function dashboardUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const origin = siteOrigin(env);
  return origin ? `${origin}/dashboard` : null;
}

/** The approval e-mail. Pure: no account data in, none out. */
export function buildApprovalEmail(link: string | null): AccountMail {
  return brandedEmail({
    subject: "You're approved on FanFunnel",
    preheader: "Your FanFunnel creator account has been approved.",
    heading: "You're approved",
    paragraphs: [
      "Good news: your FanFunnel creator account has been approved.",
      link ? "Sign in to set up your first game and share your link." : "Sign in to FanFunnel to set up your first game.",
    ],
    button: link ? { label: "Open your dashboard", url: link } : null,
    footnote: "If you did not apply to FanFunnel, you can ignore this e-mail.",
  });
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
  deps: {
    cfg?: AccountMailConfig;
    send?: (cfg: AccountMailConfig, to: string[], mail: AccountMail) => Promise<boolean>;
    environment?: string;
  } = {},
): Promise<"sent" | "skipped" | "failed"> {
  try {
    const cfg = deps.cfg ?? accountMailConfig();
    if (!cfg.apiKey || (deps.environment ?? currentEnvironment()) === "development") return "skipped";
    const { data, error } = await svc.auth.admin.getUserById(creatorId);
    const email = data?.user?.email ?? "";
    // Only a confirmed address of this very account: never one typed by anyone.
    if (error || !data?.user?.email_confirmed_at || !EMAIL.test(email)) return "skipped";
    const send = deps.send ?? sendAccountEmail;
    return (await send(cfg, [email], buildApprovalEmail(dashboardUrl()))) ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
