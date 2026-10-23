"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { prefersReducedMotion } from "@/lib/sound";

// Command Center shell: grouped left sidebar + sticky top bar. Presentational
// only — section state, badges and the admin gate are owned by DashboardClient.

export type Tab =
  | "today"
  | "prizes"
  | "fans"
  | "campaigns"
  | "editor"
  | "inbox"
  | "boosts"
  | "analytics"
  | "settings";

// 24×24 stroke paths (1.7px line icons) from the Command Center prototype.
const ICON: Record<Tab | "admin" | "signout" | "setup", string> = {
  today: "M3 10.6 12 3l9 7.6M5 9.2V21h14V9.2",
  inbox: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  prizes:
    "M20 8v13H4V8M2 4h20v4H2zM12 4v17M12 4S10.5 1 8.3 1.6 6 4 6.5 4.6 9 5 12 4Z",
  editor:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z",
  campaigns:
    "M3 11v2a1 1 0 0 0 1 1h1.5L10 18V6L5.5 10H4a1 1 0 0 0-1 1ZM14 8a5 5 0 0 1 0 8M17.5 5a9 9 0 0 1 0 14",
  fans: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87",
  boosts: "M13 2 4 14h7l-2 8 9-12h-7l2-8Z",
  analytics: "M3 3v18h18M7 16v-5M12 16V8M17 16v-3",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-1.1 2.7H21a2 2 0 1 1 0 4a1.6 1.6 0 0 0-1.6 1Z",
  admin: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9.5 12l2 2 3.5-4",
  signout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  setup: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
};

function Icon({ d, size = 19, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

export const NAV_GROUPS: { title: string; items: [Tab, string][] }[] = [
  { title: "Run", items: [["today", "Today"], ["inbox", "Inbox"], ["prizes", "Fulfilment"]] },
  { title: "Build", items: [["editor", "Wheels"], ["campaigns", "Campaigns"]] },
  { title: "Grow", items: [["fans", "Fans"], ["boosts", "Boosts"]] },
  { title: "Measure", items: [["analytics", "Analytics"]] },
  { title: "Account", items: [["settings", "Settings"]] },
];
const NAV_ORDER: Tab[] = NAV_GROUPS.flatMap((g) => g.items.map(([t]) => t));

export const SECTION_META: Record<Tab, [title: string, subtitle: string]> = {
  today: ["Today", "what moves the needle"],
  inbox: ["Inbox", "Fan conversations — spin-gated, real-time"],
  prizes: ["Fulfilment", "Deliver wins, then mark them done"],
  editor: ["Wheels", "Build prizes, rarity, tickets & stock"],
  campaigns: ["Campaigns", "Compare promotions side by side"],
  fans: ["Fans", "Your audience, links & lifetime value"],
  boosts: ["Boosts", "Happy hours, leaderboard & referrals"],
  analytics: ["Analytics", "What's working, in numbers"],
  settings: ["Settings", "Profile, security & workspace"],
};

function CountBadge({ n }: { n: number }) {
  return (
    <span className="tnum grid h-[19px] min-w-[19px] place-items-center rounded-full bg-[var(--brand)] px-[5px] text-[11px] font-bold text-[var(--brand-ink)]">
      {n}
    </span>
  );
}

const itemBase =
  "relative flex min-h-10 shrink-0 items-center gap-[11px] whitespace-nowrap rounded-[10px] px-2.5 text-left text-[13.5px] transition-colors duration-150";

export function Sidebar({
  active,
  onSelect,
  badges,
  showAdmin,
  accountName,
  accountSub,
  showSignOut,
  footerExtra,
}: {
  active: Tab;
  onSelect: (t: Tab) => void;
  badges: Partial<Record<Tab, number>>;
  /** Server-derived (`profiles.role`) — never client state. */
  showAdmin: boolean;
  accountName: string;
  accountSub: string;
  showSignOut: boolean;
  footerExtra?: ReactNode;
}) {
  const itemRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  // Roving tabindex + Arrow/Home/End (56814f0), kept in nav form: one tab stop
  // for the section list, arrows move between sections (wrapping) and focus
  // follows the selection, exactly as the old tablist did.
  const onKeyDown = (e: React.KeyboardEvent, id: Tab) => {
    const i = NAV_ORDER.indexOf(id);
    let next: Tab | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = NAV_ORDER[(i + 1) % NAV_ORDER.length];
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
      next = NAV_ORDER[(i - 1 + NAV_ORDER.length) % NAV_ORDER.length];
    else if (e.key === "Home") next = NAV_ORDER[0];
    else if (e.key === "End") next = NAV_ORDER[NAV_ORDER.length - 1];
    if (next) {
      e.preventDefault();
      onSelect(next);
      itemRefs.current[next]?.focus();
    }
  };

  // Keep the active item visible: below `lg` the nav is a horizontal scroller,
  // so a section picked from a CTA could otherwise sit clipped off-screen.
  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [active]);

  const initials =
    accountName
      .replace(/^@/, "")
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "FF";

  return (
    <aside
      className="relative z-20 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 border-b border-[#1f1b27] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--brand)_8%,#0c0a0e),#0c0a0e_38%)] px-4 pb-3 pt-4 lg:sticky lg:top-0 lg:flex lg:h-[100dvh] lg:w-[252px] lg:shrink-0 lg:flex-col lg:items-stretch lg:gap-[18px] lg:border-b-0 lg:border-r lg:px-4 lg:py-[22px]"
    >
      {/* Wordmark */}
      <div className="flex min-w-0 items-center gap-2.5 lg:px-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[var(--brand)] text-[var(--brand-ink)] shadow-[0_6px_18px_-6px_color-mix(in_oklab,var(--brand)_70%,transparent)]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ICON.editor} />
          </svg>
        </span>
        <div className="min-w-0 leading-none">
          <p className="font-display text-lg font-bold tracking-[-0.02em] text-ink">FanFunnel</p>
          <p className="mt-[3px] text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            Creator console
          </p>
        </div>
      </div>

      {/* Workspace pill — name + email (or the demo-mode notice). */}
      <div className="surface-raised hidden items-center gap-2.5 rounded-xl p-2.5 lg:flex">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-sm font-bold text-brand">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink">{accountName}</p>
          <p className="mt-px truncate text-[11px] text-muted" title={accountSub}>
            {accountSub}
          </p>
        </div>
      </div>

      <nav
        aria-label="Dashboard sections"
        className="col-span-2 row-start-2 -mx-4 flex gap-1 overflow-x-auto px-4 [-webkit-overflow-scrolling:touch] [overscroll-behavior-x:contain] [scrollbar-width:none] lg:mx-0 lg:flex-1 lg:flex-col lg:gap-3.5 lg:overflow-y-auto lg:overflow-x-visible lg:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {NAV_GROUPS.map((g) => (
          <div key={g.title} className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5">
            <p
              id={`nav-group-${g.title}`}
              className="mb-1 hidden px-2.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#8b8494] lg:block"
            >
              {g.title}
            </p>
            <ul className="flex gap-1 lg:flex-col lg:gap-0.5" aria-labelledby={`nav-group-${g.title}`}>
              {g.items.map(([id, label]) => {
                const on = active === id;
                const badge = badges[id] ?? 0;
                return (
                  <li key={id} className="flex">
                    <button
                      ref={(el) => {
                        itemRefs.current[id] = el;
                      }}
                      type="button"
                      aria-current={on ? "page" : undefined}
                      tabIndex={on ? 0 : -1}
                      onClick={() => onSelect(id)}
                      onKeyDown={(e) => onKeyDown(e, id)}
                      className={`${itemBase} w-full ${
                        on
                          ? "bg-[color-mix(in_oklab,var(--brand)_13%,transparent)] font-semibold text-ink"
                          : "font-medium text-[#b8b2c0] hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] hover:text-ink"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute inset-x-2.5 bottom-0 h-[3px] rounded-t-[3px] lg:inset-x-auto lg:bottom-[9px] lg:left-0 lg:top-[9px] lg:h-auto lg:w-[3px] lg:rounded-none lg:rounded-r-[3px] ${
                          on ? "bg-[var(--brand)]" : "bg-transparent"
                        }`}
                      />
                      <Icon d={ICON[id]} className={on ? "text-brand" : "text-[#8b8494]"} />
                      <span className="flex-1">{label}</span>
                      {badge > 0 && (
                        <>
                          <CountBadge n={badge} />
                          <span className="sr-only">
                            {id === "inbox" ? " unread" : " waiting"}
                          </span>
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
              {g.title === "Account" && showAdmin && (
                <li className="flex">
                  {/* /admin re-checks profiles.role server-side; this only hides the link. */}
                  <a
                    href="/admin"
                    className={`${itemBase} w-full font-medium text-[#b8b2c0] hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] hover:text-ink`}
                  >
                    <Icon d={ICON.admin} className="text-[#8b8494]" />
                    <span className="flex-1">Admin</span>
                  </a>
                </li>
              )}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer: setup-checklist re-open + Sign out (form POST, unchanged). */}
      <div className="col-start-2 row-start-1 flex items-center gap-1 lg:flex-col lg:items-stretch lg:gap-0.5 lg:border-t lg:border-[#1f1b27] lg:pt-3">
        {footerExtra}
        {showSignOut && (
          <form action="/auth/signout" method="post" className="flex">
            <button
              type="submit"
              className="flex min-h-[38px] w-full items-center gap-[11px] rounded-[10px] px-2.5 text-[13px] font-semibold text-muted transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] hover:text-ink"
            >
              <Icon d={ICON.signout} size={18} />
              Sign out
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}

export function SetupChecklistButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show the setup checklist again"
      className="flex min-h-[38px] w-full items-center gap-[11px] rounded-[10px] px-2.5 text-[13px] font-semibold text-brand transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]"
    >
      <Icon d={ICON.setup} size={18} />
      <span className="max-sm:sr-only">Get started</span>
    </button>
  );
}

export function TopBar({
  title,
  subtitle,
  onSearch,
  onNewFanLink,
}: {
  title: string;
  subtitle: ReactNode;
  /** Submitting routes the query to the Fans name filter (client-side only). */
  onSearch: (q: string) => void;
  onNewFanLink: () => void;
}) {
  const [q, setQ] = useState("");
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[#1f1b27] bg-[color-mix(in_oklab,#0c0a0e_86%,transparent)] px-4 py-3 backdrop-blur-md sm:gap-4 sm:px-7 sm:py-[18px]">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-bold tracking-[-0.02em] text-ink sm:text-[22px]">
          {title}
        </h1>
        <p className="mt-[3px] truncate text-[13px] text-muted" suppressHydrationWarning>
          {subtitle}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
        <form
          role="search"
          aria-label="Search fans"
          className="hidden w-[220px] items-center gap-2 rounded-[10px] border border-line bg-surface px-[11px] py-2 focus-within:border-[var(--brand)] md:flex"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(q.trim());
          }}
        >
          <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-3.5-3.5" size={16} className="text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search fans…"
            aria-label="Search fans by name"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted focus-visible:outline-none"
          />
        </form>
        {/* No notifications feed exists yet (behavior-spec #1), so the bell is
            deliberately inert and shows no unread dot. */}
        <button
          type="button"
          aria-label="Notifications (coming soon)"
          aria-disabled="true"
          title="Notifications are coming soon"
          className="grid h-10 w-10 cursor-not-allowed place-items-center rounded-[10px] border border-line bg-surface text-muted"
        >
          <Icon d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" size={18} />
        </button>
        <button
          type="button"
          onClick={onNewFanLink}
          className="btn-brand flex min-h-10 items-center gap-[7px] rounded-[10px] px-3 text-[13.5px] font-bold sm:px-4"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="max-sm:sr-only">New fan link</span>
        </button>
      </div>
    </header>
  );
}
