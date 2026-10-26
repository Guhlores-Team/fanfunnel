"use client";

import { useState } from "react";
import { CountBadge, ICON, Icon, NAV_GROUPS, SECTION_META, type Tab } from "@/components/dashboard/DashboardShell";
import MoreSheet, { type MoreSheetProps } from "@/components/dashboard/MoreSheet";
import { BAR_TABS, isMoreTab, moreBadgeCount } from "@/components/dashboard/mobileNav";

const LABEL = Object.fromEntries(NAV_GROUPS.flatMap((g) => g.items)) as Record<Tab, string>;
const MORE_ICON = "M4 6h16M4 12h16M4 18h16";

const itemBase =
  "relative flex min-h-12 w-full flex-col items-center justify-center gap-[3px] rounded-[10px] px-1 text-[11px] font-semibold leading-none transition-colors duration-150";

/**
 * Phone navigation (below `lg`, RD-6 / P9): a fixed bottom tab bar with the
 * design's Today / Inbox / Wheels / Fans + "More", replacing the sidebar. It is
 * the "Dashboard sections" nav at this width (the sidebar's nav is not rendered
 * visibly), so the current section carries aria-current="page" — here, or in
 * the More sheet for sections that live there.
 */
export default function MobileTabBar({
  active,
  onSelect,
  badges,
  showAdmin,
  ...sheet
}: Omit<MoreSheetProps, "onClose">) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBadge = moreBadgeCount(badges, showAdmin);
  const moreCurrent = isMoreTab(active);

  // A bar tap can come from anywhere down a long page: open the new section at
  // its top, not at the old section's scroll offset.
  const go = (t: Tab) => {
    onSelect(t);
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <nav
        aria-label="Dashboard sections"
        data-ff-tabbar=""
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[#1f1b27] bg-[rgba(16,13,22,.92)] pb-[env(safe-area-inset-bottom)] backdrop-blur-[12px] lg:hidden"
      >
        {/* Height is mirrored by --ff-tabbar-h in globals.css (60px). */}
        <ul className="mx-auto flex h-[60px] max-w-[560px] items-center gap-1 px-1.5">
          {BAR_TABS.map((id) => {
            const on = active === id;
            const badge = badges[id] ?? 0;
            return (
              <li key={id} className="flex min-w-0 flex-1">
                <button
                  type="button"
                  aria-current={on ? "page" : undefined}
                  onClick={() => go(id)}
                  className={`${itemBase} ${on ? "text-brand" : "text-[#8b8494] hover:text-ink"}`}
                >
                  <span className="relative">
                    <Icon d={ICON[id]} size={22} />
                    {badge > 0 && (
                      <span className="absolute -right-3 -top-2">
                        <CountBadge n={badge} />
                      </span>
                    )}
                  </span>
                  <span className="max-w-full truncate">{LABEL[id]}</span>
                  {badge > 0 && <span className="sr-only">{id === "inbox" ? " unread" : " waiting"}</span>}
                </button>
              </li>
            );
          })}
          <li className="flex min-w-0 flex-1">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              className={`${itemBase} ${moreCurrent ? "text-brand" : "text-[#8b8494] hover:text-ink"}`}
            >
              <span className="relative">
                <Icon d={MORE_ICON} size={22} />
                {moreBadge > 0 && (
                  <span className="absolute -right-3 -top-2">
                    <CountBadge n={moreBadge} />
                  </span>
                )}
              </span>
              <span>More</span>
              {moreBadge > 0 && <span className="sr-only"> {moreBadge} waiting</span>}
              {moreCurrent && <span className="sr-only">, current section: {SECTION_META[active][0]}</span>}
            </button>
          </li>
        </ul>
      </nav>
      {moreOpen && (
        <MoreSheet
          {...sheet}
          active={active}
          onSelect={go}
          badges={badges}
          showAdmin={showAdmin}
          onClose={() => setMoreOpen(false)}
        />
      )}
    </>
  );
}
