"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/data/types";

/** A locally-tracked optimistic outbound message awaiting / failing its send. */
interface PendingMessage {
  localId: string;
  body: string;
  status: "pending" | "failed";
}

/**
 * Spin-gated DM thread with the creator. Fans with ≥1 spin (chatUnlocked) can
 * message; otherwise they see a top-up nudge. Polls every 3s while open, and
 * every 12s while closed so a creator reply surfaces an unread dot on the 💬
 * button. Fans aren't authed, so this stays HTTP polling (no realtime).
 */
export default function ChatPanel({
  token,
  unlocked,
  creatorTitle,
}: {
  token: string;
  unlocked: boolean;
  creatorTitle: string;
}) {
  const [open, setOpenState] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Remember whether the fan had the chat open, per token, so a refresh doesn't
  // collapse the conversation (it stays visible like the creator's inbox does).
  const openKey = `ff_chat_open_${token}`;
  const setOpen = useCallback(
    (next: boolean | ((o: boolean) => boolean)) => {
      setOpenState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        try {
          window.localStorage.setItem(openKey, value ? "1" : "0");
        } catch {
          /* storage unavailable */
        }
        return value;
      });
    },
    [openKey]
  );
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore persisted open state on mount
      if (window.localStorage.getItem(openKey) === "1") setOpenState(true);
    } catch {
      /* ignore */
    }
  }, [openKey]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [hasUnread, setHasUnread] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // Guard so the auto-intro is only requested once per mount.
  const introRequested = useRef(false);

  // "Last seen" creator-message timestamp, persisted per token so the unread
  // dot survives reloads. Read lazily (client-only) to stay SSR-safe.
  const seenKey = `ff_chat_seen_${token}`;
  const readSeen = useCallback((): string => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(seenKey) ?? "";
    } catch {
      return "";
    }
  }, [seenKey]);
  const writeSeen = useCallback(
    (at: string) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(seenKey, at);
      } catch {
        /* storage unavailable */
      }
    },
    [seenKey]
  );

  // Latest creator-message timestamp in a list (or "" when none).
  const latestCreatorAt = (list: ChatMessage[]): string => {
    let latest = "";
    for (const m of list) {
      if (m.sender === "creator" && m.at > latest) latest = m.at;
    }
    return latest;
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages/fan?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const d = await res.json();
        const list: ChatMessage[] = d.messages ?? [];
        setMessages(list);
        // While the panel is open the fan is "seeing" everything; mark read.
        const latest = latestCreatorAt(list);
        if (latest) writeSeen(latest);
        setHasUnread(false);
      }
    } catch {
      /* transient */
    }
  }, [token, writeSeen]);

  // Lightweight closed-panel poll: just detect whether a creator message newer
  // than the fan's last view exists, and toggle the unread dot.
  const checkUnread = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages/fan?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const d = await res.json();
      const list: ChatMessage[] = d.messages ?? [];
      const latest = latestCreatorAt(list);
      setHasUnread(latest !== "" && latest > readSeen());
    } catch {
      /* transient */
    }
  }, [token, readSeen]);

  // When the panel OPENS and is unlocked: request the auto-intro once (so the
  // greeting is waiting), then load + poll fast (3s).
  useEffect(() => {
    if (!open || !unlocked) return;
    let live = true;
    const run = async () => {
      if (!introRequested.current) {
        introRequested.current = true;
        try {
          await fetch("/api/messages/auto-intro", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });
        } catch {
          /* best-effort */
        }
      }
      if (live) await load();
      // One quick retry shortly after open: if the first load raced the
      // auto-intro insert (or hit a transient error), history still appears
      // immediately instead of waiting for the next poll tick.
      setTimeout(() => {
        if (live) void load();
      }, 800);
    };
    run();
    const id = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [open, unlocked, load, token]);

  // While the panel is CLOSED (and unlocked): poll slowly (12s) for unread.
  useEffect(() => {
    if (open || !unlocked) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- poll for unread, then poll
    checkUnread();
    const id = setInterval(checkUnread, 12000);
    return () => clearInterval(id);
  }, [open, unlocked, checkUnread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending.length]);

  // Core send: append an optimistic message, POST, then reconcile. On failure
  // the optimistic bubble flips to "failed" with a retry affordance.
  const deliver = useCallback(
    async (body: string, localId: string) => {
      try {
        const res = await fetch("/api/messages/fan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, body }),
        });
        if (res.ok) {
          // Reload the canonical thread, then drop the optimistic copy so the
          // now-persisted message isn't rendered twice.
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
    [token, load]
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

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-12 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink shadow-lg transition hover:border-[var(--brand)]"
        aria-label="Message creator"
      >
        💬 Message
        {hasUnread && !open && (
          <span
            aria-label="New message"
            className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full border-2 border-surface"
            style={{ background: "var(--brand)" }}
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Chat with ${creatorTitle}`}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[80vh] w-full max-w-md flex-col rounded-t-3xl border border-line bg-surface p-4 shadow-2xl sm:bottom-4 sm:right-4 sm:left-auto sm:mx-0 sm:max-h-[28rem] sm:rounded-3xl"
          style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-bold text-ink">{creatorTitle}</p>
            <button
              onClick={() => setOpen(false)}
              className="text-muted transition hover:text-ink"
              aria-label="Close chat"
            >
              ✕
            </button>
          </div>

          {!unlocked ? (
            <div className="flex flex-1 items-center justify-center px-4 py-10 text-center text-sm text-muted">
              Top up from {creatorTitle} to start a conversation. 💖
            </div>
          ) : (
            <>
              <div className="flex-1 space-y-2 overflow-y-auto py-2">
                {messages.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted">
                    Say hi to {creatorTitle} 👋
                  </p>
                )}
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={
                      m.sender === "fan" ? "flex justify-end" : "flex justify-start"
                    }
                  >
                    <span
                      className="max-w-[80%] rounded-2xl px-3 py-2 text-sm"
                      style={
                        m.sender === "fan"
                          ? { background: "var(--brand)", color: "#fff" }
                          : { background: "color-mix(in oklab, var(--color-ink) 8%, transparent)", color: "var(--color-ink)" }
                      }
                    >
                      {m.body}
                    </span>
                  </div>
                ))}
                {/* Optimistic outbound bubbles (pending / failed), fan side. */}
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
              <div className="mt-2 flex items-center gap-2">
                <input
                  aria-label={`Message ${creatorTitle}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  maxLength={2000}
                  placeholder="Message…"
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
            </>
          )}
        </div>
      )}
    </>
  );
}
