import assert from "node:assert";
import { startPoll, type PollEnv } from "./poll";
import { createRealtimeFallback, type ChannelStatus } from "./realtimeFallback";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Timers are only counted, never fired: the question is whether anything is
// still armed after cleanup.
function countingEnv() {
  const timers = new Set<number>();
  let next = 1;
  const env: PollEnv = {
    isHidden: () => false,
    onVisibilityChange: () => () => {},
    setTimer: () => {
      const id = next++;
      timers.add(id);
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  };
  return { env, armed: () => timers.size };
}

// Mirrors supabase-js: removeChannel() leaves the channel, which synchronously
// fires the subscribe callback with "CLOSED".
function fakeSupabase() {
  let cb: ((s: ChannelStatus) => void) | null = null;
  return {
    subscribe(fn: (s: ChannelStatus) => void) {
      cb = fn;
    },
    emit(s: ChannelStatus) {
      cb?.(s);
    },
    removeChannel() {
      cb?.("CLOSED");
    },
  };
}

// Same cleanup order as InboxPanel's effect: dispose, then removeChannel.
{
  const { env, armed } = countingEnv();
  let starts = 0;
  const fb = createRealtimeFallback(() => {
    starts++;
    return startPoll({ intervalMs: 8000, task: async () => true, env });
  });
  const sb = fakeSupabase();
  sb.subscribe((s) => fb.onStatus(s));

  sb.emit("SUBSCRIBED");
  check("healthy channel -> no fallback poll", !fb.polling && armed() === 0);

  sb.emit("CHANNEL_ERROR");
  check("channel error -> fallback poll starts", fb.polling && armed() === 1);
  sb.emit("TIMED_OUT");
  check("repeat errors don't stack polls", starts === 1 && armed() === 1);

  sb.emit("SUBSCRIBED");
  check("recovery -> fallback poll stops", !fb.polling && armed() === 0);

  sb.emit("CLOSED");
  check("closed while mounted -> fallback poll restarts", fb.polling && armed() === 1);

  // Unmount.
  fb.dispose();
  sb.removeChannel();
  check("CLOSED fired by removeChannel after cleanup starts nothing", starts === 2);
  check("no poll running after unmount", !fb.polling);
  check("no timer armed after unmount", armed() === 0);

  sb.emit("CHANNEL_ERROR");
  check("late status events after unmount stay ignored", armed() === 0 && starts === 2);
}

// Unmount while healthy: the common case.
{
  const { env, armed } = countingEnv();
  const fb = createRealtimeFallback(() => startPoll({ intervalMs: 8000, task: async () => true, env }));
  const sb = fakeSupabase();
  sb.subscribe((s) => fb.onStatus(s));
  sb.emit("SUBSCRIBED");
  fb.dispose();
  sb.removeChannel();
  check("healthy unmount leaves nothing armed", !fb.polling && armed() === 0);
}

console.log(`realtimeFallback: ${passed} checks passed`);
