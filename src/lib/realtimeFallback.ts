// Poll fallback for a Supabase Realtime channel: poll while the channel isn't
// healthy, stop once it reaches SUBSCRIBED. Framework-free so the status/cleanup
// ordering is unit-testable (realtimeFallback.test.ts).

export type ChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED" | string;

export function createRealtimeFallback(startFallbackPoll: () => { stop(): void }) {
  let poll: { stop(): void } | null = null;
  // removeChannel() synchronously fires the status callback with "CLOSED";
  // without this guard that restarts a poll nothing will ever stop.
  let disposed = false;

  const stop = () => {
    if (poll !== null) {
      poll.stop();
      poll = null;
    }
  };

  return {
    /** Pass as (or call from) the channel's `.subscribe()` status callback. */
    onStatus(status: ChannelStatus) {
      if (disposed) return;
      if (status === "SUBSCRIBED") stop();
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        if (poll === null) poll = startFallbackPoll();
      }
    },
    /** Call in the effect cleanup, BEFORE removing the channel. */
    dispose() {
      disposed = true;
      stop();
    },
    get polling() {
      return poll !== null;
    },
  };
}
