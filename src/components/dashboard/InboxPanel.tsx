"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, FanThread } from "@/lib/data/types";
import { EmptyState } from "./ui";

/**
 * The creator's chat inbox: a list of fan threads with unread counts, and a
 * conversation view for the selected fan. Opening a thread marks it read; the
 * parent's `onChanged` lets the dashboard refresh its unread badge.
 */
export default function InboxPanel({ onChanged }: { onChanged?: () => void }) {
  const [threads, setThreads] = useState<FanThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [openFan, setOpenFan] = useState<FanThread | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/messages/inbox", { cache: "no-store" });
      if (res.ok) setThreads((await res.json()).threads ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadThreads();
    const id = setInterval(loadThreads, 8000);
    return () => clearInterval(id);
  }, [loadThreads]);

  if (loading && threads.length === 0) {
    return <p className="py-10 text-center text-sm text-muted">Loading inbox…</p>;
  }

  if (threads.length === 0) {
    return (
      <EmptyState
        title="No messages yet"
        body="Fans with at least one spin can message you. Replies show up here."
      />
    );
  }

  return (
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
