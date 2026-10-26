// Notification bell (RD-7 / behavior spec #1): the pure feed derivation.
//
// Nothing is stored per notification. The server reads the "sources" from the
// tables the dashboard already uses (pending redemptions, unread fan messages,
// limited prizes running low, fans who just spent their last spin) and this
// module turns them into a ranked, capped list. "Unread" is one server-side
// timestamp per account (profiles.notifications_seen_at): an item is unread
// when it happened after the creator last opened the bell. No server imports,
// so the client can share the types.

export type NotificationKind = "win" | "message" | "low_stock" | "out_of_spins";

/** Where an item takes the creator, through the dashboard's in-app navigation. */
export interface NotificationTarget {
  section: "prizes" | "inbox" | "editor" | "fans";
  /** Inbox: open this fan's thread. */
  fanId?: string;
  /** Fans: filter the list to this name. */
  fanName?: string;
  /** Wheels: the wheel the prize is on. */
  wheelId?: string;
}

export interface NotificationItem {
  /** Stable per source row (`win:<redemption id>`, `msg:<fan id>`, ...). */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** ISO timestamp the item is ranked and compared to the seen marker by. */
  at: string;
  unread: boolean;
  target: NotificationTarget;
}

export interface NotificationFeed {
  items: NotificationItem[];
  /** Unread items among `items` (what the bell's badge shows). */
  unread: number;
  /** When the creator last opened the bell (null = never). */
  seenAt: string | null;
}

/** The Settings › Notifications toggles (profiles.notify_*). */
export interface FeedPrefs {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}

export interface NotificationSources {
  pendingWins: { id: string; fanName: string; prizeLabel: string; emoji?: string | null; at: string }[];
  /** One row per unread fan→creator message (grouped into threads here). */
  unreadMessages: { fanId: string; fanName: string; body: string; at: string }[];
  /** Limited prizes on live (non-archived) wheels at or under the threshold. */
  lowStock: {
    prizeId: string;
    label: string;
    emoji?: string | null;
    stock: number;
    wheelId: string;
    wheelTitle: string;
    /** When the stock last moved: the prize's latest win, else the wheel's last save. */
    at: string;
  }[];
  /** Fans whose balance hit 0 on a recent spin (at = that spin). */
  outOfSpins: { fanId: string; fanName: string; at: string }[];
}

/** A limited prize is "low" at this many units left (0 = out of stock). */
export const LOW_STOCK_THRESHOLD = 3;
/** Most items the bell lists (newest first). */
export const FEED_LIMIT = 30;
/** Only fans who ran out within this window are listed. */
export const OUT_OF_SPINS_WINDOW_DAYS = 7;

const PREVIEW_CHARS = 120;

/** True when `at` is after the seen marker (everything is unread before the first open). */
export function isUnread(at: string, seenAt: string | null): boolean {
  if (seenAt === null) return true;
  const a = Date.parse(at);
  const s = Date.parse(seenAt);
  if (Number.isNaN(a)) return false;
  if (Number.isNaN(s)) return true;
  return a > s;
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + "…" : flat;
}

// Postgres and the demo store format timestamps differently; compare instants.
const ms = (iso: string) => Date.parse(iso) || 0;

const withEmoji = (label: string, emoji?: string | null) => (emoji ? `${emoji} ${label}` : label);

export function buildNotificationFeed(
  src: NotificationSources,
  seenAt: string | null,
  prefs: FeedPrefs,
  limit: number = FEED_LIMIT
): NotificationFeed {
  const items: Omit<NotificationItem, "unread">[] = [];

  if (prefs.newSpin) {
    for (const w of src.pendingWins) {
      items.push({
        id: `win:${w.id}`,
        kind: "win",
        title: `${w.fanName} won ${withEmoji(w.prizeLabel, w.emoji)}`,
        body: "Waiting for you to fulfil it.",
        at: w.at,
        target: { section: "prizes" },
      });
    }
  }

  if (prefs.messages) {
    const threads = new Map<string, { fanName: string; body: string; at: string; n: number }>();
    for (const m of src.unreadMessages) {
      const t = threads.get(m.fanId);
      if (!t) threads.set(m.fanId, { fanName: m.fanName, body: m.body, at: m.at, n: 1 });
      else {
        t.n++;
        if (ms(m.at) > ms(t.at)) {
          t.at = m.at;
          t.body = m.body;
        }
      }
    }
    for (const [fanId, t] of threads) {
      items.push({
        id: `msg:${fanId}`,
        kind: "message",
        title: t.n > 1 ? `${t.fanName}: ${t.n} new messages` : `New message from ${t.fanName}`,
        body: preview(t.body),
        at: t.at,
        target: { section: "inbox", fanId },
      });
    }
  }

  // Prize stock has no Settings toggle: running out changes what fans can win.
  for (const p of src.lowStock) {
    items.push({
      id: `stock:${p.prizeId}`,
      kind: "low_stock",
      title:
        p.stock <= 0
          ? `${withEmoji(p.label, p.emoji)} is out of stock`
          : `Only ${p.stock} left of ${withEmoji(p.label, p.emoji)}`,
      body:
        p.stock <= 0
          ? `It has left the pool on “${p.wheelTitle}”; the other prizes’ odds renormalize. Restock it to bring it back.`
          : `On “${p.wheelTitle}”. When it hits 0 it leaves the pool.`,
      at: p.at,
      target: { section: "editor", wheelId: p.wheelId },
    });
  }

  if (prefs.lowBalance) {
    for (const f of src.outOfSpins) {
      items.push({
        id: `spins:${f.fanId}`,
        kind: "out_of_spins",
        title: `${f.fanName} is out of spins`,
        body: "Top them up to keep them playing.",
        at: f.at,
        target: { section: "fans", fanName: f.fanName },
      });
    }
  }

  const ranked = items
    .sort((a, b) => ms(b.at) - ms(a.at) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map((it) => ({ ...it, unread: isUnread(it.at, seenAt) }));

  return {
    items: ranked,
    unread: ranked.filter((i) => i.unread).length,
    seenAt,
  };
}
