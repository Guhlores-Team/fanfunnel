"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/data/types";

/**
 * Spin-gated DM thread with the creator. Fans with ≥1 spin (chatUnlocked) can
 * message; otherwise they see a top-up nudge. Polls every 5s while open.
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
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages/fan?token=${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const d = await res.json();
        setMessages(d.messages ?? []);
      }
    } catch {
      /* transient */
    }
  }, [token]);

  useEffect(() => {
    if (!open || !unlocked) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load thread on open, then poll
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [open, unlocked, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/messages/fan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, body }),
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
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-4 right-4 z-40 flex h-12 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink shadow-lg transition hover:border-[var(--brand)]"
        aria-label="Message creator"
      >
        💬 Message
      </button>

      {open && (
        <div className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[80vh] w-full max-w-md flex-col rounded-t-3xl border border-line bg-surface p-4 shadow-2xl sm:bottom-4 sm:right-4 sm:left-auto sm:mx-0 sm:max-h-[28rem] sm:rounded-3xl">
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
                <div ref={endRef} />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
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
