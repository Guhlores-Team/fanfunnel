import { formatCents } from "@/lib/format";
import { contactToken } from "@/lib/engagement";

/**
 * The fan row's meta line (everything before the coloured "last won" part):
 * granted · links · spent · campaign names. Campaign attribution was on every
 * row before the redesign (as chips); it stays visible here, comma-separated.
 */
export function fanRowMeta(a: {
  grantedTotal: number;
  links: { token: string }[];
  totalSpent: number;
  campaignNames: string[];
}): string {
  const links = a.links.length;
  const parts = [
    `${a.grantedTotal} granted`,
    `${links} link${links === 1 ? "" : "s"}`,
    `${formatCents(a.totalSpent)} spent`,
  ];
  const campaigns = a.campaignNames.filter((c) => c.trim() !== "");
  if (campaigns.length > 0) parts.push(campaigns.join(", "));
  return parts.join(" · ");
}

/** Which fans already have an inbox thread (for the drawer's "Message"). */
export function threadFanIds(threads: { fanId: string }[]): Set<string> {
  return new Set(threads.map((t) => t.fanId));
}

/**
 * The link the Fans tab's "Copy link" (and the drawer's Copy link / Copy DM)
 * hands out: the same pick as win-back (contactToken), so never a paused or
 * inactive link and none for a blocked or self-excluded fan. `primaryToken`
 * (the newest link of any state) only labels the "newest" link in the drawer.
 */
export function copyLinkToken(a: {
  primaryToken: string | null;
  links: { token: string }[];
  activeToken: string | null;
  blocked: boolean;
  selfExcluded: boolean;
  breakUntil?: string | null;
}): string | null {
  return contactToken(a);
}

/** Why there is no link to copy (the toast when copyLinkToken is null). */
export function noLinkMessage(a: { blocked: boolean; selfExcluded: boolean; links: { token: string }[] }): string {
  if (a.blocked) return "This fan is blocked — unblock them to share a link.";
  if (a.selfExcluded) return "This fan paused their link, so there's no link to share.";
  if (a.links.length > 0) return "This fan has no active link — top up to mint one.";
  return "No link yet — top up this fan to mint one.";
}
