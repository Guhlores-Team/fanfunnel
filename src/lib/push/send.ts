import "server-only";

// Delivers one push to one device, and records how it went. Server-only: it
// holds the VAPID private key (via keys.ts) and, for the delivery bookkeeping,
// the service client.
//
// Demo mode (no Supabase) never contacts a push service: the simulated one in
// mockPush.ts records the delivery instead.
import { createHash } from "node:crypto";
import webpush from "web-push";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { mockDeliverPush, mockRecordPushOutcome } from "@/lib/data/mockPush";
import { isAllowedPushEndpoint, PUSH_TIMEOUT_MS, PUSH_TTL_SECONDS } from "./config";
import { vapidKeys } from "./keys";
import type { PushPayload } from "./payload";

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** ok: delivered. gone: the browser unsubscribed (404/410), delete the device. failed: count it. */
export type DeliveryOutcome = "ok" | "gone" | "failed";

/** The Web Push Topic header: ≤32 URL-safe base64 chars, one per tag, so a newer push replaces an undelivered older one. */
export const topicFor = (tag: string) => createHash("sha256").update(tag).digest("base64url").slice(0, 32);

export async function deliverPush(target: PushTarget, payload: PushPayload): Promise<DeliveryOutcome> {
  const keys = vapidKeys();
  if (!keys) return "failed";
  // Re-checked here (not only at subscribe time): the server POSTs to this URL.
  if (!isAllowedPushEndpoint(target.endpoint)) return "gone";

  if (!isSupabaseConfigured()) {
    const status = mockDeliverPush(target, payload);
    return status === 404 || status === 410 ? "gone" : status < 300 ? "ok" : "failed";
  }

  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: PUSH_TTL_SECONDS,
        timeout: PUSH_TIMEOUT_MS,
        topic: topicFor(payload.tag),
        urgency: "normal",
      }
    );
    return "ok";
  } catch (e) {
    const status = (e as { statusCode?: unknown })?.statusCode;
    if (status === 404 || status === 410) return "gone";
    // Never log the endpoint (a bearer capability for that device) or keys.
    console.error("push: delivery failed", { status: typeof status === "number" ? status : "network" });
    return "failed";
  }
}

/**
 * Delivery bookkeeping on a device row the caller already resolved for
 * `userId` server-side: a 404/410 deletes it; a success clears the failure
 * count; a failure bumps it (PUSH_MAX_FAILURES pauses the device). Scoped by
 * id AND user_id so it can only touch that account's row.
 */
export async function recordOutcome(userId: string, deviceId: string, outcome: DeliveryOutcome): Promise<void> {
  if (!isSupabaseConfigured()) return mockRecordPushOutcome(deviceId, outcome);
  const sb = createServiceClient();
  const row = sb.from("push_subscriptions");
  if (outcome === "gone") {
    await row.delete().eq("id", deviceId).eq("user_id", userId);
    return;
  }
  if (outcome === "ok") {
    await row.update({ failures: 0, last_success_at: new Date().toISOString() }).eq("id", deviceId).eq("user_id", userId);
    return;
  }
  const { data } = await sb
    .from("push_subscriptions")
    .select("failures")
    .eq("id", deviceId)
    .eq("user_id", userId)
    .maybeSingle();
  const failures = ((data as { failures?: number } | null)?.failures ?? 0) + 1;
  await row.update({ failures }).eq("id", deviceId).eq("user_id", userId);
}

/** Send to every target in parallel (each with its own timeout) and record each outcome. */
export async function deliverAll(
  userId: string,
  targets: (PushTarget & { payload: PushPayload })[]
): Promise<{ sent: number; removed: number; failed: number; goneIds: string[] }> {
  const outcomes = await Promise.all(
    targets.map(async (t) => {
      const outcome = await deliverPush(t, t.payload);
      try {
        await recordOutcome(userId, t.id, outcome);
      } catch {
        /* bookkeeping is best-effort */
      }
      return outcome;
    })
  );
  return {
    sent: outcomes.filter((o) => o === "ok").length,
    removed: outcomes.filter((o) => o === "gone").length,
    failed: outcomes.filter((o) => o === "failed").length,
    goneIds: targets.filter((_, i) => outcomes[i] === "gone").map((t) => t.id),
  };
}
