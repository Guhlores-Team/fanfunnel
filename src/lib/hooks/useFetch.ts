"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export interface FetchState<T> {
  /** Latest successfully-parsed payload, or null before the first success. */
  data: T | null;
  /** True while a request is in flight (and we have no data yet, on first load). */
  loading: boolean;
  /** Non-null when the most recent load failed (network or non-ok response). */
  error: Error | null;
  /** Manually trigger a refetch (e.g. after a mutation). Stable identity. */
  reload: () => Promise<void>;
  /** Patch the cached data directly (e.g. optimistic UI before a reload). */
  setData: Dispatch<SetStateAction<T | null>>;
}

export interface UseFetchOptions<T> {
  /**
   * Poll interval in ms. When set, the resource refetches on this cadence while
   * the document is visible. Omit / 0 to fetch once (on mount + dep change).
   */
  pollMs?: number;
  /** Refetch when the tab becomes visible again. Defaults to true. */
  refreshOnVisible?: boolean;
  /**
   * Validate / narrow the parsed JSON before it's stored. Return the typed value
   * or throw to surface a boundary-validation error instead of trusting the
   * response shape blindly.
   */
  select?: (raw: unknown) => T;
  /** Skip fetching entirely while false (e.g. missing id). Defaults to true. */
  enabled?: boolean;
}

/**
 * One shared client fetch/poll hook owning loading, error, the SSR/cleanup
 * guards, and (optional) visibility-refresh + polling. Replaces the ~30 copies
 * of `useState + useEffect + fetch + if (res.ok) setData(await res.json())`
 * scattered through the dashboard and fan widgets.
 *
 * Reads surface failures via `error` instead of a silent `.catch(() => {})`.
 *
 * `url` may be null to disable fetching (treated like `enabled: false`).
 */
export function useFetch<T>(
  url: string | null,
  opts: UseFetchOptions<T> = {}
): FetchState<T> {
  const { pollMs = 0, refreshOnVisible = true, select, enabled = true } = opts;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Keep `select` current without making it a load() dependency (callers usually
  // pass an inline function, which would otherwise re-create the effect forever).
  // Updated in an effect (not during render) so refs are only touched off-render;
  // `load` always runs from effects, after this has synced.
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });

  // Tracks the latest in-flight request so a stale response (slow request that
  // resolves after a newer one / after unmount) never clobbers fresh state.
  const reqId = useRef(0);
  const mounted = useRef(true);

  const active = enabled && url !== null;

  const load = useCallback(async () => {
    if (!active || typeof window === "undefined") return;
    const id = ++reqId.current;
    try {
      const res = await fetch(url as string, { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const raw: unknown = await res.json();
      const value = selectRef.current ? selectRef.current(raw) : (raw as T);
      if (!mounted.current || id !== reqId.current) return;
      setData(value);
      setError(null);
    } catch (e) {
      if (!mounted.current || id !== reqId.current) return;
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      if (mounted.current && id === reqId.current) setLoading(false);
    }
  }, [url, active]);

  useEffect(() => {
    mounted.current = true;
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to fetch; settle the loading flag
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }
    setLoading(true);
    void load();

    const cleanups: Array<() => void> = [];
    if (pollMs > 0) {
      const interval = setInterval(() => void load(), pollMs);
      cleanups.push(() => clearInterval(interval));
    }
    if (refreshOnVisible) {
      const onVis = () => {
        if (document.visibilityState === "visible") void load();
      };
      document.addEventListener("visibilitychange", onVis);
      cleanups.push(() => document.removeEventListener("visibilitychange", onVis));
    }
    return () => {
      mounted.current = false;
      for (const c of cleanups) c();
    };
  }, [load, active, pollMs, refreshOnVisible]);

  return { data, loading, error, reload: load, setData };
}
