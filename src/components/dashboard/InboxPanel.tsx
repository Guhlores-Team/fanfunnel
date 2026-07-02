"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSettings, FanThread } from "@/lib/data/types";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { playPing } from "@/lib/sound";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "./ui";

/** A few one-tap canned replies the creator can drop into the composer. */
const QUICK_REPLIES = [
  "Thanks so much! 💖",
  "On its way! 🚀",
  "Spin again for another shot! 🎡",
  "Sorry for the wait — sorting it now.",
] as const;

/**
 * The creator's chat inbox: a list of fan threads with unread counts, and a
 * conversation view for the selected fan. When Supabase is configured the
 * creator (authed) subscribes to real Supabase Realtime on the `messages`
 * table; otherwise (demo) it falls back to polling. New inbound fan messages
 * that aren't in the open thread trigger a ping + browser notification — in
 * both the realtime and the demo-poll paths.
 */
export default function InboxPanel({ onChanged }: { onChanged?: () => void }) {
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

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/messages/inbox", { cache: "no-store" });
      if (res.ok) setThreads((await res.json()).threads ?? []);
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
    loadThreads();

    // Real Supabase Realtime for the authed creator (RLS passes on messages).
    if (isSupabaseConfigured()) {
      const supabase = createClient();
      let channelRef: ReturnType<typeof supabase.channel> | null = null;
      let cancelled = false;
      // Polling fallback that runs ONLY if realtime never reaches SUBSCRIBED
      // (or errors out), so a flaky socket still surfaces new threads.
      let pollId: ReturnType<typeof setInterval> | null = null;
      const startPoll = () => {
        if (pollId === null) pollId = setInterval(loadThreads, 8000);
      };
      const stopPoll = () => {
        if (pollId !== null) {
          clearInterval(pollId);
          pollId = null;
        }
      };

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
          .subscribe((status) => {
            // Keep the subscription robust: lean on the poll fallback whenever
            // the socket isn't healthy, and drop it once realtime is live.
            if (status === "SUBSCRIBED") stopPoll();
            else if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            )
              startPoll();
          });
        channelRef = channel;
      })();

      return () => {
        cancelled = true;
        stopPoll();
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

    const pollDemo = async () => {
      try {
        const res = await fetch("/api/messages/inbox", { cache: "no-store" });
        if (!res.ok) return;
        const next: FanThread[] = (await res.json()).threads ?? [];
        if (cancelled) return;
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
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    pollDemo();
    const id = setInterval(pollDemo, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loadThreads, alertInbound]);

  return (
    <div className="space-y-4">
      <AutoMessagesCard />

      {notifyPerm !== "granted" && notifyPerm !== "unsupported" && (
        <button
          onClick={requestAlerts}
          className="rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
        >
          🔔 Enable alerts
        </button>
      )}

      {loading && threads.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">Loading inbox…</p>
      ) : threads.length === 0 ? (
        <EmptyState
          title="No messages yet"
          body="Fans with at least one spin can message you. Replies show up here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-[18rem_1fr]">
          <ul className="space-y-1.5">
            {threads.map((t) => (
              <li key={t.fanId}>
                <button
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
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                    openFan?.fanId === t.fanId
                      ? "border-[var(--brand)] bg-[color-mix(in_oklab,var(--brand)_10%,transparent)]"
                      : "border-line hover:border-[var(--brand)]/50"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{t.fanName}</p>
                    <p className="truncate text-xs text-muted">{t.lastBody}</p>
                  </div>
                  {t.unread > 0 && (
                    <span className="tnum grid h-5 min-w-5 place-items-center rounded-full bg-[var(--brand)] px-1 text-[11px] font-bold text-white">
                      {t.unread}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div className="min-h-[20rem]">
            {openFan ? (
              <Thread
                key={openFan.fanId}
                fan={openFan}
                onChanged={() => {
                  loadThreads();
                  onChanged?.();
                }}
              />
            ) : (
              <div className="grid h-full place-items-center rounded-xl border border-line text-sm text-muted">
                Select a conversation
              </div>
            )}
          </div>
        </div>
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

  return (
    <div className="card rounded-xl p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold text-ink">Auto-messages</span>
        <span className="text-muted">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              Greeting — auto-sends when a fan opens chat
            </label>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Leave empty to disable"
              className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-ink outline-none focus:border-[var(--brand)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">
              Out-of-spins — auto-sends when a fan runs dry
            </label>
            <textarea
              value={outro}
              onChange={(e) => setOutro(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Leave empty to disable"
              className="w-full rounded-xl border border-line bg-base px-3 py-2 text-sm text-ink outline-none focus:border-[var(--brand)]"
            />
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="btn-brand rounded-full px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
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

function Thread({ fan, onChanged }: { fan: FanThread; onChanged: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const res = await fetch(`/api/messages/thread/${fan.fanId}`, { cache: "no-store" });
      if (res.ok) {
        const list = (await res.json()).messages ?? [];
        if (id !== reqId.current) return;
        setMessages(list);
        onChangedRef.current();
      }
    } catch {
      /* transient */
    }
  }, [fan.fanId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load thread for the selected fan, then poll
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
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

  return (
    <div className="flex h-full flex-col rounded-xl border border-line">
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-sm font-semibold text-ink">{fan.fanName}</p>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.map((m) => (
          <div key={m.id} className={m.sender === "creator" ? "flex justify-end" : "flex justify-start"}>
            <span
              className="max-w-[80%] rounded-2xl px-3 py-2 text-sm"
              style={
                m.sender === "creator"
                  ? { background: "var(--brand)", color: "#fff" }
                  : { background: "color-mix(in oklab, var(--color-ink) 8%, transparent)", color: "var(--color-ink)" }
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
            <span
              className="max-w-[80%] rounded-2xl px-3 py-2 text-sm"
              style={{
                background: "var(--brand)",
                color: "#fff",
                opacity: m.status === "failed" ? 0.55 : 0.7,
              }}
            >
              {m.body}
            </span>
            {m.status === "pending" ? (
              <span className="mt-0.5 text-[11px] text-muted">Sending…</span>
            ) : (
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#ef4444]">
                Failed
                <button
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
      <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-2.5">
        {QUICK_REPLIES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => insertQuickReply(q)}
            className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition hover:border-[var(--brand)] hover:text-ink"
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
          className="flex-1 rounded-full border border-line bg-base px-4 py-2 text-sm text-ink outline-none focus:border-[var(--brand)]"
        />
        <button
          onClick={send}
          disabled={sending || !draft.trim()}
          className="btn-brand rounded-full px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
