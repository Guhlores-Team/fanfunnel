// Data layer — A5: the fulfilment queue beyond the overview's newest-200
// window. The dashboard overview keeps showing the newest wins it already
// polls; this server-side, filtered, keyset-paginated read
// (creator_redemption_queue, 0064, SECURITY INVOKER so RLS applies) makes
// every older prize reachable, including the oldest pending one.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { RedemptionItem, RedemptionStatus } from "./types";
import { focusTag } from "./focusTag";
import { isUuid } from "./shared";
import { mockListRedemptionQueue } from "./mock";

export { OVERVIEW_REDEMPTION_WINDOW } from "./queueWindow";
export const QUEUE_PAGE_SIZE = 50;

export interface QueueCursor {
  at: string;
  id: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** "<ISO created_at>|<id>" — the position of the last row a caller holds. */
export function encodeQueueCursor(r: { at: string; id: string }): string {
  return `${r.at}|${r.id}`;
}
export function decodeQueueCursor(raw: string | null | undefined): QueueCursor | null {
  if (!raw) return null;
  const i = raw.lastIndexOf("|");
  if (i <= 0) return null;
  const at = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!SAFE_ID.test(id) || Number.isNaN(Date.parse(at)) || at.length > 40) return null;
  return { at, id };
}

export interface QueuePage {
  items: RedemptionItem[];
  /** Cursor for the next page; null when this was the last one. */
  next: string | null;
}

type QueueRow = {
  id: string;
  status: RedemptionStatus;
  created_at: string;
  notes: string | null;
  due_at: string | null;
  prize_label: string;
  prize_rarity: RedemptionItem["rarity"];
  fan_name: string;
  pool_snapshot: unknown;
  fair_trace: unknown;
  reward_kind: string | null;
  reward_views: number | null;
  reward_last_viewed_at: string | null;
};

function toItem(r: QueueRow): RedemptionItem {
  const kind = r.reward_kind;
  return {
    id: r.id,
    fanName: r.fan_name || "Fan",
    prizeLabel: r.prize_label ?? "Prize",
    rarity: r.prize_rarity ?? "common",
    status: r.status,
    at: r.created_at,
    notes: r.notes,
    dueAt: r.due_at,
    ...(kind === "link" || kind === "text" || kind === "code"
      ? { auto: { kind, views: r.reward_views ?? 0, lastViewedAt: r.reward_last_viewed_at } }
      : {}),
    ...focusTag(r.pool_snapshot, r.fair_trace),
  };
}

/**
 * One page of the creator's prize queue, newest first: optionally one status
 * and a fan/prize search, after `before` (exclusive).
 */
export async function listRedemptionQueue(opts: {
  status?: RedemptionStatus;
  query?: string;
  before?: string | null;
  limit?: number;
}): Promise<QueuePage | { error: "unauthorized" | "bad_request" | "db_error" }> {
  const limit = Math.min(Math.max(1, opts.limit ?? QUEUE_PAGE_SIZE), 100);
  const before = opts.before ? decodeQueueCursor(opts.before) : null;
  if (opts.before && !before) return { error: "bad_request" };
  const query = (opts.query ?? "").trim().slice(0, 100);

  // One extra row tells us whether another page exists.
  let rows: RedemptionItem[];
  if (!isSupabaseConfigured()) {
    rows = mockListRedemptionQueue({ status: opts.status, query, before, limit: limit + 1 });
  } else {
    if (before && !isUuid(before.id)) return { error: "bad_request" };
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return { error: "unauthorized" };
    const { data, error } = await sb.rpc("creator_redemption_queue", {
      p_status: opts.status,
      p_query: query || undefined,
      p_before_at: before?.at,
      p_before_id: before?.id,
      p_limit: limit + 1,
    });
    if (error) return { error: "db_error" };
    rows = ((data ?? []) as unknown as QueueRow[]).map(toItem);
  }
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? encodeQueueCursor(items[items.length - 1]) : null };
}
