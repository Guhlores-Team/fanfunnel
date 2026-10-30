import "server-only";

// Web push for creators: turns a server-side event (a recorded win, a fan
// message) into notifications on the creator's devices. Called only through
// runAfterResponse (F7) from the spin and fan-message data paths, so it can't
// delay or break the fan's request.
//
// Authorization: `creatorId` always comes from the server-side spin/message
// row (the fan_passes row the token resolved to), never from client input. The
// service client is used because no creator session exists on a fan's
// request; every read below is filtered to that creator.
//
// What is sent: the bell's own item (F8: loadNotificationSources +
// buildNotificationItems), so push text can't drift from the bell. The
// creator's Settings toggles apply. Each device gets the generic text unless
// that device turned on "Show names and prizes" (D9). One push per event
// (push_log), at most one per thread per PUSH_THROTTLE_MS.
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import {
  buildNotificationItems,
  LOW_STOCK_THRESHOLD,
  type FeedItem,
} from "@/lib/data/notificationFeed";
import { loadNotificationSources } from "@/lib/data/notifications";
import { mockFanPushState, mockGetMyAccount, mockGetNotificationSources } from "@/lib/data/mock";
import {
  mockActivePushDevices,
  mockClaimPushLog,
  mockPushedTagSince,
} from "@/lib/data/mockPush";
import { PUSH_LOG_RETENTION_DAYS, PUSH_MAX_FAILURES, PUSH_THROTTLE_MS } from "./config";
import { isPushConfigured } from "./keys";
import { toPushPayload } from "./payload";
import { deliverAll, type PushTarget } from "./send";
import { fanEngagementAllowed } from "@/lib/play/playGuard";

export type PushEvent =
  | {
      /** A fan's spin was recorded as a win (and a pending redemption). */
      type: "spin";
      fanId: string;
      prizeId: string;
      /** The won prize's stock right after this spin's decrement (null = unlimited). */
      stockAfter: number | null;
      /** Supabase: the spins row id (its redemption is looked up). */
      spinId?: string;
      /** Demo: the redemption id directly. */
      redemptionId?: string;
    }
  | { type: "message"; fanId: string };

export interface NotifyReport {
  sent: number;
  removed: number;
  /** Item keys that were pushed. */
  pushed: string[];
  skipped: { id: string; reason: "duplicate" | "throttled" | "fan_not_engageable" }[];
}

/** What the push engagement gate knows about the fan an item is about. */
export interface FanPushState {
  /** The creator blocked this fan (fans.blocked_at). */
  blocked: boolean;
  /** The fan paused (self-excluded) one of their links with this creator. */
  selfExcluded: boolean;
  /** When the fan's break ends (fans.break_until). */
  breakUntil: string | null;
}

/**
 * The engagement gate for push: no push ABOUT a fan who is blocked or paused a
 * link or is on a break. Unknown state (lookup failed or the fan is gone)
 * fails closed. Every fan item (win, message, out of spins)
 * passes through here; the low-stock item is about a prize, not a fan.
 */
export function pushAboutFanAllowed(fan: FanPushState | null): boolean {
  if (!fan) return false;
  return fanEngagementAllowed(fan);
}

/** True for feed items about one specific fan (everything but low stock). */
export const isAboutFan = (itemId: string) => !itemId.startsWith("stock:");

const EMPTY: NotifyReport = { sent: 0, removed: 0, pushed: [], skipped: [] };

/** One key per EVENT (the item's id plus when it happened), so a thread's next message pushes again but a retry doesn't. */
export const pushLogKey = (item: FeedItem) => `${item.id}@${Date.parse(item.at) || 0}`;

/** Item ids an event may push (the low-stock item only when this spin crossed the line). */
export function wantedItemIds(event: PushEvent, redemptionId: string | null): string[] {
  if (event.type === "message") return [`msg:${event.fanId}`];
  const ids: string[] = [];
  if (redemptionId) ids.push(`win:${redemptionId}`);
  if (event.stockAfter === LOW_STOCK_THRESHOLD || event.stockAfter === 0) ids.push(`stock:${event.prizeId}`);
  ids.push(`spins:${event.fanId}`);
  return ids;
}

type Device = PushTarget & { showDetails: boolean };

interface Backend {
  devices(): Promise<Device[]>;
  items(): Promise<FeedItem[]>;
  redemptionId(): Promise<string | null>;
  fanState(fanId: string): Promise<FanPushState | null>;
  pushedSince(tag: string, sinceMs: number): Promise<boolean>;
  claim(key: string, tag: string): Promise<boolean>;
  prune(): Promise<void>;
}

function demoBackend(event: PushEvent): Backend {
  return {
    devices: async () =>
      mockActivePushDevices().map((d) => ({ id: d.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, showDetails: d.showDetails })),
    items: async () => buildNotificationItems(mockGetNotificationSources(), mockGetMyAccount().notifications),
    redemptionId: async () => (event.type === "spin" ? (event.redemptionId ?? null) : null),
    fanState: async (fanId) => mockFanPushState(fanId),
    pushedSince: async (tag, since) => mockPushedTagSince(tag, since),
    claim: async (key, tag) => mockClaimPushLog(key, tag),
    prune: async () => {},
  };
}

function supabaseBackend(creatorId: string, event: PushEvent): Backend {
  const sb = createServiceClient();
  return {
    devices: async () => {
      const { data, error } = await sb
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth, show_details")
        .eq("user_id", creatorId)
        .lt("failures", PUSH_MAX_FAILURES);
      if (error) throw new Error(`devices: ${error.message}`);
      return ((data ?? []) as { id: string; endpoint: string; p256dh: string; auth: string; show_details: boolean }[]).map(
        (d) => ({ id: d.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, showDetails: d.show_details === true })
      );
    },
    items: async () => {
      const { sources, prefs } = await loadNotificationSources(sb, creatorId);
      return buildNotificationItems(sources, prefs);
    },
    redemptionId: async () => {
      if (event.type !== "spin" || !event.spinId) return null;
      const { data } = await sb
        .from("redemptions")
        .select("id")
        .eq("spin_id", event.spinId)
        .eq("creator_id", creatorId)
        .maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    },
    fanState: async (fanId) => {
      const [fanRes, passRes] = await Promise.all([
        sb.from("fans").select("blocked_at, break_until").eq("id", fanId).eq("creator_id", creatorId).maybeSingle(),
        sb.from("fan_passes").select("self_excluded_at").eq("fan_id", fanId).eq("creator_id", creatorId),
      ]);
      if (fanRes.error || passRes.error || !fanRes.data) return null;
      const passes = (passRes.data ?? []) as { self_excluded_at: string | null }[];
      const fan = fanRes.data as { blocked_at: string | null; break_until: string | null };
      return {
        blocked: !!fan.blocked_at,
        selfExcluded: passes.some((p) => !!p.self_excluded_at),
        breakUntil: fan.break_until,
      };
    },
    pushedSince: async (tag, since) => {
      const { data } = await sb
        .from("push_log")
        .select("item_id")
        .eq("user_id", creatorId)
        .eq("tag", tag)
        .gte("sent_at", new Date(since).toISOString())
        .limit(1);
      return (data ?? []).length > 0;
    },
    claim: async (key, tag) => {
      const { error } = await sb.from("push_log").insert({ user_id: creatorId, item_id: key, tag });
      if (!error) return true;
      if (error.code !== "23505") console.error("push: log insert failed", error.message);
      return false;
    },
    prune: async () => {
      const cutoff = new Date(Date.now() - PUSH_LOG_RETENTION_DAYS * 86_400_000).toISOString();
      await sb.from("push_log").delete().eq("user_id", creatorId).lt("sent_at", cutoff);
    },
  };
}

/**
 * Push this event to the creator's devices. Never throws: a failure is logged
 * (without endpoints or payloads) and the report says nothing was sent.
 */
export async function notifyCreator(creatorId: string, event: PushEvent): Promise<NotifyReport> {
  try {
    if (!isPushConfigured()) return EMPTY;
    const be = isSupabaseConfigured() ? supabaseBackend(creatorId, event) : demoBackend(event);

    // Cheapest check first: most creators have no device registered.
    let devices = await be.devices();
    if (devices.length === 0) return EMPTY;

    const wanted = wantedItemIds(event, await be.redemptionId());
    const byId = new Map((await be.items()).map((i) => [i.id, i]));
    const report: NotifyReport = { sent: 0, removed: 0, pushed: [], skipped: [] };
    let fanAllowed: boolean | undefined;

    for (const id of wanted) {
      if (devices.length === 0) break;
      // Missing = the creator's toggle is off for this kind, or it no longer
      // applies (e.g. already fulfilled). Nothing to push.
      const item = byId.get(id);
      if (!item) continue;
      const key = pushLogKey(item);
      if (isAboutFan(item.id)) {
        fanAllowed ??= pushAboutFanAllowed(await be.fanState(event.fanId));
        if (!fanAllowed) {
          report.skipped.push({ id: key, reason: "fan_not_engageable" });
          continue;
        }
      }
      if (await be.pushedSince(item.id, Date.now() - PUSH_THROTTLE_MS)) {
        report.skipped.push({ id: key, reason: "throttled" });
        continue;
      }
      if (!(await be.claim(key, item.id))) {
        report.skipped.push({ id: key, reason: "duplicate" });
        continue;
      }
      const r = await deliverAll(
        creatorId,
        devices.map((d) => ({ ...d, payload: toPushPayload(item, d.showDetails) }))
      );
      devices = devices.filter((d) => !r.goneIds.includes(d.id));
      report.sent += r.sent;
      report.removed += r.removed;
      report.pushed.push(key);
    }

    if (report.pushed.length > 0 && Math.random() < 0.05) await be.prune().catch(() => {});
    return report;
  } catch (e) {
    console.error("push: notify failed", e instanceof Error ? e.message : "unknown");
    return EMPTY;
  }
}
