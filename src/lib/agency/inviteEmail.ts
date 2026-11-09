import "server-only";
import { currentEnvironment } from "@/lib/monitoring/config";
import { accountMailConfig, brandedEmail, sendAccountEmail, siteOrigin, type AccountMail, type AccountMailConfig } from "@/lib/account/accountMail";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitShared } from "@/lib/rateLimit";
import { AGENCY_INVITE_TTL_DAYS } from "./config";

// C10: an agency invitation used to exist only in-app, so an invitee who never
// signed in never knew. When Resend is configured, a NEW invitation (one the
// owner's request just created, never a repeat) e-mails the invited address
// from the account sender.
//
// B2 (batch 6 attack audit): the org name is the owner's own text, so any
// creator could otherwise use FanFunnel's sending domain to mail strangers.
// Only an address that already has an active FanFunnel account is e-mailed
// (anyone else sees the invitation in-app once they sign up with it), at most
// INVITE_MAIL_PER_DAY times per address per 24 h across every agency, and the
// caller (withInviteEmail) never mails for a role switch on an existing invite.
// Those checks run after the response, so the owner's answer and its timing
// are the same whether or not the address has an account (no enumeration).

export const INVITE_MAIL_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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
      "Sign in to FanFunnel with this address and accept the invitation on your dashboard.",
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

/** Whether an active FanFunnel account uses this (normalized) address. Service role, server only. */
async function hasActiveAccount(address: string): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from("profiles")
    .select("id")
    .eq("email", address)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return !error && !!data;
}

/**
 * B2: e-mail a NEW agency invitation only to an existing active account, and
 * at most INVITE_MAIL_PER_DAY times per address per day. Never throws.
 */
export async function deliverAgencyInviteEmail(
  address: string,
  orgName: string,
  role: string | null,
  deps: {
    hasAccount?: (address: string) => Promise<boolean>;
    limit?: (key: string, limit: number, windowMs: number) => Promise<{ ok: boolean }>;
    send?: (to: string, orgName: string, role: string | null) => Promise<"sent" | "skipped" | "failed">;
  } = {},
): Promise<"sent" | "skipped" | "failed" | "no_account" | "capped"> {
  try {
    if (!(await (deps.hasAccount ?? hasActiveAccount)(address))) return "no_account";
    const { ok } = await (deps.limit ?? rateLimitShared)(`agency-invite-mail:${address}`, INVITE_MAIL_PER_DAY, DAY_MS);
    if (!ok) return "capped";
    return await (deps.send ?? sendAgencyInviteEmail)(address, orgName, role);
  } catch {
    return "failed";
  }
}
