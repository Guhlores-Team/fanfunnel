import { formatCents } from "@/lib/format";

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
