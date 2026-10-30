import assert from "node:assert";
import { backoffDelay, defaultMaxDelay, startPoll, type PollEnv } from "./poll";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// A hand-driven clock + visibility source so the scheduler runs with no DOM
// and no real timers. `advance(ms)` fires every timer due within that window.
function fakeEnv() {
  let t = 0;
  let hidden = false;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const listeners = new Set<() => void>();
  const env: PollEnv = {
    isHidden: () => hidden,
    onVisibilityChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setTimer: (cb, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, cb });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  };
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    env,
    pending: () => timers.size,
    nextDelay: () => {
      const ats = [...timers.values()].map((x) => x.at - t);
      return ats.length ? Math.min(...ats) : null;
    },
    listenerCount: () => listeners.size,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].cb();
        await flush();
      }
      t = end;
      await flush();
    },
    async setHidden(h: boolean) {
      hidden = h;
      for (const l of [...listeners]) l();
      await flush();
    },
  };
}

async function main() {
  // --- backoffDelay ----------------------------------------------------------
  {
    check("no failures -> base interval", backoffDelay(10_000, 0, 80_000) === 10_000);
    check("1 failure doubles", backoffDelay(10_000, 1, 80_000) === 20_000);
    check("3 failures = 8x", backoffDelay(10_000, 3, 80_000) === 80_000);
    check("capped at max", backoffDelay(10_000, 10, 80_000) === 80_000);
    check("huge failure count stays finite + capped", backoffDelay(10_000, 5000, 80_000) === 80_000);
    check("cap never below the base interval", backoffDelay(10_000, 2, 1_000) === 10_000);
    check("negative failures treated as 0", backoffDelay(10_000, -1, 80_000) === 10_000);
    check("default cap is 8x base", defaultMaxDelay(6_000) === 48_000);
    check("default cap tops out at 5 min", defaultMaxDelay(60_000) === 300_000);
    check("default cap never below base", defaultMaxDelay(600_000) === 600_000);
  }

  // --- polls on its interval while visible ----------------------------------
  {
    const f = fakeEnv();
    let runs = 0;
    const p = startPoll({ intervalMs: 1000, task: async () => void runs++, env: f.env });
    check("not immediate by default", runs === 0);
    await f.advance(1000);
    check("runs after one interval", runs === 1);
    await f.advance(3000);
    check("keeps polling on the interval", runs === 4);
    p.stop();
    await f.advance(5000);
    check("stop() halts polling", runs === 4);
    check("stop() clears the timer", f.pending() === 0);
    check("stop() removes the visibility listener", f.listenerCount() === 0);
  }

  // --- immediate ------------------------------------------------------------
  {
    const f = fakeEnv();
    let runs = 0;
    const p = startPoll({ intervalMs: 1000, immediate: true, task: async () => void runs++, env: f.env });
    await f.advance(0);
    check("immediate runs at start", runs === 1);
    check("then schedules the next poll", f.nextDelay() === 1000);
    p.stop();
  }

  // --- pauses while hidden, refreshes once on return ------------------------
  {
    const f = fakeEnv();
    let runs = 0;
    const p = startPoll({
      intervalMs: 1000,
      refreshOnVisible: false,
      task: async () => void runs++,
      env: f.env,
    });
    await f.advance(1000);
    check("visible tick runs", runs === 1);
    await f.setHidden(true);
    await f.advance(60_000);
    check("no requests while hidden", runs === 1);
    check("no timer left armed while paused", f.pending() === 0);
    await f.setHidden(false);
    check("missed poll -> exactly one refresh on return", runs === 2);
    await f.advance(1000);
    check("normal cadence resumes after return", runs === 3);
    p.stop();
  }

  // --- refreshOnVisible:false skips a refresh when nothing was missed -------
  {
    const f = fakeEnv();
    let runs = 0;
    const p = startPoll({
      intervalMs: 10_000,
      refreshOnVisible: false,
      task: async () => void runs++,
      env: f.env,
    });
    await f.advance(2000);
    await f.setHidden(true);
    await f.advance(1000);
    await f.setHidden(false);
    check("brief hide with no missed tick -> no extra request", runs === 0);
    await f.advance(7000);
    check("original schedule still fires", runs === 1);
    p.stop();
  }

  // --- refreshOnVisible (default) always refreshes on return ----------------
  {
    const f = fakeEnv();
    let runs = 0;
    const p = startPoll({ intervalMs: 10_000, task: async () => void runs++, env: f.env });
    await f.advance(2000);
    await f.setHidden(true);
    await f.advance(1000);
    await f.setHidden(false);
    check("refreshOnVisible refetches on every return", runs === 1);
    check("and restarts the interval from that refresh", f.nextDelay() === 10_000);
    await f.setHidden(true);
    await f.setHidden(true); // repeated hidden events are ignored
    check("hidden events never trigger a request", runs === 1);
    p.stop();
  }

  // --- exponential backoff on consecutive errors, reset on success ----------
  {
    const f = fakeEnv();
    let runs = 0;
    let fail = true;
    const p = startPoll({
      intervalMs: 1000,
      maxDelayMs: 8000,
      task: async () => {
        runs++;
        if (fail) throw new Error("boom");
      },
      env: f.env,
    });
    await f.advance(1000);
    check("first failure", runs === 1);
    check("1 failure -> 2s", f.nextDelay() === 2000);
    await f.advance(2000);
    check("2 failures -> 4s", f.nextDelay() === 4000);
    await f.advance(4000);
    check("3 failures -> 8s (cap)", f.nextDelay() === 8000);
    await f.advance(8000);
    check("stays at cap", f.nextDelay() === 8000);
    fail = false;
    await f.advance(8000);
    check("success resets to the base interval", f.nextDelay() === 1000);
    check("ran 5 times total", runs === 5);
    p.stop();
  }

  // --- a task resolving `false` counts as a failure --------------------------
  {
    const f = fakeEnv();
    const p = startPoll({ intervalMs: 1000, task: async () => false, env: f.env });
    await f.advance(1000);
    check("false -> backoff", f.nextDelay() === 2000);
    p.stop();
  }

  // --- slow requests never overlap ------------------------------------------
  {
    const f = fakeEnv();
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const p = startPoll({
      intervalMs: 1000,
      immediate: true,
      task: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((r) => {
          release = () => {
            inFlight--;
            r();
          };
        });
      },
      env: f.env,
    });
    await f.advance(0);
    check("no timer armed while a request is in flight", f.pending() === 0);
    await f.setHidden(true);
    await f.setHidden(false); // a visible refresh during the in-flight request
    check("visible refresh doesn't stack a second request", maxInFlight === 1);
    (release as unknown as () => void)();
    await f.advance(0);
    check("next poll is scheduled after the slow one settles", f.nextDelay() === 1000);
    p.stop();
  }

  // --- pauseWhenHidden:false keeps polling in the background (with backoff)
  {
    const f = fakeEnv();
    let runs = 0;
    const p = startPoll({
      intervalMs: 1000,
      pauseWhenHidden: false,
      refreshOnVisible: false,
      task: async () => {
        runs++;
        throw new Error("down");
      },
      env: f.env,
    });
    await f.setHidden(true);
    await f.advance(1000 + 2000 + 4000);
    check("background poll keeps running while hidden", runs === 3);
    check("and still backs off on errors", f.nextDelay() === 8000);
    await f.setHidden(false);
    check("no extra refresh on return (nothing was missed)", runs === 3);
    p.stop();
  }

  // --- stopped mid-flight: no reschedule -------------------------------------
  {
    const f = fakeEnv();
    let release: (() => void) | null = null;
    const p = startPoll({
      intervalMs: 1000,
      immediate: true,
      task: () => new Promise<void>((r) => (release = r)),
      env: f.env,
    });
    await f.advance(0);
    p.stop();
    (release as unknown as () => void)();
    await f.advance(0);
    check("a request that settles after stop() doesn't re-arm", f.pending() === 0);
  }

  // --- request settling while hidden pauses instead of re-arming ------------
  {
    const f = fakeEnv();
    let runs = 0;
    let release: (() => void) | null = null;
    const p = startPoll({
      intervalMs: 1000,
      immediate: true,
      refreshOnVisible: false,
      task: () => {
        runs++;
        return new Promise<void>((r) => (release = r));
      },
      env: f.env,
    });
    await f.advance(0);
    await f.setHidden(true);
    (release as unknown as () => void)();
    await f.advance(0);
    check("settled while hidden -> paused (no timer)", f.pending() === 0);
    await f.setHidden(false);
    check("resumes with one refresh on return", runs === 2);
    p.stop();
  }

  console.log(`poll: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
