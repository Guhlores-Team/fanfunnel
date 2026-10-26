// Shared client poll scheduler: one place that owns "poll every N ms, but not
// while the tab is hidden, and back off when the endpoint keeps failing".
// Framework-free so the scheduling rules are unit-testable (poll.test.ts) with a
// fake clock/visibility source; React callers start it inside an effect and call
// stop() in the cleanup.

/** Where the scheduler gets timers + visibility from. Injected in tests. */
export interface PollEnv {
  isHidden(): boolean;
  /** Subscribe to visibility changes; returns an unsubscribe function. */
  onVisibilityChange(cb: () => void): () => void;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface PollOptions {
  /** Base cadence in ms while healthy and visible. */
  intervalMs: number;
  /** Ceiling for the error backoff. Defaults to {@link defaultMaxDelay}. */
  maxDelayMs?: number;
  /** Run once right away instead of waiting a full interval. Default false. */
  immediate?: boolean;
  /**
   * true (default): refetch every time the tab becomes visible.
   * false: refetch on return only if a poll came due while hidden.
   */
  refreshOnVisible?: boolean;
  /**
   * Skip polls while the tab is hidden. Default true. Only turn off for a loop
   * whose job is to notice things while the user is away (background alerts);
   * the error backoff still applies.
   */
  pauseWhenHidden?: boolean;
  /** One poll. Throwing or resolving `false` counts as a failure. */
  task: () => Promise<unknown>;
  env?: PollEnv;
}

/** Default backoff ceiling: 8x the interval, at most 5 minutes (never below the interval). */
export function defaultMaxDelay(intervalMs: number): number {
  return Math.max(intervalMs, Math.min(intervalMs * 8, 300_000));
}

/** Exponential backoff: interval * 2^failures, capped (cap never below the interval). */
export function backoffDelay(
  intervalMs: number,
  failures: number,
  maxDelayMs: number
): number {
  const cap = Math.max(intervalMs, maxDelayMs);
  const n = Math.max(0, Math.min(failures, 30)); // 2^30 already exceeds any cap
  return Math.min(intervalMs * 2 ** n, cap);
}

function browserEnv(): PollEnv {
  const hasDoc = typeof document !== "undefined";
  return {
    isHidden: () => hasDoc && document.visibilityState === "hidden",
    onVisibilityChange: (cb) => {
      if (!hasDoc) return () => {};
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/**
 * Start polling `task`. Uses a setTimeout chain (not setInterval) so a slow
 * request never overlaps the next one. While hidden, a due poll is skipped and
 * the loop parks with no timer armed; becoming visible resumes it with one
 * refresh. Consecutive failures back off exponentially; a success resets.
 */
export function startPoll(opts: PollOptions): { stop(): void } {
  const {
    intervalMs,
    immediate = false,
    refreshOnVisible = true,
    pauseWhenHidden = true,
    task,
    env = browserEnv(),
  } = opts;
  const maxDelayMs = opts.maxDelayMs ?? defaultMaxDelay(intervalMs);
  const parked = () => pauseWhenHidden && env.isHidden();

  let failures = 0;
  let timer: unknown = null;
  let running = false;
  let paused = false; // a poll came due (or settled) while hidden
  let stopped = false;

  const clear = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (stopped) return;
    timer = env.setTimer(onTimer, backoffDelay(intervalMs, failures, maxDelayMs));
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    paused = false;
    clear();
    try {
      const result = await task();
      failures = result === false ? failures + 1 : 0;
    } catch {
      failures++;
    } finally {
      running = false;
    }
    if (stopped) return;
    if (parked()) paused = true;
    else schedule();
  };

  function onTimer() {
    timer = null;
    if (stopped) return;
    if (parked()) {
      paused = true;
      return;
    }
    void run();
  }

  const unsubscribe = env.onVisibilityChange(() => {
    if (stopped || env.isHidden()) return;
    if (paused || refreshOnVisible) void run();
  });

  if (immediate) void run();
  else schedule();

  return {
    stop() {
      stopped = true;
      clear();
      unsubscribe();
    },
  };
}
