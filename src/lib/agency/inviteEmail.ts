import "server-only";
import { currentEnvironment } from "@/lib/monitoring/config";
import { accountMailConfig, brandedEmail, sendAccountEmail, siteOrigin, type AccountMail, type AccountMailConfig } from "@/lib/account/accountMail";
import { AGENCY_INVITE_TTL_DAYS } from "./config";

// C10: an agency invitation used to exist only in-app, so an invitee who never
// signed in never knew. When Resend is configured, a NEW invitation (one the
// owner's request just created, never a repeat) e-mails the invited address
// from the account sender. The text is the same whether or not that address
// has an account (no enumeration): sign in with this address, or ask for an
// account with it, then accept in the dashboard.

const ROLE_WORDS: Record<string, string> = {
  manager: "a manager",
  chatter: "a chatter",
  fulfiller: "a fulfiller",
  analyst: "an analyst",
};

/** Pure. `orgName` is the owner's own text: escaped, trimmed and capped. */
export function buildAgencyInviteEmail(orgName: string, role: string | null, origin: string | null): AccountMail {
  const org = orgName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "An agency";
  const as = role ? `as ${ROLE_WORDS[role] ?? "staff"}` : "as one of its creators";
  const link = origin ? `${origin}/login?next=/dashboard` : null;
  return brandedEmail({
    subject: "You're invited to an agency on FanFunnel",
    preheader: `${org} invited you to join it on FanFunnel.`,
    heading: "You're invited",
    paragraphs: [
      `“${org}” invited this e-mail address to join its agency on FanFunnel ${as}.`,
      "Sign in to FanFunnel with this address and accept the invitation on your dashboard. New to FanFunnel? Request a creator account with this address first; the invitation shows up once your account is approved.",
      `The invitation expires after ${AGENCY_INVITE_TTL_DAYS} days.`,
    ],
    button: link ? { label: "Sign in to accept", url: link } : null,
    footnote: "If you don't know this agency, ignore this e-mail: nothing happens unless you accept.",
  });
}

/** E-mail one invited address. Never throws. */
export async function sendAgencyInviteEmail(
  to: string,
  orgName: string,
  role: string | null,
  deps: { cfg?: AccountMailConfig; send?: (cfg: AccountMailConfig, to: string[], mail: AccountMail) => Promise<boolean>; environment?: string } = {},
): Promise<"sent" | "skipped" | "failed"> {
  try {
    const cfg = deps.cfg ?? accountMailConfig();
    if (!cfg.apiKey || (deps.environment ?? currentEnvironment()) === "development") return "skipped";
    const send = deps.send ?? sendAccountEmail;
    return (await send(cfg, [to], buildAgencyInviteEmail(orgName, role, siteOrigin()))) ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
