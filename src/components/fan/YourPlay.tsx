"use client";

import { useId, useState } from "react";
import { PLAY_REMINDER_OPTIONS } from "@/lib/play/config";
import { playCountsVisible, remindersEnabled } from "@/lib/play/playGuard";
import BreakPicker from "./BreakPicker";
import { breakStatus, playSummary } from "./yourPlay";

export interface YourPlayCounts {
  today: number;
  week: number;
  reminder: number | null;
}

/**
 * RM-6 "Your play": a collapsed row under the spins chip with the fan's own
 * counts ("12 spins today · 38 this week"). Opened, it lets the fan set a soft
 * daily reminder (Off / 20 / 50 / 100) and take a break (24h / 7d / 30d).
 * No caps, no loss framing. Only the fan sees any of this; their creator sees
 * only that they are on a break.
 */
export default function YourPlay({
  token,
  play,
  onReminderChange,
  onBreak,
  breakEndLabel,
  onBreakTaken,
}: {
  token: string;
  play: YourPlayCounts;
  onReminderChange: (reminder: number | null) => void;
  onBreak: boolean;
  breakEndLabel: string | null;
  onBreakTaken: (breakUntil: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const panelId = useId();
  const reminderHintId = useId();
  const reminderName = useId();
  const showCounts = playCountsVisible(play.reminder);

  const setReminder = async (next: number | null) => {
    if (next === play.reminder || saving) return;
    const prev = play.reminder;
    onReminderChange(next);
    setSaving(true);
    setNote(null);
    try {
      const res = await fetch("/api/fan/reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, daily: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setNote(next === null ? "Reminder off." : `We'll check in after ${next} spins a day.`);
    } catch {
      onReminderChange(prev);
      setNote("Couldn't save your reminder. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="your-play" className="w-full rounded-2xl border border-line bg-surface/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl px-4 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
      >
        <span className="min-w-0">
          <span className="font-semibold text-ink">Your play</span>
          {showCounts && (
            <span data-testid="your-play-counts" className="tnum ml-2 text-muted">
              {playSummary(play.today, play.week)}
            </span>
          )}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div id={panelId} className="space-y-4 border-t border-line px-4 pb-4 pt-3">
          {remindersEnabled() && (
            <fieldset aria-describedby={reminderHintId} disabled={saving}>
              <legend className="text-sm font-bold text-ink">Daily reminder</legend>
              <p id={reminderHintId} className="mt-0.5 text-xs text-muted">
                We&rsquo;ll check in with you after this many spins a day.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {[null, ...PLAY_REMINDER_OPTIONS].map((n) => {
                  const checked = play.reminder === n;
                  return (
                    <label
                      key={n ?? "off"}
                      className={`inline-flex min-h-11 min-w-[3.25rem] cursor-pointer items-center justify-center rounded-xl border px-3 text-sm font-semibold transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--brand)] ${
                        checked ? "border-[var(--brand)] text-ink" : "border-line text-muted hover:text-ink"
                      }`}
                      style={checked ? { background: "color-mix(in oklab, var(--brand) 18%, transparent)" } : undefined}
                    >
                      <input
                        type="radio"
                        name={reminderName}
                        value={n ?? "off"}
                        checked={checked}
                        onChange={() => setReminder(n)}
                        className="sr-only"
                      />
                      {n === null ? "Off" : n}
                    </label>
                  );
                })}
              </div>
              <p role="status" className="mt-1.5 min-h-4 text-xs text-muted">
                {note ?? ""}
              </p>
            </fieldset>
          )}

          {onBreak ? (
            <p className="text-sm text-ink">{breakStatus(breakEndLabel)}</p>
          ) : (
            <BreakPicker
              token={token}
              onTaken={(until) => {
                onBreakTaken(until);
                setOpen(false);
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}
