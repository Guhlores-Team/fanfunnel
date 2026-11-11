import { ADMIN_ITEM, NAV_GROUPS, type Tab } from "./DashboardShell";

// Mobile (below `lg`) section navigation, RD-6 / owner decision P9: a bottom tab
// bar with the design's four primary sections plus "More", and a More sheet that
// holds every other section so nothing becomes unreachable on a phone.

/** The bar's fixed sections, in the design's order (Today / Inbox / Wheels / Fans). */
export const BAR_TABS: readonly Tab[] = ["today", "inbox", "editor", "fans"];

export interface MoreGroup {
  title: string;
  items: [Tab, string][];
}

/**
 * Sections listed in the More sheet: everything not on the bar, grouped and
 * ordered as in the desktop sidebar. "Admin" joins the Account group only when
 * the server-derived `showAdmin` gate is true.
 */
export function moreGroups(showAdmin: boolean): MoreGroup[] {
  return NAV_GROUPS.map((g) => ({
    title: g.title,
    items: [
      ...g.items.filter(([t]) => !BAR_TABS.includes(t)),
      ...(g.title === "Account" && showAdmin ? [ADMIN_ITEM] : []),
    ],
  })).filter((g) => g.items.length > 0);
}

/** Whether `tab` lives in the More sheet (so the More button reads as current). */
export function isMoreTab(tab: Tab): boolean {
  return !BAR_TABS.includes(tab);
}

/** Sum of the badge counts for sections inside More, shown on the More button. */
export function moreBadgeCount(
  badges: Partial<Record<Tab, number>>,
  showAdmin: boolean
): number {
  return moreGroups(showAdmin)
    .flatMap((g) => g.items)
    .reduce((n, [t]) => n + Math.max(0, badges[t] ?? 0), 0);
}
