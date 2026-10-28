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

// ---------------------------------------------------------------------------
// F8: one notification item builder. The bell (this feed), the Inbox and web
// push (src/lib/push/notify.ts) all turn a source row into an item HERE, so
// the text can never drift between them.
// ---------------------------------------------------------------------------

/** An item before the per-reader unread flag is applied. */
export type FeedItem = Omit<NotificationItem, "unread">;

/** One unread fan→creator thread (its newest message, and how many are unread). */
export interface MessageThreadSource {
  fanId: string;
  fanName: string;
  body: string;
  at: string;
  count: number;
}

export interface NotificationSourceFor {
  win: NotificationSources["pendingWins"][number];
  message: MessageThreadSource;
  low_stock: NotificationSources["lowStock"][number];
  out_of_spins: NotificationSources["outOfSpins"][number];
}

/**
 * The Settings toggle that gates each kind (null = always on). Prize stock has
 * no toggle: running out changes what fans can win.
 */
export const KIND_PREF: Record<NotificationKind, keyof FeedPrefs | null> = {
  win: "newSpin",
  message: "messages",
  low_stock: null,
  out_of_spins: "lowBalance",
};

export function kindEnabled(kind: NotificationKind, prefs: FeedPrefs): boolean {
  const pref = KIND_PREF[kind];
  return pref === null || prefs[pref];
}

/** Build the item for one source row. The only place item text is written. */
export function toNotificationItem<K extends NotificationKind>(
  kind: K,
  source: NotificationSourceFor[K]
): FeedItem {
  switch (kind) {
    case "win": {
      const w = source as NotificationSourceFor["win"];
      return {
        id: `win:${w.id}`,
        kind: "win",
        title: `${w.fanName} won ${withEmoji(w.prizeLabel, w.emoji)}`,
        body: "Waiting for you to fulfil it.",
        at: w.at,
        target: { section: "prizes" },
      };
    }
    case "message": {
      const t = source as MessageThreadSource;
      return {
        id: `msg:${t.fanId}`,
        kind: "message",
        title: t.count > 1 ? `${t.fanName}: ${t.count} new messages` : `New message from ${t.fanName}`,
        body: preview(t.body),
        at: t.at,
        target: { section: "inbox", fanId: t.fanId },
      };
    }
    case "low_stock": {
      const p = source as NotificationSourceFor["low_stock"];
      return {
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
      };
    }
    default: {
      const f = source as NotificationSourceFor["out_of_spins"];
      return {
        id: `spins:${f.fanId}`,
        kind: "out_of_spins",
        title: `${f.fanName} is out of spins`,
        body: "Top them up to keep them playing.",
        at: f.at,
        target: { section: "fans", fanName: f.fanName },
      };
    }
  }
}

/** Group unread fan messages into one thread per fan (newest message wins). */
export function groupMessageThreads(messages: NotificationSources["unreadMessages"]): MessageThreadSource[] {
  const threads = new Map<string, MessageThreadSource>();
  for (const m of messages) {
    const t = threads.get(m.fanId);
    if (!t) threads.set(m.fanId, { fanId: m.fanId, fanName: m.fanName, body: m.body, at: m.at, count: 1 });
    else {
      t.count++;
      if (ms(m.at) > ms(t.at)) {
        t.at = m.at;
        t.body = m.body;
      }
    }
  }
  return [...threads.values()];
}

/** Every item the sources produce under the creator's toggles (unranked). */
export function buildNotificationItems(src: NotificationSources, prefs: FeedPrefs): FeedItem[] {
  const items: FeedItem[] = [];
  if (kindEnabled("win", prefs)) for (const w of src.pendingWins) items.push(toNotificationItem("win", w));
  if (kindEnabled("message", prefs))
    for (const t of groupMessageThreads(src.unreadMessages)) items.push(toNotificationItem("message", t));
  if (kindEnabled("low_stock", prefs)) for (const p of src.lowStock) items.push(toNotificationItem("low_stock", p));
  if (kindEnabled("out_of_spins", prefs))
    for (const f of src.outOfSpins) items.push(toNotificationItem("out_of_spins", f));
  return items;
}

export function buildNotificationFeed(
  src: NotificationSources,
  seenAt: string | null,
  prefs: FeedPrefs,
  limit: number = FEED_LIMIT
): NotificationFeed {
  const ranked = buildNotificationItems(src, prefs)
    .sort((a, b) => ms(b.at) - ms(a.at) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map((it) => ({ ...it, unread: isUnread(it.at, seenAt) }));

  return {
    items: ranked,
    unread: ranked.filter((i) => i.unread).length,
    seenAt,
  };
}
