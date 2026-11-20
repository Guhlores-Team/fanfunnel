"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** The server's rendering: unambiguous UTC, never the server's own zone. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The fan's rendering: their locale and time zone, with the zone named. */
export function formatLocal(iso: string, locale?: string | string[], timeZone?: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
      timeZoneName: "short", ...(timeZone ? { timeZone } : {}),
    }).format(d);
  } catch {
    return formatUtc(iso);
  }
}

/**
 * FD-11: a spin's time in the viewer's own time zone and locale, labelled with
 * the zone. The server (and a browser without JavaScript) shows UTC, labelled.
 */
export default function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const text = useSyncExternalStore(noSubscribe, () => formatLocal(iso), () => formatUtc(iso));
  return (
    <time dateTime={iso} className={className} data-testid="verify-time">
      {text}
    </time>
  );
}
