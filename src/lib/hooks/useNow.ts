"use client";

import { useCallback, useSyncExternalStore } from "react";

/** `now` floored to `resolutionMs`, so it is stable within each window. */
export function quantizeNow(now: number, resolutionMs: number): number {
  const r = Math.max(1, resolutionMs);
  return Math.floor(now / r) * r;
}

/** Delay until the next `resolutionMs` boundary (always ≥ 1ms). */
export function msUntilNextTick(now: number, resolutionMs: number): number {
  const r = Math.max(1, resolutionMs);
  return r - (now % r);
}

const serverSnapshot = () => null;

/**
 * The current time (ms since epoch), quantized to `resolutionMs` and kept live
 * by a timer aligned to that boundary.
 *
 * Hydration-safe: returns `null` on the server AND during the client's
 * hydration render (React uses the server snapshot there), then the real time
 * right after. Render a stable placeholder for `null`. Reading `Date.now()`
 * directly during render makes server and client text diverge (React #418).
 */
export function useNow(resolutionMs = 1000): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let id: ReturnType<typeof setTimeout>;
      const schedule = () => {
        id = setTimeout(() => {
          onChange();
          schedule();
        }, msUntilNextTick(Date.now(), resolutionMs));
      };
      schedule();
      return () => clearTimeout(id);
    },
    [resolutionMs]
  );
  const getSnapshot = useCallback(
    () => quantizeNow(Date.now(), resolutionMs),
    [resolutionMs]
  );
  return useSyncExternalStore<number | null>(subscribe, getSnapshot, serverSnapshot);
}
