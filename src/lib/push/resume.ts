import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";
import { PUSH_MAX_FAILURES } from "./config";

/**
 * OPS3-09: a device paused after PUSH_MAX_FAILURES failures (a wrong VAPID
 * pair, a push service outage) stayed paused until the creator pressed "Send
 * a test" or re-subscribed. The daily maintenance run now gives every paused
 * device one more try: its count drops to one below the cap, so the next real
 * event attempts it; a success resets the count (send.ts), a 404/410 deletes
 * the device, another failure pauses it until the next day. Service role,
 * every row: no creator is named. Returns how many devices were resumed.
 */
export async function resumePausedPushDevices(svc: Pick<ReturnType<typeof createServiceClient>, "from">): Promise<{ resumed: number } | { error: "db_error" }> {
  const { count, error } = await svc
    .from("push_subscriptions")
    .update({ failures: PUSH_MAX_FAILURES - 1 }, { count: "exact" })
    .gte("failures", PUSH_MAX_FAILURES);
  if (error) return { error: "db_error" };
  return { resumed: count ?? 0 };
}
