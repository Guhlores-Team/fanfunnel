// Win-back list maths (RM-5), shared by both data paths (mock + Supabase) so
// they can't disagree. Pure: the caller passes the fans, the outreach log and
// "now".
import {
  WINBACK_CONTACT_COOLDOWN_DAYS,
  WINBACK_LIST_LIMIT,
  WINBACK_MODE,
  WINBACK_QUIET_DAYS,
  WINBACK_RECENT_LIMIT,
  WINBACK_RESULTS_WINDOW_DAYS,
  type WinbackMode,
} from "./config";

const DAY = 86_400_000;

/** One outreach log row (fan_outreach). contactedAt null = a snooze only. */
export interface OutreachRow {
  fanId: string;
  contactedAt: string | null;
  snoozedUntil: string | null;
}

/** The fields of a CRM row the list needs. */
export interface WinbackCandidate {
  fanId: string;
  name: string;
  totalSpent: number;
  daysSince: number | null;
  lastActiveAt: string | null;
  /** The link to offer; null when the fan fails the engagement gate (F6). */
  primaryToken: string | null;
}

export interface WinbackContact {
  fanId: string;
  name: string;
  contactedAt: string;
  /** Whole days since contactedAt, as of the read. */
  daysAgo: number;
  /** The fan spun again after this contact. */
  cameBack: boolean;
}

export interface WinbackStats {
  /** Fans contacted in the last WINBACK_RESULTS_WINDOW_DAYS days. */
  contacted: number;
  /** …of whom spun again after their latest contact. */
  cameBack: number;
  /** The most recent contacts, newest first. */
  recent: WinbackContact[];
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/**
 * The quiet paying fans to win back, highest spend first. A fan is left out
 * when they fail the engagement gate (no link to offer), have spent nothing,
 * played within WINBACK_QUIET_DAYS, were contacted within
 * WINBACK_CONTACT_COOLDOWN_DAYS, or are snoozed.
 */
export function selectDormant<T extends WinbackCandidate>(fans: T[], outreach: OutreachRow[], now: number): T[] {
  const lastContact = new Map<string, number>();
  const snoozedUntil = new Map<string, number>();
  for (const o of outreach) {
    const c = ms(o.contactedAt);
    if (!Number.isNaN(c) && c > (lastContact.get(o.fanId) ?? -Infinity)) lastContact.set(o.fanId, c);
    const s = ms(o.snoozedUntil);
    if (!Number.isNaN(s) && s > (snoozedUntil.get(o.fanId) ?? -Infinity)) snoozedUntil.set(o.fanId, s);
  }
  const cooldownStart = now - WINBACK_CONTACT_COOLDOWN_DAYS * DAY;
  return fans
    .filter((f) => f.totalSpent > 0)
    .filter((f) => f.primaryToken !== null)
    .filter((f) => f.daysSince !== null && f.daysSince >= WINBACK_QUIET_DAYS)
    .filter((f) => (lastContact.get(f.fanId) ?? -Infinity) <= cooldownStart)
    .filter((f) => (snoozedUntil.get(f.fanId) ?? -Infinity) <= now)
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, WINBACK_LIST_LIMIT);
}

/**
 * "6 contacted · 2 came back": each fan contacted in the results window
 * counts once (at their latest contact); they came back when their last spin
 * is after that contact. Derived, so it needs no extra writes.
 */
export function winbackStats(fans: WinbackCandidate[], outreach: OutreachRow[], now: number): WinbackStats {
  const windowStart = now - WINBACK_RESULTS_WINDOW_DAYS * DAY;
  const latest = new Map<string, string>();
  for (const o of outreach) {
    const c = ms(o.contactedAt);
    if (Number.isNaN(c) || c < windowStart || c > now) continue;
    const prev = latest.get(o.fanId);
    if (!prev || c > ms(prev)) latest.set(o.fanId, o.contactedAt!);
  }
  const byId = new Map(fans.map((f) => [f.fanId, f]));
  const contacts: WinbackContact[] = [];
  for (const [fanId, contactedAt] of latest) {
    const fan = byId.get(fanId);
    if (!fan) continue; // deleted since
    const last = ms(fan.lastActiveAt);
    contacts.push({
      fanId,
      name: fan.name,
      contactedAt,
      daysAgo: Math.max(0, Math.floor((now - ms(contactedAt)) / DAY)),
      cameBack: !Number.isNaN(last) && last > ms(contactedAt),
    });
  }
  contacts.sort((a, b) => ms(b.contactedAt) - ms(a.contactedAt));
  return {
    contacted: contacts.length,
    cameBack: contacts.filter((c) => c.cameBack).length,
    recent: contacts.slice(0, WINBACK_RECENT_LIMIT),
  };
}

/**
 * Today › "Needs you now" card for the quiet paying fans (null when there are
 * none). D6 (b): it opens the win-back queue; in "copy" mode it copies the top
 * fan's link, as it did before RM-5.
 */
export function winbackAutopilotCard(
  dormant: { name: string; daysSince: number | null; primaryToken: string | null }[],
  mode: WinbackMode = WINBACK_MODE,
) {
  if (dormant.length === 0) return null;
  const d = dormant[0];
  const n = dormant.length;
  const queue = mode === "queue";
  return {
    key: "winback",
    icon: "💤",
    title: `${n} paying ${n === 1 ? "fan has" : "fans have"} gone quiet`,
    body: queue
      ? `${d.name} last played ${d.daysSince}d ago. Work through your win-back list: each message is filled in and copied for you to paste.`
      : `${d.name} last played ${d.daysSince}d ago. The cheapest revenue is a fan you already won — send a fresh link.`,
    cta: queue ? "Start win-back" : "Win them back",
    action: queue ? ({ kind: "open_winback" } as const) : ({ kind: "copy_link", token: d.primaryToken } as const),
    score: 88,
  };
}

/** "Contacted today" / "Contacted 3d ago" (from WinbackContact.daysAgo). */
export function contactedLabel(daysAgo: number): string {
  if (!Number.isFinite(daysAgo) || daysAgo <= 0) return "Contacted today";
  return `Contacted ${daysAgo}d ago`;
}
