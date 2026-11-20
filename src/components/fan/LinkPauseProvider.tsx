"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useNow } from "@/lib/hooks/useNow";
import { isOnBreak } from "@/lib/play/playGuard";

interface LinkPauseValue {
  /** RF-13: server clock minus device clock (ms), read once on the client. */
  clockOffsetMs: number;
  paused: boolean;
  markPaused: () => void;
  /** RM-6: when the fan's break ends (null = not on a break). */
  breakUntil: string | null;
  markOnBreak: (until: string) => void;
}

const LinkPauseContext = createContext<LinkPauseValue>({
  clockOffsetMs: 0,
  paused: false,
  markPaused: () => {},
  breakUntil: null,
  markOnBreak: () => {},
});

/**
 * Shares the "this link was just paused" fact between the SafetyMenu (footer)
 * and SpinClient (wheel), which are siblings on the server-rendered fan page —
 * so a successful pause disables SPIN at once, with no reload. It also carries
 * the fan's break (RM-6), so every "keep going" surface on the page (SPIN, the
 * install nudge, the top-up moment) sees a break the moment it starts.
 */
export function LinkPauseProvider({
  children,
  initialBreakUntil = null,
  serverNow = null,
}: {
  children: ReactNode;
  initialBreakUntil?: string | null;
  /** RF-13: the server's time when it rendered this page (ISO). */
  serverNow?: string | null;
}) {
  const [paused, setPaused] = useState(false);
  // A phone whose clock is minutes off would show a happy hour that is over or
  // a break that has ended; every countdown on the page uses the server's
  // clock instead. Read once, on the client only (the HTML never shows it).
  const [clockOffsetMs] = useState(() => clockOffset(serverNow));
  // A break taken on this page, layered over the server's value (which a
  // router.refresh() can update), keeping whichever ends later.
  const [taken, setTaken] = useState<string | null>(null);
  const breakUntil = laterOf(initialBreakUntil, taken);
  const value = useMemo(
    () => ({ clockOffsetMs, paused, markPaused: () => setPaused(true), breakUntil, markOnBreak: (until: string) => setTaken(until) }),
    [clockOffsetMs, paused, breakUntil]
  );
  return <LinkPauseContext.Provider value={value}>{children}</LinkPauseContext.Provider>;
}

/** Server minus device time; 0 on the server, for a missing value, or for a skew under 5s (network latency). */
export function clockOffset(serverNow: string | null, deviceNow = Date.now(), hasWindow = typeof window !== "undefined"): number {
  if (!hasWindow || !serverNow) return 0;
  const server = Date.parse(serverNow);
  if (!Number.isFinite(server)) return 0;
  const offset = server - deviceNow;
  return Math.abs(offset) < 5_000 ? 0 : offset;
}

/** RF-13: `useNow` on the server's clock (null until hydrated, like useNow). */
export function useServerNow(resolutionMs = 1000): number | null {
  const { clockOffsetMs } = useContext(LinkPauseContext);
  const now = useNow(resolutionMs);
  return now === null ? null : now + clockOffsetMs;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a || !b) return a ?? b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export const useLinkPause = () => useContext(LinkPauseContext);

/**
 * The fan's break, live: `onBreak` flips off on its own when the break ends.
 * `now` is 0 on the server and during hydration (useNow's null), so a break
 * the server reported counts as in force until the client knows the time.
 */
export function useFanBreak(): { breakUntil: string | null; onBreak: boolean; now: number; markOnBreak: (until: string) => void } {
  const { breakUntil, markOnBreak } = useLinkPause();
  const now = useServerNow(30_000) ?? 0;
  return { breakUntil, onBreak: isOnBreak(breakUntil, now), now, markOnBreak };
}
