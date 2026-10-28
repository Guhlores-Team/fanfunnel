"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFetch } from "@/lib/hooks/useFetch";
import { timeAgo } from "@/lib/format";
import type {
  NotificationFeed,
  NotificationItem,
  NotificationKind,
  NotificationTarget,
} from "@/lib/data/notificationFeed";

// Top-bar notification bell (RD-7 / behavior spec #1). The feed and the unread
// count come from GET /api/notifications (derived server-side, scoped to the
// signed-in creator); opening the panel marks everything seen server-side
// (POST /api/notifications/seen). Polled with the shared useFetch/startPoll
// scheduler, which pauses while the tab is hidden and backs off on errors.

const POLL_MS = 20_000;

const BELL = "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0";
const KIND_ICON: Record<NotificationKind, string> = {
  win: "M20 8v13H4V8M2 4h20v4H2zM12 4v17M12 4S10.5 1 8.3 1.6 6 4 6.5 4.6 9 5 12 4Z",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  low_stock: "M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8",
  out_of_spins: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v4M12 16h.01",
  fan_deleted: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 8l5 5M22 8l-5 5",
};
const KIND_LABEL: Record<NotificationKind, string> = {
  win: "Win to fulfil",
  message: "Message",
  low_stock: "Prize stock",
  out_of_spins: "Fan balance",
  fan_deleted: "Fan privacy",
};

function Glyph({ d, size = 18 }: { d: string; size?: number }) {
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
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

function isFeed(raw: unknown): NotificationFeed {
  const f = raw as NotificationFeed;
  if (!f || !Array.isArray(f.items) || typeof f.unread !== "number") {
    throw new Error("Unexpected notifications payload");
  }
  return f;
}

const allRead = (f: NotificationFeed): NotificationFeed => ({
  ...f,
  unread: 0,
  items: f.items.map((i) => ({ ...i, unread: false })),
});

export default function NotificationBell({
  onNavigate,
  onOpenPushSettings,
}: {
  /** Route an item through the dashboard's in-app navigation. */
  onNavigate: (target: NotificationTarget) => void;
  /** Footer: Settings › Notifications › push (web push opt-in). */
  onOpenPushSettings?: () => void;
}) {
  const feed = useFetch<NotificationFeed>("/api/notifications", {
    pollMs: POLL_MS,
    select: isFeed,
  });
  const [open, setOpen] = useState(false);
  // Items that were unread when the panel opened keep a "New" marker while it
  // stays open, even though the server has already marked them seen.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();

  const unread = open ? 0 : (feed.data?.unread ?? 0);
  const badge = unread > 9 ? "9+" : String(unread);

  // Blur and an outside pointer can both fire for one dismissal; close once.
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const close = (refocus: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    setFresh(new Set());
    // A poll that left before the seen-mark could have restored a stale count.
    void feed.reload();
    if (refocus) buttonRef.current?.focus();
  };

  async function openPanel() {
    openRef.current = true;
    setOpen(true);
    // Pull anything newer than the last poll so nothing is marked seen unshown.
    let latest = feed.data;
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.ok) latest = isFeed(await res.json());
    } catch {
      /* keep the last good feed */
    }
    if (!latest) return;
    setFresh(new Set(latest.items.filter((i) => i.unread).map((i) => i.id)));
    feed.setData(allRead(latest));
    if (latest.unread > 0) {
      void fetch("/api/notifications/seen", { method: "POST" }).catch(() => {});
    }
  }

  // Light dismiss: Escape (focus back to the bell) or a pointer outside.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
    // close() only touches stable setters/refs and the stable reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const go = (item: NotificationItem) => {
    openRef.current = false;
    setOpen(false);
    setFresh(new Set());
    onNavigate(item.target);
  };

  const items = feed.data?.items ?? [];

  return (
    <div
      ref={wrapRef}
      className="sm:relative"
      onBlur={(e) => {
        // Tabbing out of the bell + panel closes it (non-modal popover).
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        data-testid="notification-bell"
        onClick={() => (open ? close(false) : void openPanel())}
        className={`relative grid h-10 w-10 place-items-center rounded-[10px] border bg-surface transition-colors duration-150 hover:text-ink ${
          open ? "border-[var(--brand)] text-ink" : "border-line text-muted"
        }`}
      >
        <Glyph d={BELL} />
        {unread > 0 && (
          <span
            aria-hidden="true"
            data-testid="notification-count"
            className="tnum absolute -right-1.5 -top-1.5 grid h-[19px] min-w-[19px] place-items-center rounded-full bg-[var(--brand)] px-[5px] text-[11px] font-bold text-[var(--brand-ink)] ring-2 ring-[#0c0a0e]"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          className="absolute inset-x-4 top-full z-30 mt-2 flex max-h-[min(70dvh,520px)] flex-col overflow-hidden rounded-2xl border border-[var(--hair)] shadow-[0_24px_60px_-20px_rgba(0,0,0,.9)] [background:var(--s1)] focus:outline-none sm:inset-x-auto sm:right-0 sm:w-[380px]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[var(--hair)] px-4 py-3">
            <h2 id={headingId} className="text-[14px] font-bold text-ink">
              Notifications
            </h2>
            {fresh.size > 0 && (
              <span className="tnum text-[12px] text-muted">{fresh.size} new</span>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted">
              {feed.loading
                ? "Loading…"
                : feed.error && !feed.data
                  ? "Couldn’t load notifications. We’ll keep trying."
                  : "You’re all caught up."}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Recent notifications">
              {items.map((item) => {
                const isNew = fresh.has(item.id);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => go(item)}
                      className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
                    >
                      <span
                        className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[9px] ${
                          item.kind === "low_stock"
                            ? "bg-[color-mix(in_oklab,#f59e0b_16%,transparent)] text-[#fcd34d]"
                            : "bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-ink"
                        }`}
                      >
                        <Glyph d={KIND_ICON[item.kind]} size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="sr-only">
                          {isNew ? "New. " : ""}
                          {KIND_LABEL[item.kind]}:{" "}
                        </span>
                        <span className="block break-words text-[13px] font-semibold leading-snug text-ink">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block break-words text-[12px] leading-snug text-muted">
                          {item.body}
                        </span>
                        <span className="mt-1 block text-[11px] text-muted">{timeAgo(item.at)}</span>
                      </span>
                      {isNew && (
                        <span
                          aria-hidden="true"
                          className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {onOpenPushSettings && (
            <div className="border-t border-[var(--hair)] px-4 py-2.5">
              <button
                type="button"
                data-testid="bell-push-link"
                onClick={() => {
                  openRef.current = false;
                  setOpen(false);
                  setFresh(new Set());
                  onOpenPushSettings();
                }}
                className="min-h-10 text-[13px] font-semibold text-brand underline-offset-2 hover:underline"
              >
                Get these on your phone <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
