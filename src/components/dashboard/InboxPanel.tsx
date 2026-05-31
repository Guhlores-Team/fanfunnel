"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSettings, FanThread } from "@/lib/data/types";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { playPing } from "@/lib/sound";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "./ui";

/**
 * The creator's chat inbox: a list of fan threads with unread counts, and a
 * conversation view for the selected fan. When Supabase is configured the
 * creator (authed) subscribes to real Supabase Realtime on the `messages`
 * table; otherwise (demo) it falls back to polling. New inbound fan messages
 * that aren't in the open thread trigger a ping + browser notification.
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

  const requestAlerts = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    try {
      const perm = await Notification.requestPermission();
      setNotifyPerm(perm);
    } catch {
      /* denied / unavailable */
    }
  };

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

  useEffect(() => {
    loadThreads();

    // Real Supabase Realtime for the authed creator (RLS passes on messages).
    if (isSupabaseConfigured()) {
      const supabase = createClient();
      let channelRef: ReturnType<typeof supabase.channel> | null = null;
      let cancelled = false;

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
          .subscribe();
        channelRef = channel;
      })();

      return () => {
        cancelled = true;
        if (channelRef) supabase.removeChannel(channelRef);
      };
    }

    // Demo fallback: poll the thread list.
    const id = setInterval(loadThreads, 8000);
    return () => clearInterval(id);
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

function Thread({ fan, onChanged }: { fan: FanThread; onChanged: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages/thread/${fan.fanId}`, { cache: "no-store" });
      if (res.ok) {
        setMessages((await res.json()).messages ?? []);
        onChanged();
      }
    } catch {
      /* transient */
    }
  }, [fan.fanId, onChanged]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load thread for the selected fan, then poll
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/messages/creator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fanId: fan.fanId, body }),
      });
      if (res.ok) {
        setDraft("");
        await load();
      }
    } finally {
      setSending(false);
    }
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
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          maxLength={2000}
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
