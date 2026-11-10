"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatMessage, FanThread, RedemptionItem } from "@/lib/data/types";
import { seatPath, seatTabs, type SeatCreatorView, type SeatTab } from "./seatWorkspace";
import LoadFailed from "@/components/dashboard/LoadFailed";
import { loadJson } from "@/lib/hooks/loadJson";

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
  // WG-08: a half-written reply is not thrown away by a creator switch.
  const draftRef = useRef("");
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);

  // RD-04: "no seats" and "the read failed" are different states; a failed
  // read shows an error with Retry instead of a vanished workspace.
  const [loadError, setLoadError] = useState<unknown>(null);
  const loadSeats = useCallback(async () => {
    try {
      const d = await loadJson<{ seats?: SeatCreatorView[] }>("/api/agency/seats");
      setLoadError(null);
      const list = Array.isArray(d.seats) ? d.seats : [];
      setSeats(list);
      if (list[0]) {
        setCreatorId((c) => (list.some((s) => s.creatorId === c) ? c : list[0].creatorId));
        setTab(seatTabs(list[0])[0] ?? "inbox");
      }
    } catch (e) {
      setLoadError(e);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void loadSeats();
  }, [loadSeats]);

  if (!seats && loadError != null) {
    return (
      <section className="mt-8">
        <LoadFailed error={loadError} what="your seat" onRetry={loadSeats} testId="seat-load-failed" />
      </section>
    );
  }
  if (!seats || seats.length === 0) return null;
  const seat = seats.find((s) => s.creatorId === creatorId) ?? seats[0];
  const switchCreator = (nextId: string) => {
    const next = seats.find((s) => s.creatorId === nextId);
    setPendingSwitch(null);
    setCreatorId(nextId);
    if (next) setTab(seatTabs(next)[0] ?? "inbox");
    setMsg("");
  };
  const tabs = seatTabs(seat);
  const active = tabs.includes(tab) ? tab : tabs[0];

  return (
    <section aria-labelledby={`${id}-title`} className="mt-8 rounded-2xl border border-line bg-surface p-5">
      <h2 id={`${id}-title`} className="text-lg font-bold">Your seat</h2>
      <p className="mt-1 text-sm text-muted">Work for the creators your agency assigned to you. You only see the jobs your role allows.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-muted">Creator</span>
          <select
            value={seat.creatorId}
            onChange={(e) => {
              if (draftRef.current.trim()) { setPendingSwitch(e.target.value); return; }
              switchCreator(e.target.value);
            }}
            className="ff-input mt-1 w-auto"
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
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${active === t ? "bg-[var(--brand)] text-[var(--brand-ink)]" : "border border-line text-muted"}`}
            >
              {t === "inbox" ? "Inbox" : "Prizes to fulfil"}
            </button>
          ))}
        </div>
      </div>
      {pendingSwitch && (
        <div role="group" aria-label="Unsaved reply" data-testid="seat-switch-guard" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-300/40 bg-amber-400/5 px-3.5 py-3 text-sm text-ink">
          <p className="min-w-0 flex-1 basis-60">You have an unsent reply for {seat.displayName}. Switching creators discards it.</p>
          <button type="button" onClick={() => { draftRef.current = ""; switchCreator(pendingSwitch); }} className="min-h-10 rounded-lg border border-line px-3 text-[12.5px] font-semibold">Discard and switch</button>
          <button type="button" autoFocus onClick={() => setPendingSwitch(null)} className="btn-brand min-h-10 rounded-lg px-3 text-[12.5px] font-bold">Keep writing</button>
        </div>
      )}
      <div className="mt-4" role="tabpanel">
        {active === "inbox" ? <SeatInbox key={seat.creatorId} creatorId={seat.creatorId} onError={setMsg} onDraft={(d) => { draftRef.current = d; }} /> : <SeatPrizes key={seat.creatorId} creatorId={seat.creatorId} onError={setMsg} />}
      </div>
      <p role="status" aria-live="polite" className="mt-3 text-sm text-amber-300">{msg}</p>
    </section>
  );
}

function SeatInbox({ creatorId, onError, onDraft }: { creatorId: string; onError: (m: string) => void; onDraft?: (draft: string) => void }) {
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
    const path = seatPath(`/api/messages/thread/${encodeURIComponent(fan)}`, creatorId);
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return onError("This conversation is not available to your seat.");
    const list = ((await r.json()) as { messages?: ChatMessage[] }).messages ?? [];
    setMessages(list);
    // I3: marking read is its own POST, never a side effect of the read.
    if (list.some((m) => m.sender === "fan" && !m.readAt)) {
      await fetch(path, { method: "POST", cache: "no-store" }).catch(() => null);
    }
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
      onDraft?.("");
      await loadThread(fanId);
    } finally {
      setBusy(false);
    }
  }

  if (!threads) return <p className="text-sm text-muted">Loading…</p>;
  if (threads.length === 0) return <p className="text-sm text-muted">No conversations yet.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <ul className="space-y-1">
        {threads.map((t) => (
          <li key={t.fanId}>
            <button
              type="button"
              aria-current={fanId === t.fanId}
              onClick={() => { setFanId(t.fanId); void loadThread(t.fanId); }}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${fanId === t.fanId ? "bg-surface-2" : "hover:bg-surface-2"}`}
            >
              <span className="font-semibold">{t.fanName}</span>
              {t.unread > 0 && <span className="ml-2 rounded-full bg-[var(--brand)] px-2 text-xs text-[var(--brand-ink)]">{t.unread}</span>}
              <span className="block truncate text-muted">{t.lastBody}</span>
            </button>
          </li>
        ))}
      </ul>
      {fanId && (
        <div>
          <ol className="max-h-80 space-y-2 overflow-y-auto">
            {messages.map((m) => (
              <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.sender === "creator" ? "ml-8 bg-[color-mix(in_oklab,var(--brand)_18%,transparent)]" : "mr-8 bg-surface-2"}`}>{m.body}</li>
            ))}
          </ol>
          <label htmlFor={replyId} className="mt-3 block text-sm text-muted">Reply</label>
          <textarea id={replyId} value={draft} onChange={(e) => { setDraft(e.target.value); onDraft?.(e.target.value); }} maxLength={2000} rows={2} className="ff-input mt-1 w-full text-sm" />
          <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="mt-2 btn-brand rounded-lg px-3 py-2 text-sm font-semibold">
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
  // WG-08: "Mark fulfilled" asks first, then keeps an Undo for a while, so a
  // mis-tap never tells the fan "delivered" for a prize they never got.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [undo, setUndo] = useState<RedemptionItem | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 15_000);
    return () => clearTimeout(t);
  }, [undo]);
  const load = useCallback(async () => {
    const r = await fetch(seatPath("/api/redemptions?status=pending", creatorId), { cache: "no-store" });
    if (!r.ok) return onError("This prize queue is not available to your seat.");
    setItems(((await r.json()) as { items?: RedemptionItem[] }).items ?? []);
  }, [creatorId, onError]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void load();
  }, [load]);

  async function setState(item: RedemptionItem, status: "fulfilled" | "pending") {
    if (busy) return;
    setBusy(item.id);
    setConfirmId(null);
    try {
      const r = await fetch("/api/redemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status, creatorId }),
      });
      if (!r.ok) return onError(status === "fulfilled" ? "That prize could not be marked fulfilled." : "That prize could not be reopened.");
      setUndo(status === "fulfilled" ? item : null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!items) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div>
      {undo && (
        <p role="status" data-testid="seat-fulfil-undo" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">Marked fulfilled: {undo.prizeLabel} for {undo.fanName}. The fan now sees it as delivered.</span>
          <button type="button" onClick={() => void setState(undo, "pending")} disabled={busy !== null} className="min-h-9 rounded-lg border border-line px-3 font-semibold disabled:opacity-50">Undo</button>
        </p>
      )}
      {items.length === 0 ? <p className="text-sm text-muted">Nothing waiting to be fulfilled.</p> : (
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2 text-sm">
            <span><span className="font-semibold">{it.prizeLabel}</span> for {it.fanName}</span>
            {confirmId === it.id ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-muted">Tell the fan it was delivered?</span>
                <button type="button" onClick={() => void setState(it, "fulfilled")} disabled={busy !== null} className="btn-brand min-h-9 rounded-lg px-3 font-semibold disabled:opacity-50">
                  {busy === it.id ? "Saving…" : "Yes, fulfilled"}
                </button>
                <button type="button" autoFocus onClick={() => setConfirmId(null)} className="min-h-9 rounded-lg border border-line px-3 font-semibold">Not yet</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmId(it.id)} disabled={busy !== null} className="min-h-9 rounded-lg border border-line px-3 font-semibold disabled:opacity-50" aria-label={`Mark ${it.prizeLabel} for ${it.fanName} fulfilled`}>
                Mark fulfilled
              </button>
            )}
          </li>
        ))}
      </ul>
      )}
    </div>
  );
}
