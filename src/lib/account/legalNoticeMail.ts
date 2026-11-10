import { formatLegalDate, type LegalChangeNotice } from "@/lib/legal";
import { accountMailConfig, brandedEmail, sendAccountEmail, siteOrigin, type AccountMail, type AccountMailConfig } from "./accountMail";

// TS-06: the Terms promise creators an e-mail about a material change. When
// an admin announces one, each active, approved creator gets this note from
// the account sender, one message per address (never a shared To line). It
// carries no account data: the date, an optional sentence the admin wrote,
// and links to the published text. Never throws; the announcement stands
// whatever happens to the mail, and the route reports the counts.

/** The announcement e-mail. Pure. */
export function buildLegalNoticeEmail(notice: LegalChangeNotice, origin: string | null, summary?: string | null): AccountMail {
  const date = formatLegalDate(notice.effectiveDate);
  const extra = typeof summary === "string" && summary.trim() ? [summary.trim()] : [];
  return brandedEmail({
    subject: `FanFunnel's Terms and Privacy Policy change on ${date}`,
    preheader: `An updated version takes effect on ${date}.`,
    heading: "Our Terms and Privacy Policy are changing",
    paragraphs: [
      `An updated version of the FanFunnel Terms of Service and Privacy Policy takes effect on ${date}.`,
      ...extra,
      origin
        ? `You can read the current text at ${origin}/terms and ${origin}/privacy. The new text is published there on that date.`
        : "You can read the current text on the Terms and Privacy pages. The new text is published there on that date.",
      "You do not need to do anything now. When the new version takes effect, your dashboard asks you to agree to it, and your fans are asked on their spin page.",
    ],
    button: origin ? { label: "Read the Terms", url: `${origin}/terms` } : null,
    footnote: "You are getting this because you have a FanFunnel creator account. If you do not agree with the change, you can close your account in Settings before that date.",
  });
}

export interface LegalNoticeMailResult {
  /** "not_configured": no sender/key (or local development); nothing was attempted. */
  status: "sent" | "partial" | "not_configured" | "none";
  sent: number;
  failed: number;
  /** Addresses not attempted because the time budget ran out. */
  unsent: number;
}

/**
 * Send the announcement to each address, a few at a time, inside a time
 * budget so the admin's request always answers. Never throws.
 */
export async function sendLegalNoticeEmails(
  notice: LegalChangeNotice,
  recipients: string[],
  deps: {
    cfg?: AccountMailConfig;
    send?: (cfg: AccountMailConfig, to: string[], mail: AccountMail) => Promise<boolean>;
    environment?: string;
    origin?: string | null;
    summary?: string | null;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<LegalNoticeMailResult> {
  const cfg = deps.cfg ?? accountMailConfig();
  if (!cfg.apiKey || deps.environment === "development") return { status: "not_configured", sent: 0, failed: 0, unsent: recipients.length };
  if (recipients.length === 0) return { status: "none", sent: 0, failed: 0, unsent: 0 };
  const send = deps.send ?? sendAccountEmail;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? 25_000);
  const mail = buildLegalNoticeEmail(notice, deps.origin === undefined ? siteOrigin() : deps.origin, deps.summary);
  let sent = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < recipients.length && now() < deadline) {
      const to = recipients[next++];
      const ok = await send(cfg, [to], mail).catch(() => false);
      if (ok) sent++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, recipients.length) }, worker));
  const unsent = recipients.length - sent - failed;
  return { status: failed === 0 && unsent === 0 ? "sent" : "partial", sent, failed, unsent };
}
