"use client";

import { useId, useRef } from "react";
import type { FormEvent } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useSheetDrag } from "@/lib/hooks/useSheetDrag";
import { CloseButton } from "@/components/dashboard/ui";
import { CountBadge, ICON, Icon, type Tab } from "@/components/dashboard/DashboardShell";
import { moreGroups } from "@/components/dashboard/mobileNav";

export interface MoreSheetProps {
  onClose: () => void;
  active: Tab;
  onSelect: (t: Tab) => void;
  badges: Partial<Record<Tab, number>>;
  /** Server-derived (`is_admin()` via checkAdmin) — never client state. */
  showAdmin: boolean;
  accountName: string;
  accountSub: string;
  initials: string;
  showSignOut: boolean;
  /** May preventDefault() to ask first (unsaved wheel edits). */
  onSignOut?: (e: FormEvent<HTMLFormElement>) => void;
  /** Re-open the setup checklist ("Get started"); omitted when it isn't offered. */
  onSetup?: () => void;
}

const rowBase =
  "flex min-h-12 w-full items-center gap-3 rounded-[12px] px-3 text-left text-[15px] transition-colors duration-150";

/**
 * Phone "More" sheet (RD-6 / P9): every section that isn't on the bottom tab
 * bar, plus Get started and Sign out from the desktop sidebar footer. A modal
 * bottom sheet: focus-trapped, Esc/Close/backdrop/drag-down to dismiss, focus
 * returns to the More button.
 */
export default function MoreSheet({
  onClose,
  active,
  onSelect,
  badges,
  showAdmin,
  accountName,
  accountSub,
  initials,
  showSignOut,
  onSignOut,
  onSetup,
}: MoreSheetProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useFocusTrap<HTMLDivElement>({
    active: true,
    onEscape: onClose,
    initialFocus: closeRef,
  });
  const drag = useSheetDrag(panelRef, onClose);

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="fade-in absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="drawer-in absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-y-auto overscroll-contain rounded-t-[28px] border-t border-[#2a2533] bg-[#15121b] pb-[calc(env(safe-area-inset-bottom)+12px)] shadow-[0_-30px_60px_-20px_rgba(0,0,0,.7)]"
      >
        {/* Grabber: drag down to dismiss (pointer only; Esc / Close for keys). */}
        <div
          {...drag}
          aria-hidden="true"
          className="flex shrink-0 cursor-grab touch-none justify-center pb-1.5 pt-2.5"
        >
          <span className="h-[5px] w-[42px] rounded-full bg-[#3a3442]" />
        </div>

        <div className="flex items-center gap-3 px-5 pb-3">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-sm font-bold text-ink"
          >
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[17px] font-bold tracking-[-0.01em] text-ink">
              More
            </h2>
            <p className="truncate text-xs text-muted" title={accountSub}>
              {accountName} · {accountSub}
            </p>
          </div>
          <CloseButton ref={closeRef} onClick={onClose} />
        </div>

        <nav aria-label="More sections" className="flex flex-col gap-3 border-t border-[#1f1b27] px-3 pt-3">
          {moreGroups(showAdmin).map((g) => (
            <div key={g.title}>
              <p
                id={`more-group-${g.title}`}
                className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[#8b8494]"
              >
                {g.title}
              </p>
              <ul aria-labelledby={`more-group-${g.title}`} className="flex flex-col gap-0.5">
                {g.items.map(([id, label]) => {
                  const on = active === id;
                  const badge = badges[id] ?? 0;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-current={on ? "page" : undefined}
                        onClick={() => {
                          onSelect(id);
                          onClose();
                        }}
                        className={`${rowBase} ${
                          on
                            ? "bg-[color-mix(in_oklab,var(--brand)_13%,transparent)] font-semibold text-ink"
                            : "font-medium text-[#d4cfdb] hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
                        }`}
                      >
                        <Icon d={ICON[id]} size={20} className={on ? "text-brand" : "text-[#8b8494]"} />
                        <span className="flex-1">{label}</span>
                        {badge > 0 && (
                          <>
                            <CountBadge n={badge} />
                            <span className="sr-only">{id === "inbox" ? " unread" : " waiting"}</span>
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {(onSetup || showSignOut) && (
          <div className="mt-3 flex flex-col gap-0.5 border-t border-[#1f1b27] px-3 pt-3">
            {onSetup && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onSetup();
                }}
                className={`${rowBase} font-semibold text-brand hover:bg-[color-mix(in_oklab,var(--brand)_12%,transparent)]`}
              >
                <Icon d={ICON.setup} size={20} />
                Get started
              </button>
            )}
            {showSignOut && (
              <form
                action="/auth/signout"
                method="post"
                onSubmit={(e) => {
                  onSignOut?.(e);
                  // Asking first (unsaved wheel edits): get out of the way of the dialog.
                  if (e.defaultPrevented) onClose();
                }}
              >
                <button
                  type="submit"
                  className={`${rowBase} font-semibold text-muted hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] hover:text-ink`}
                >
                  <Icon d={ICON.signout} size={20} />
                  Sign out
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
