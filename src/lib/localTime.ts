"use client";

import { useSyncExternalStore } from "react";

/**
 * Times the creator sees are shown in the browser's zone, and say which zone
 * that is (WG-17 / WC-24): a laptop set to another zone would otherwise show
 * a different "8 PM" than the phone it was scheduled on, with no hint.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** "Nov 10, 2026, 2:51 PM GMT+1" — the zone name is part of every timestamp. */
export function formatWhen(iso: string | number | Date, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : "";
  return d.toLocaleString(undefined, { timeZoneName: "short", ...opts });
}

const noSubscribe = () => () => {};
const emptySnapshot = () => "";

/** The browser's IANA zone ("Europe/Berlin"); "" on the server and during hydration. */
export function useTimeZone(): string {
  return useSyncExternalStore(noSubscribe, browserTimeZone, emptySnapshot);
}

/**
 * Today's date in the browser's zone and locale (RD-08). "" on the server and
 * during hydration, so the header never shows the server's (UTC) day.
 */
export function useTodayLabel(): string {
  return useSyncExternalStore(noSubscribe, todayLabel, emptySnapshot);
}
function todayLabel(): string {
  // Stable within a day: useSyncExternalStore needs the same string back
  // while nothing changed, and the date only moves at local midnight.
  const d = new Date();
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (cached && cached.key === key) return cached.label;
  const label = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  cached = { key, label };
  return label;
}
let cached: { key: string; label: string } | null = null;

/** A one-line hint for a date/time field: "Times are in your time zone (Europe/Berlin)." */
export function zoneHint(zone: string): string {
  return zone ? `Times are in your time zone (${zone.replace(/_/g, " ")}).` : "Times are in your time zone.";
}
