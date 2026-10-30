// Pure helpers for the fan's "Your play" card and the reminder card (RM-6),
// kept out of the components so they are unit-tested. Copy rules: no
// countdowns, no loss framing ("don't lose", "last chance"), and Keep playing
// and Take a break carry equal weight.
import { REMINDER_ACK_STORAGE_KEY, REMINDER_ACK_WINDOW_MS } from "@/lib/play/config";

const DAY_MS = 86_400_000;

const spins = (n: number) => `${n} ${n === 1 ? "spin" : "spins"}`;

/** "12 spins today · 38 this week". */
export function playSummary(today: number, week: number): string {
  return `${spins(today)} today · ${week} this week`;
}

/** The reminder card's headline. */
export function breatherTitle(today: number): string {
  return `You've played ${spins(today)} today`;
}

/**
 * When a break ends, short and local: "Fri 9:00 PM" within the week, else
 * "Nov 26, 9:00 PM". An absolute time, never a countdown.
 */
export function formatBreakEnd(iso: string, now: number, locale?: string): string {
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return "";
  const soon = end.getTime() - now < 6 * DAY_MS;
  return new Intl.DateTimeFormat(locale, {
    ...(soon ? { weekday: "short" } : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  } as Intl.DateTimeFormatOptions).format(end);
}

/** The line under SPIN while the fan is on a break. */
export function breakStatus(endLabel: string | null): string {
  return endLabel
    ? `You're taking a break until ${endLabel}. Your spins and prizes are safe.`
    : "You're taking a break. Your spins and prizes are safe.";
}

type KV = Pick<Storage, "getItem" | "setItem">;

function storage(): KV | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked storage (private mode, policy)
  }
}

function readAck(store: KV | null): { n: number; at: number } | null {
  try {
    const raw = store?.getItem(REMINDER_ACK_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { n?: unknown; at?: unknown }) : null;
    return parsed && typeof parsed.n === "number" && typeof parsed.at === "number"
      ? { n: parsed.n, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * The reminder card shows once per threshold per day: true while "Keep
 * playing" was tapped at this threshold in the last 24 hours on this device.
 * Changing the reminder number re-arms it. Nothing about the link is stored.
 */
export function reminderAcked(threshold: number, now: number = Date.now(), store: KV | null = storage()): boolean {
  const ack = readAck(store);
  return !!ack && ack.n === threshold && ack.at <= now && now - ack.at < REMINDER_ACK_WINDOW_MS;
}

export function ackReminder(threshold: number, now: number = Date.now(), store: KV | null = storage()): void {
  try {
    store?.setItem(REMINDER_ACK_STORAGE_KEY, JSON.stringify({ n: threshold, at: now }));
  } catch {
    /* storage full or blocked: the card may show again, which is the safe side */
  }
}
