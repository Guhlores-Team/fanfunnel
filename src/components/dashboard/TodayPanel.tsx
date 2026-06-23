"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";

interface Action {
  kind: string;
  fanId?: string;
  token?: string | null;
  weekday?: number;
  hour?: number;
}
interface Card {
  key: string;
  icon: string;
  title: string;
  body: string;
  cta: string;
  action: Action;
  score: number;
}

/**
 * "Today" — a ranked, prescriptive action feed. Each card is one tap to act,
 * reusing existing dashboard surfaces (inbox, fulfilment, editor, boosts) via
 * the `onNavigate` tab switch, or a direct copy-link. Cards can be snoozed/dismissed.
 */
export default function TodayPanel({
  onNavigate,
}: {
  onNavigate: (tab: string) => void;
}) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const toast = useToast();
  const origin = useOrigin();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot", { cache: "no-store" });
      if (res.ok) setCards((await res.json()).cards ?? []);
      else setCards([]);
    } catch {
      setCards([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, [load]);

  const act = async (c: Card) => {
    const a = c.action;
    switch (a.kind) {
      case "open_inbox":
        onNavigate("inbox");
        break;
      case "open_fulfilment":
        onNavigate("prizes");
        break;
      case "edit_wheel":
        onNavigate("editor");
        break;
      case "schedule_happy_hour":
        onNavigate("boosts");
        break;
      case "none":
        onNavigate("campaigns");
        break;
      case "dm_fan":
      case "copy_link":
        if (a.token) {
          if (await copyToClipboard(`${origin}/spin/${a.token}`)) {
            toast("Spin link copied — paste it in a DM.", { tone: "success" });
          } else {
            toast("Couldn't copy.", { tone: "error" });
          }
        } else {
          onNavigate("fans");
        }
        break;
      default:
        break;
    }
  };

  const dismiss = async (key: string, snoozeDays?: number) => {
    setCards((cs) => (cs ? cs.filter((c) => c.key !== key) : cs));
    const snoozeUntil = snoozeDays
      ? new Date(Date.now() + snoozeDays * 86400000).toISOString()
      : undefined;
    await fetch("/api/autopilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, snoozeUntil }),
    });
  };

  if (cards === null) {
    return <p className="py-10 text-center text-sm text-muted">Loading your day…</p>;
  }

  if (cards.length === 0) {
    return (
      <div className="card rounded-2xl p-8 text-center">
        <div className="text-4xl">✅</div>
        <h3 className="mt-3 font-bold text-ink">You&rsquo;re all caught up</h3>
        <p className="mt-1 text-sm text-muted">
          No actions need you right now. Come back after more fans spin.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {cards.length} {cards.length === 1 ? "thing" : "things"} worth your time, ranked.
      </p>
      {cards.map((c) => (
        <div key={c.key} className="card rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl" aria-hidden>
              {c.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-ink">{c.title}</p>
              <p className="mt-0.5 text-sm text-muted text-pretty">{c.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => act(c)}
                  className="btn-brand rounded-lg px-4 py-1.5 text-sm font-bold"
                >
                  {c.cta}
                </button>
                <button
                  onClick={() => dismiss(c.key, 3)}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
                >
                  Snooze 3d
                </button>
                <button
                  onClick={() => dismiss(c.key)}
                  className="rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
