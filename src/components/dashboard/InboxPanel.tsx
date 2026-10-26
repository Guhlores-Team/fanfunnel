"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSettings, FanThread } from "@/lib/data/types";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { startPoll } from "@/lib/poll";
import { createRealtimeFallback } from "@/lib/realtimeFallback";
import { playPing, prefersReducedMotion } from "@/lib/sound";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { initials } from "./inboxHelpers";

/** A few one-tap canned replies the creator can drop into the composer. */
const QUICK_REPLIES = [
  "Thanks so much! 💖",
  "On its way! 🚀",
  "Spin again for another shot! 🎡",
  "Sorry for the wait — sorting it now.",
] as const;

// 24×24 stroke paths (Command Center prototype line icons).
const P = {
  inbox: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  chevron: "m6 9 6 6 6-6",
  back: "m15 18-6-6 6-6",
};

function Glyph({ d, size = 16, className = "" }: { d: string; size?: number; className?: string }) {
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

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
// Initials sit in ink, not brand: brand-as-text is only legibility-tuned against
// the base surface, and on the 16% tint the default pink is already < 4.5:1.
const avatar =
  "grid shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] font-bold text-ink";

/**
 * The creator's chat inbox: a list of fan threads with unread counts, and a
 * conversation view for the selected fan. When Supabase is configured the
 * creator (authed) subscribes to real Supabase Realtime on the `messages`
 * table; otherwise (demo) it falls back to polling. New inbound fan messages
 * that aren't in the open thread trigger a ping + browser notification — in
 * both the realtime and the demo-poll paths.
 *
 * Below `lg` the list and the conversation are master→detail: tapping a thread
 * replaces the list with the conversation, and its back button returns focus
 * to the thread that was open.
 */
export default function InboxPanel({
  onChanged,
  initialFanId = null,
  initialFanNonce = 0,
}: {
  onChanged?: () => void;
  /** Open this fan's thread once the list has loaded (drawer "Message"). */
  initialFanId?: string | null;
  /** Bumped on every "Message" request so the same fan can be re-opened. */
  initialFanNonce?: number;
}) {
  const toast = useToast();
  const [threads, setThreads] = useState<FanThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [openFan, setOpenFan] = useState<FanThread | null>(null);
  // Keep the open fan id in a ref so the realtime handler reads the latest value
  // without re-subscribing on every selection.
  const openFanIdRef = useRef<string | null>(null);
  useEffect(() => {
    openFanIdRef.current = openFan?.fanId ?? null;
  }, [openFan]);

  // Keep a ref of the latest threads so the realtime handler can name the fan.
  const threadsRef = useRef<FanThread[]>([]);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // Mobile back: the list is hidden while a thread is open, so remember which
  // row to hand focus back to once it's visible again.
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const returnFocusId = useRef<string | null>(null);
  useEffect(() => {
    if (openFan || !returnFocusId.current) return;
    itemRefs.current[returnFocusId.current]?.focus();
    returnFocusId.current = null;
  }, [openFan]);

  // Deep link from the fan drawer: once the list is in, select that fan's
  // thread and bring its row into view. Each request is honoured once (the
  // nonce), so picking another thread afterwards isn't overridden.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (loading || !initialFanId || handledFocus.current === initialFanNonce) return;
    handledFocus.current = initialFanNonce;
    const t = threads.find((x) => x.fanId === initialFanId);
    if (!t) {
      toast("No conversation with this fan yet.", { tone: "info" });
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- select the deep-linked thread once the list is loaded
    setOpenFan(t);
    if (t.unread > 0) {
      setThreads((prev) => prev.map((x) => (x.fanId === t.fanId ? { ...x, unread: 0 } : x)));
    }
    requestAnimationFrame(() => {
      itemRefs.current[t.fanId]?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "nearest",
      });
    });
  }, [loading, threads, initialFanId, initialFanNonce, toast]);

  // Resolves whether the load succeeded so the poll fallback can back off.
  const loadThreads = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/messages/inbox", { cache: "no-store" });
      if (!res.ok) return false;
      setThreads((await res.json()).threads ?? []);
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // Notification permission state (browser only).
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | "unsupported">(
    "default"
  );
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time capability check
      setNotifyPerm("unsupported");
      return;
    }
    setNotifyPerm(Notification.permission);
  }, []);

  // Alert (ping + browser Notification) for a new inbound fan message that the
  // creator isn't currently looking at. Never alerts for the creator's own
  // sends. SSR-guarded.
  const alertInbound = useCallback((fanName: string, body: string) => {
    playPing();
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(`New message from ${fanName}`, {
          body: body.slice(0, 120),
        });
      } catch {
        /* notification construction can throw on some platforms */
      }
    }
  }, []);

  const requestAlerts = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    try {
      const perm = await Notification.requestPermission();
      setNotifyPerm(perm);
      // Confirmation/test notification so it's obvious the grant worked.
      if (perm === "granted") {
        try {
          new Notification("Alerts on", {
            body: "You'll be notified of new messages.",
          });
        } catch {
          /* construction can throw on some platforms */
        }
      }
    } catch {
      /* denied / unavailable */
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial thread-list load
    loadThreads();

    // Real Supabase Realtime for the authed creator (RLS passes on messages).
    if (isSupabaseConfigured()) {
      const supabase = createClient();
      let channelRef: ReturnType<typeof supabase.channel> | null = null;
      let cancelled = false;
      // Polling fallback that runs ONLY if realtime never reaches SUBSCRIBED
      // (or errors out), so a flaky socket still surfaces new threads. Paused on
      // hidden tabs and backed off on errors like every other poll.
      const fallback = createRealtimeFallback(() =>
        startPoll({ intervalMs: 8000, task: loadThreads })
      );

      (async () => {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        const channel = supabase
          .channel(`inbox-${user.id}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `creator_id=eq.${user.id}`,
            },
            (payload) => {
              const row = payload.new as {
                fan_id?: string;
                sender?: string;
                body?: string;
              };
              // Refetch the thread list; the open Thread polls its own messages.
              loadThreads();
              // Only alert for INBOUND fan messages outside the open thread.
              if (
                row.sender === "fan" &&
                row.fan_id !== openFanIdRef.current
              ) {
                const t = threadsRef.current.find((x) => x.fanId === row.fan_id);
                alertInbound(t?.fanName ?? "a fan", row.body ?? "");
              }
            }
          )
          // Lean on the poll fallback whenever the socket isn't healthy, and
          // drop it once realtime is live. Ignored after cleanup.
          .subscribe((status) => fallback.onStatus(status));
        channelRef = channel;
      })();

      return () => {
        cancelled = true;
        fallback.dispose(); // before removeChannel, which fires "CLOSED"
        if (channelRef) supabase.removeChannel(channelRef);
      };
    }

    // Demo fallback: poll the thread list AND synthesize inbound alerts.
    // We diff each poll against the previous snapshot so a genuinely-new
    // inbound fan message (unread went up + latest activity moved) pings —
    // without alerting on the creator's own sends or on the very first load.
    let cancelled = false;
    // fanId -> { lastAt, unread } from the previous poll. Seeded (without
    // alerting) on the first successful poll so existing history is silent.
    const seen = new Map<string, { lastAt: string; unread: number }>();
    let seeded = false;

    const pollDemo = async (): Promise<boolean> => {
      try {
        const res = await fetch("/api/messages/inbox", { cache: "no-store" });
        if (!res.ok) return false;
        const next: FanThread[] = (await res.json()).threads ?? [];
        if (cancelled) return true;
        setThreads(next);

        if (seeded) {
          for (const t of next) {
            const prev = seen.get(t.fanId);
            const isNewInbound = prev
              ? // Existing thread: a new inbound fan message bumps both the
                // unread count and the last-activity timestamp. Requiring the
                // unread increase excludes the creator's own outbound sends.
                t.unread > prev.unread && t.lastAt > prev.lastAt
              : // Brand-new thread that already has an unread fan message.
                t.unread > 0;
            if (isNewInbound && t.fanId !== openFanIdRef.current) {
              alertInbound(t.fanName, t.lastBody);
            }
          }
        }

        // Refresh the snapshot for the next diff.
        seen.clear();
        for (const t of next) seen.set(t.fanId, { lastAt: t.lastAt, unread: t.unread });
        seeded = true;
        return true;
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // This loop is what pings a creator who is on another tab, so it keeps
    // running while hidden (no Realtime socket in demo mode); errors back off.
    const poll = startPoll({
      intervalMs: 8000,
      immediate: true,
      pauseWhenHidden: false,
      refreshOnVisible: false,
      task: pollDemo,
    });
    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [loadThreads, alertInbound]);

  const unreadTotal = threads.reduce((n, t) => n + t.unread, 0);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-stretch gap-2.5">
        <AutoMessagesCard />

        {notifyPerm !== "granted" && notifyPerm !== "unsupported" && (
          <button
            type="button"
            onClick={requestAlerts}
            className="flex min-h-11 items-center gap-[7px] rounded-xl border border-line bg-surface px-4 text-[13px] font-semibold text-ink transition-colors duration-150 hover:border-[var(--brand)]"
          >
            <Glyph d={P.bell} size={15} className="text-brand" />
            Enable alerts
          </button>
        )}
      </div>

      {loading && threads.length === 0 ? (
        <div
          className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]"
          aria-busy="true"
          aria-label="Loading inbox"
        >
          <span className="sr-only">Loading inbox…</span>
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[60px] rounded-xl" />
            ))}
          </div>
          <div className="skeleton hidden min-h-[26rem] rounded-2xl lg:block" />
        </div>
      ) : threads.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-[var(--hair)] px-8 py-14 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-brand">
            <Glyph d={P.inbox} size={22} />
          </span>
          <p className="text-[15px] font-bold text-ink">No conversations yet</p>
          <p className="max-w-[340px] text-[13px] text-muted text-pretty">
            Fans with at least one spin can message you. When a fan spins or replies, the thread
            lands here. Set up an auto-greeting above so every new fan gets a warm welcome.
          </p>
        </div>
      ) : (
        <section aria-labelledby="inbox-conversations" className="flex flex-col gap-3.5">
          <div className={`items-baseline justify-between gap-3 ${openFan ? "hidden lg:flex" : "flex"}`}>
            <h2
              id="inbox-conversations"
              className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink"
            >
              <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
              Conversations
            </h2>
            <span className="tnum text-xs text-muted">
              {threads.length} {threads.length === 1 ? "thread" : "threads"}
              {unreadTotal > 0 && ` · ${unreadTotal} unread`}
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <ul
              aria-label="Conversations"
              className={`flex-col gap-1.5 ${openFan ? "hidden lg:flex" : "flex"}`}
            >
              {threads.map((t) => {
                const on = openFan?.fanId === t.fanId;
                return (
                  <li key={t.fanId} className="lift-in">
                    <button
                      ref={(el) => {
                        itemRefs.current[t.fanId] = el;
                      }}
                      type="button"
                      aria-current={on ? "true" : undefined}
                      onClick={() => {
                        setOpenFan(t);
                        // Optimistically clear the badge the moment the thread is
                        // opened; opening the Thread marks it read server-side and
                        // a reload reconciles the authoritative count.
                        if (t.unread > 0) {
                          setThreads((prev) =>
                            prev.map((x) =>
                              x.fanId === t.fanId ? { ...x, unread: 0 } : x
                            )
                          );
                        }
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl border px-[13px] py-[11px] text-left transition-[border-color,background-color] duration-150 ${
                        on
                          ? "border-[color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color-mix(in_oklab,var(--brand)_10%,transparent)]"
                          : "border-[#1f1b27] bg-[#16131c] hover:border-[color-mix(in_oklab,var(--brand)_35%,var(--hair))]"
                      }`}
                    >
                      <span className={`${avatar} h-9 w-9 text-xs`} aria-hidden="true">
                        {initials(t.fanName)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{t.fanName}</span>
                        <span className="mt-0.5 block truncate text-[12.5px] text-muted">{t.lastBody}</span>
                      </span>
                      {t.unread > 0 && (
                        <>
                          <span className="tnum grid h-[19px] min-w-[19px] shrink-0 place-items-center rounded-full bg-[var(--brand)] px-[5px] text-[11px] font-bold text-[var(--brand-ink)]">
                            {t.unread}
                          </span>
                          <span className="sr-only"> unread</span>
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className={`min-h-[26rem] ${openFan ? "" : "hidden lg:block"}`}>
              {openFan ? (
                <Thread
                  key={openFan.fanId}
                  fan={openFan}
                  onChanged={() => {
                    loadThreads();
                    onChanged?.();
                  }}
                  onBack={() => {
                    returnFocusId.current = openFan.fanId;
                    setOpenFan(null);
                  }}
                />
              ) : (
                <div className={`grid h-full place-items-center rounded-2xl px-6 py-10 text-center ${raised}`}>
                  <div className="flex flex-col items-center gap-2.5">
                    <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-brand">
                      <Glyph d={P.inbox} size={22} />
                    </span>
                    <p className="text-[15px] font-bold text-ink">Select a conversation</p>
                    <p className="max-w-[300px] text-[13px] text-muted text-pretty">
                      Pick a fan on the left to read the thread and reply.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Collapsible card to edit the auto greeting (sent when a fan opens chat) and
 * the out-of-spins nudge (sent when a fan runs dry). Loads from GET
 * /api/chat-settings; saves via PUT.
 */
function AutoMessagesCard() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [intro, setIntro] = useState("");
  const [outro, setOutro] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/chat-settings", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        const s: ChatSettings = d.settings ?? { intro: null, outro: null };
        setIntro(s.intro ?? "");
        setOutro(s.outro ?? "");
      }
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prefill settings on mount
    load();
  }, [load]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/chat-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intro, outro }),
      });
      if (res.ok) toast("Auto-messages saved", { tone: "success" });
      else toast("Couldn't save auto-messages", { tone: "error" });
    } catch {
      toast("Couldn't save auto-messages", { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const well =
    "w-full rounded-[10px] border border-line bg-base px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-[var(--brand)]";

  return (
    <div className={`min-w-0 flex-1 basis-[260px] rounded-xl ${raised}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-left"
        aria-expanded={open}
        aria-controls="auto-messages-form"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Glyph d={P.inbox} className="text-brand" />
          Auto-messages
        </span>
        <span className="flex items-center gap-1.5 text-xs text-[#8b8494]">
          <span className="hidden sm:inline">Greeting &amp; out-of-spins</span>
          <Glyph
            d={P.chevron}
            size={14}
            className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div id="auto-messages-form" className="flex flex-col gap-4 border-t border-[#1f1b27] px-4 pb-4 pt-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
              Greeting — auto-sends when a fan opens chat
            </span>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Leave empty to disable"
              className={well}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
              Out-of-spins — auto-sends when a fan runs dry
            </span>
            <textarea
              value={outro}
              onChange={(e) => setOutro(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Leave empty to disable"
              className={well}
            />
          </label>
          <div>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="btn-brand min-h-9 rounded-[9px] px-4 text-[13px] font-bold"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A locally-tracked optimistic outbound message awaiting / failing its send. */
interface PendingMessage {
  localId: string;
  body: string;
  status: "pending" | "failed";
}

function Thread({
  fan,
  onChanged,
  onBack,
}: {
  fan: FanThread;
  onChanged: () => void;
  /** Mobile master→detail: return to the thread list. */
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Hold onChanged in a ref so `load`'s identity doesn't change when the parent
  // passes a fresh inline callback each render — otherwise the poll effect below
  // ([load]) tears down and re-fires load() on every parent re-render, and since
  // load() calls onChanged() → parent setState → re-render, it becomes a runaway
  // request loop the moment a conversation is opened.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });
  // Ignore a stale response: if a newer load has started, don't let this older
  // one overwrite messages (e.g. an in-flight poll clobbering a just-sent message).
  const reqId = useRef(0);

  // Resolves false on a failed request so the poll can back off.
  const load = useCallback(async (): Promise<boolean> => {
    const id = ++reqId.current;
    try {
      const res = await fetch(`/api/messages/thread/${fan.fanId}`, { cache: "no-store" });
      if (!res.ok) return false;
      const list = (await res.json()).messages ?? [];
      if (id !== reqId.current) return true;
      setMessages(list);
      onChangedRef.current();
      return true;
    } catch {
      return false;
    }
  }, [fan.fanId]);

  // Load the selected fan's thread, then poll it (paused on hidden tabs,
  // refreshed on return, backed off on errors).
  useEffect(() => {
    const poll = startPoll({ intervalMs: 6000, immediate: true, task: load });
    return () => poll.stop();
  }, [load]);

  // Below `lg` the list is hidden once a thread opens, so the focused row is
  // gone; hand focus to the conversation heading instead of letting it drop.
  useEffect(() => {
    if (window.matchMedia?.("(max-width: 1023px)").matches) headingRef.current?.focus();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [messages.length, pending.length]);

  // Core send: append an optimistic message, POST, then reconcile. On failure
  // the optimistic bubble flips to "failed" with a retry affordance.
  const deliver = useCallback(
    async (body: string, localId: string) => {
      try {
        const res = await fetch("/api/messages/creator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fanId: fan.fanId, body }),
        });
        if (res.ok) {
          // Reload the canonical thread, then drop the optimistic copy so we
          // don't double-render the now-persisted message.
          await load();
          setPending((p) => p.filter((m) => m.localId !== localId));
          return true;
        }
      } catch {
        /* fall through to failed */
      }
      setPending((p) =>
        p.map((m) => (m.localId === localId ? { ...m, status: "failed" } : m))
      );
      return false;
    },
    [fan.fanId, load]
  );

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    const localId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setPending((p) => [...p, { localId, body, status: "pending" }]);
    setDraft("");
    try {
      await deliver(body, localId);
    } finally {
      setSending(false);
    }
  };

  const retry = async (m: PendingMessage) => {
    setPending((p) =>
      p.map((x) => (x.localId === m.localId ? { ...x, status: "pending" } : x))
    );
    await deliver(m.body, m.localId);
  };

  const insertQuickReply = (text: string) => {
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
  };

  const newest = messages[messages.length - 1]?.at ?? fan.lastAt;
  const own = "max-w-[78%] rounded-2xl bg-[var(--brand)] px-[13px] py-[9px] text-[13.5px] text-[var(--brand-ink)]";

  return (
    <div className={`lift-in flex h-full flex-col rounded-2xl ${raised}`}>
      <div className="flex items-center gap-2.5 border-b border-[#1f1b27] px-3.5 py-3 sm:px-[18px] sm:py-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-line text-muted transition-colors hover:text-ink lg:hidden"
        >
          <Glyph d={P.back} size={18} />
        </button>
        <span className={`${avatar} h-9 w-9 text-xs`} aria-hidden="true">
          {initials(fan.fanName)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold text-ink outline-none">
            {fan.fanName}
          </h3>
          <p className="tnum mt-0.5 truncate text-xs text-muted">
            {messages.length} {messages.length === 1 ? "message" : "messages"} · {timeAgo(newest)}
          </p>
        </div>
      </div>
      <div
        role="log"
        aria-live="polite"
        aria-label={`Conversation with ${fan.fanName}`}
        className="flex flex-1 flex-col gap-2 overflow-y-auto p-3.5 sm:p-[18px]"
      >
        {messages.map((m) => (
          <div key={m.id} className={m.sender === "creator" ? "flex justify-end" : "flex justify-start"}>
            <span
              className={
                m.sender === "creator"
                  ? own
                  : "max-w-[78%] rounded-2xl bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] px-[13px] py-[9px] text-[13.5px] text-ink"
              }
            >
              {m.body}
            </span>
          </div>
        ))}
        {/* Optimistic outbound bubbles (pending / failed) render after the
            persisted history, always right-aligned (creator side). */}
        {pending.map((m) => (
          <div key={m.localId} className="flex flex-col items-end">
            <span className={`${own} ${m.status === "failed" ? "opacity-55" : "opacity-70"}`}>{m.body}</span>
            {m.status === "pending" ? (
              <span className="mt-0.5 text-[11px] text-muted">Sending…</span>
            ) : (
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#f87171]">
                Failed
                <button
                  type="button"
                  onClick={() => retry(m)}
                  className="font-semibold underline underline-offset-2 hover:no-underline"
                >
                  Retry
                </button>
              </span>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {/* Quick replies: one-tap canned messages inserted into the composer. */}
      <div
        role="group"
        aria-label="Quick replies"
        className="flex flex-wrap gap-1.5 border-t border-[#1f1b27] px-3 pt-2.5"
      >
        {QUICK_REPLIES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => insertQuickReply(q)}
            className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition-colors duration-150 hover:border-[var(--brand)] hover:text-ink"
          >
            {q}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 p-3 pt-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          maxLength={2000}
          aria-label="Reply to this fan"
          placeholder="Reply…"
          className="min-w-0 flex-1 rounded-full border border-line bg-base px-4 py-2.5 text-sm text-ink outline-none transition-colors focus:border-[var(--brand)]"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !draft.trim()}
          className="btn-brand min-h-10 rounded-full px-[18px] text-[13.5px] font-bold disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
