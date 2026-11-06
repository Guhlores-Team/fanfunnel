"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useNow } from "@/lib/hooks/useNow";
import { isOnBreak } from "@/lib/play/playGuard";

interface LinkPauseValue {
  paused: boolean;
  markPaused: () => void;
  /** RM-6: when the fan's break ends (null = not on a break). */
  breakUntil: string | null;
  markOnBreak: (until: string) => void;
}

const LinkPauseContext = createContext<LinkPauseValue>({
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
}: {
  children: ReactNode;
  initialBreakUntil?: string | null;
}) {
  const [paused, setPaused] = useState(false);
  // A break taken on this page, layered over the server's value (which a
  // router.refresh() can update), keeping whichever ends later.
  const [taken, setTaken] = useState<string | null>(null);
  const breakUntil = laterOf(initialBreakUntil, taken);
  const value = useMemo(
    () => ({ paused, markPaused: () => setPaused(true), breakUntil, markOnBreak: (until: string) => setTaken(until) }),
    [paused, breakUntil]
  );
  return <LinkPauseContext.Provider value={value}>{children}</LinkPauseContext.Provider>;
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
  const now = useNow(30_000) ?? 0;
  return { breakUntil, onBreak: isOnBreak(breakUntil, now), now, markOnBreak };
}
