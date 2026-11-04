"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { ChatMessage, FanThread, RedemptionItem } from "@/lib/data/types";
import { seatPath, seatTabs, type SeatCreatorView, type SeatTab } from "./seatWorkspace";

// A19: where a staff seat does its job for the creators it is scoped to. A
// chatter gets that creator's inbox only, a fulfiller the prize queue only, a
// manager both. Every request names the creator; the server re-checks
// can_act_for on each one, so this view only reflects what the server allows.
export default function SeatWorkspace() {
  const id = useId();
  const [seats, setSeats] = useState<SeatCreatorView[] | null>(null);
  const [creatorId, setCreatorId] = useState("");
  const [tab, setTab] = useState<SeatTab>("inbox");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let live = true;
    void fetch("/api/agency/seats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { seats: [] }))
      .then((d: { seats?: SeatCreatorView[] }) => {
        if (!live) return;
        const list = Array.isArray(d.seats) ? d.seats : [];
        setSeats(list);
        if (list[0]) {
          setCreatorId(list[0].creatorId);
          setTab(seatTabs(list[0])[0] ?? "inbox");
        }
      })
      .catch(() => live && setSeats([]));
    return () => {
      live = false;
    };
  }, []);

  if (!seats || seats.length === 0) return null;
  const seat = seats.find((s) => s.creatorId === creatorId) ?? seats[0];
  const tabs = seatTabs(seat);
  const active = tabs.includes(tab) ? tab : tabs[0];

  return (
    <section aria-labelledby={`${id}-title`} className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-5">
      <h2 id={`${id}-title`} className="text-lg font-bold">Your seat</h2>
      <p className="mt-1 text-sm text-white/50">Work for the creators your agency assigned to you. You only see the jobs your role allows.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-white/60">Creator</span>
          <select
            value={seat.creatorId}
            onChange={(e) => {
              const next = seats.find((s) => s.creatorId === e.target.value);
              setCreatorId(e.target.value);
              if (next) setTab(seatTabs(next)[0] ?? "inbox");
              setMsg("");
            }}
            className="mt-1 rounded-lg border border-white/15 bg-zinc-900 px-3 py-2"
          >
            {seats.map((s) => (
              <option key={s.creatorId} value={s.creatorId}>{s.displayName}</option>
            ))}
          </select>
        </label>
        <div role="tablist" aria-label="Seat jobs" className="flex gap-2">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={active === t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${active === t ? "bg-white text-black" : "border border-white/15 text-white/70"}`}
            >
              {t === "inbox" ? "Inbox" : "Prizes to fulfil"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4" role="tabpanel">
        {active === "inbox" ? <SeatInbox key={seat.creatorId} creatorId={seat.creatorId} onError={setMsg} /> : <SeatPrizes key={seat.creatorId} creatorId={seat.creatorId} onError={setMsg} />}
      </div>
      <p role="status" aria-live="polite" className="mt-3 text-sm text-amber-300">{msg}</p>
    </section>
  );
}

function SeatInbox({ creatorId, onError }: { creatorId: string; onError: (m: string) => void }) {
  const [threads, setThreads] = useState<FanThread[] | null>(null);
  const [fanId, setFanId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const replyId = useId();

  const loadThreads = useCallback(async () => {
    const r = await fetch(seatPath("/api/messages/inbox", creatorId), { cache: "no-store" });
    if (!r.ok) return onError("This inbox is not available to your seat.");
    setThreads(((await r.json()) as { threads?: FanThread[] }).threads ?? []);
  }, [creatorId, onError]);
  const loadThread = useCallback(async (fan: string) => {
    const r = await fetch(seatPath(`/api/messages/thread/${encodeURIComponent(fan)}`, creatorId), { cache: "no-store" });
    if (!r.ok) return onError("This conversation is not available to your seat.");
    setMessages(((await r.json()) as { messages?: ChatMessage[] }).messages ?? []);
  }, [creatorId, onError]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void loadThreads();
  }, [loadThreads]);

  async function send() {
    if (!fanId || !draft.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/messages/creator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fanId, body: draft, creatorId }),
      });
      if (!r.ok) return onError("The reply was not sent.");
      setDraft("");
      await loadThread(fanId);
    } finally {
      setBusy(false);
    }
  }

  if (!threads) return <p className="text-sm text-white/40">Loading…</p>;
  if (threads.length === 0) return <p className="text-sm text-white/40">No conversations yet.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <ul className="space-y-1">
        {threads.map((t) => (
          <li key={t.fanId}>
            <button
              type="button"
              aria-current={fanId === t.fanId}
              onClick={() => { setFanId(t.fanId); void loadThread(t.fanId); }}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${fanId === t.fanId ? "bg-white/15" : "hover:bg-white/10"}`}
            >
              <span className="font-semibold">{t.fanName}</span>
              {t.unread > 0 && <span className="ml-2 rounded-full bg-pink-500 px-2 text-xs text-black">{t.unread}</span>}
              <span className="block truncate text-white/50">{t.lastBody}</span>
            </button>
          </li>
        ))}
      </ul>
      {fanId && (
        <div>
          <ol className="max-h-80 space-y-2 overflow-y-auto">
            {messages.map((m) => (
              <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.sender === "creator" ? "ml-8 bg-pink-500/20" : "mr-8 bg-white/10"}`}>{m.body}</li>
            ))}
          </ol>
          <label htmlFor={replyId} className="mt-3 block text-sm text-white/60">Reply</label>
          <textarea id={replyId} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-white/15 bg-zinc-900 px-3 py-2 text-sm" />
          <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="mt-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black disabled:opacity-50">
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      )}
    </div>
  );
}

function SeatPrizes({ creatorId, onError }: { creatorId: string; onError: (m: string) => void }) {
  const [items, setItems] = useState<RedemptionItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(seatPath("/api/redemptions?status=pending", creatorId), { cache: "no-store" });
    if (!r.ok) return onError("This prize queue is not available to your seat.");
    setItems(((await r.json()) as { items?: RedemptionItem[] }).items ?? []);
  }, [creatorId, onError]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void load();
  }, [load]);

  async function fulfil(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      const r = await fetch("/api/redemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "fulfilled", creatorId }),
      });
      if (!r.ok) return onError("That prize could not be marked fulfilled.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!items) return <p className="text-sm text-white/40">Loading…</p>;
  if (items.length === 0) return <p className="text-sm text-white/40">Nothing waiting to be fulfilled.</p>;
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm">
          <span><span className="font-semibold">{it.prizeLabel}</span> for {it.fanName}</span>
          <button type="button" onClick={() => void fulfil(it.id)} disabled={busy !== null} className="rounded-lg border border-white/20 px-3 py-1 font-semibold disabled:opacity-50" aria-label={`Mark ${it.prizeLabel} for ${it.fanName} fulfilled`}>
            {busy === it.id ? "Saving…" : "Mark fulfilled"}
          </button>
        </li>
      ))}
    </ul>
  );
}
