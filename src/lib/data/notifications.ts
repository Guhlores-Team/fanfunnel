// Data layer — the notification bell (RD-7 / behavior spec #1).
//
// The feed is DERIVED on every read from tables the dashboard already uses; no
// notification rows are stored. Every read goes through the caller's own
// session client (anon key + RLS, where can_act_for('view') gates each table)
// AND is filtered to `creator_id = auth user`, so a creator only ever sees
// their own account. The only write is the per-account seen marker, through
// the SECURITY DEFINER `set_notifications_seen()` RPC (migration 0043) —
// creators can never UPDATE their profiles row directly.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import {
  mockGetNotificationSources,
  mockGetNotificationsSeenAt,
  mockGetMyAccount,
  mockSetNotificationsSeen,
} from "./mock";
import {
  buildNotificationFeed,
  FEED_LIMIT,
  LOW_STOCK_THRESHOLD,
  OUT_OF_SPINS_WINDOW_DAYS,
  type FeedPrefs,
  type NotificationFeed,
  type NotificationSources,
} from "./notificationFeed";

export type {
  NotificationFeed,
  NotificationItem,
  NotificationKind,
  NotificationTarget,
} from "./notificationFeed";

type FanRef = { display_name: string | null; handle: string | null } | null;
const fanLabel = (f: FanRef) => f?.display_name ?? f?.handle ?? "Fan";

const ALL_ON: FeedPrefs = { newSpin: true, lowBalance: true, messages: true };

/**
 * The signed-in creator's notification feed, or null when signed out (the
 * route answers 401). A source that fails to load is logged and left out
 * rather than failing the whole bell.
 */
export async function getNotifications(): Promise<NotificationFeed | null> {
  if (!isSupabaseConfigured()) {
    return buildNotificationFeed(
      mockGetNotificationSources(),
      mockGetNotificationsSeenAt(),
      mockGetMyAccount().notifications
    );
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const uid = user.id;

  const since = new Date(Date.now() - OUT_OF_SPINS_WINDOW_DAYS * 86_400_000).toISOString();
  const [seenRes, prefsRes, winsRes, msgRes, wheelsRes, passesRes] = await Promise.all([
    sb.from("profiles").select("notifications_seen_at").eq("id", uid).maybeSingle(),
    // Separate read: an environment missing the notify_* columns (see 0025)
    // must still get a bell, with every toggle treated as on.
    sb
      .from("profiles")
      .select("notify_new_spin, notify_low_balance, notify_messages")
      .eq("id", uid)
      .maybeSingle(),
    sb
      .from("redemptions")
      .select("id, created_at, spin:spins(prize_label, fan:fans(display_name, handle))")
      .eq("creator_id", uid)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(FEED_LIMIT),
    sb
      .from("messages")
      .select("fan_id, body, created_at, fan:fans(display_name, handle)")
      .eq("creator_id", uid)
      .eq("sender", "fan")
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    sb
      .from("wheels")
      .select("id, title, updated_at")
      .eq("creator_id", uid)
      .is("archived_at", null),
    sb
      .from("fan_passes")
      .select("fan_id, last_spin_at, self_excluded_at")
      .eq("creator_id", uid)
      .gte("last_spin_at", since)
      .order("last_spin_at", { ascending: false })
      .limit(200),
  ]);

  const failed = (what: string, error: { message: string } | null) => {
    if (error) console.error("getNotifications: source failed", { what, error: error.message });
    return !!error;
  };

  const seenAt =
    (seenRes.data as { notifications_seen_at: string | null } | null)?.notifications_seen_at ?? null;
  failed("seen", seenRes.error);
  const p = prefsRes.error
    ? null
    : (prefsRes.data as {
        notify_new_spin: boolean | null;
        notify_low_balance: boolean | null;
        notify_messages: boolean | null;
      } | null);
  const prefs: FeedPrefs = p
    ? {
        newSpin: p.notify_new_spin ?? true,
        lowBalance: p.notify_low_balance ?? true,
        messages: p.notify_messages ?? true,
      }
    : ALL_ON;

  const sources: NotificationSources = {
    pendingWins: [],
    unreadMessages: [],
    lowStock: [],
    outOfSpins: [],
  };

  if (!failed("wins", winsRes.error)) {
    const rows = (winsRes.data ?? []) as unknown as {
      id: string;
      created_at: string;
      spin: { prize_label: string; fan: FanRef } | null;
    }[];
    sources.pendingWins = rows.map((r) => ({
      id: r.id,
      fanName: fanLabel(r.spin?.fan ?? null),
      prizeLabel: r.spin?.prize_label ?? "Prize",
      at: r.created_at,
    }));
  }

  if (!failed("messages", msgRes.error)) {
    const rows = (msgRes.data ?? []) as unknown as {
      fan_id: string;
      body: string;
      created_at: string;
      fan: FanRef;
    }[];
    sources.unreadMessages = rows.map((m) => ({
      fanId: m.fan_id,
      fanName: fanLabel(m.fan),
      body: m.body,
      at: m.created_at,
    }));
  }

  // Low stock: limited prizes on the creator's live wheels, timed by the
  // prize's latest win (that is when stock moved), else the wheel's last save.
  if (!failed("wheels", wheelsRes.error)) {
    const wheels = (wheelsRes.data ?? []) as { id: string; title: string; updated_at: string }[];
    if (wheels.length > 0) {
      const { data: prizeRows, error } = await sb
        .from("prizes")
        .select("id, label, emoji, stock, wheel_id")
        .in(
          "wheel_id",
          wheels.map((w) => w.id)
        )
        .not("stock", "is", null)
        .lte("stock", LOW_STOCK_THRESHOLD)
        .limit(FEED_LIMIT);
      if (!failed("prizes", error)) {
        const prizes = (prizeRows ?? []) as {
          id: string;
          label: string;
          emoji: string | null;
          stock: number;
          wheel_id: string;
        }[];
        const lastWin = new Map<string, string>();
        if (prizes.length > 0) {
          const { data: spinRows, error: spinErr } = await sb
            .from("spins")
            .select("prize_id, created_at")
            .eq("creator_id", uid)
            .in(
              "prize_id",
              prizes.map((x) => x.id)
            )
            .order("created_at", { ascending: false })
            .limit(200);
          if (!failed("spins", spinErr)) {
            for (const s of (spinRows ?? []) as { prize_id: string; created_at: string }[]) {
              if (!lastWin.has(s.prize_id)) lastWin.set(s.prize_id, s.created_at);
            }
          }
        }
        const byId = new Map(wheels.map((w) => [w.id, w]));
        sources.lowStock = prizes.flatMap((x) => {
          const w = byId.get(x.wheel_id);
          if (!w) return [];
          return [
            {
              prizeId: x.id,
              label: x.label,
              emoji: x.emoji,
              stock: x.stock,
              wheelId: w.id,
              wheelTitle: w.title,
              at: lastWin.get(x.id) ?? w.updated_at,
            },
          ];
        });
      }
    }
  }

  // Out of spins: fans who spun recently and now have 0 left. A fan who paused
  // (self-excluded) a link or is blocked is never suggested for a top-up.
  if (!failed("passes", passesRes.error)) {
    const passes = (passesRes.data ?? []) as {
      fan_id: string;
      last_spin_at: string;
      self_excluded_at: string | null;
    }[];
    const lastSpin = new Map<string, string>();
    const excluded = new Set<string>();
    for (const r of passes) {
      if (r.self_excluded_at) excluded.add(r.fan_id);
      const prev = lastSpin.get(r.fan_id);
      if (!prev || Date.parse(r.last_spin_at) > Date.parse(prev)) lastSpin.set(r.fan_id, r.last_spin_at);
    }
    const ids = [...lastSpin.keys()].filter((id) => !excluded.has(id));
    if (ids.length > 0) {
      const { data: fanRows, error } = await sb
        .from("fans")
        .select("id, display_name, handle")
        .eq("creator_id", uid)
        .in("id", ids)
        .eq("spins_remaining", 0)
        .is("blocked_at", null);
      if (!failed("fans", error)) {
        sources.outOfSpins = ((fanRows ?? []) as { id: string; display_name: string | null; handle: string | null }[]).map(
          (f) => ({ fanId: f.id, fanName: fanLabel(f), at: lastSpin.get(f.id)! })
        );
      }
    }
  }

  return buildNotificationFeed(sources, seenAt, prefs);
}

/** Mark everything in the bell as seen (stamps now() on the caller's own profile). */
export async function markNotificationsSeen(): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetNotificationsSeen();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.rpc("set_notifications_seen");
  if (error) {
    console.error("markNotificationsSeen: rpc failed", error.message);
    return { error: "db_error" };
  }
  return { ok: true };
}
