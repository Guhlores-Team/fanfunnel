// Data layer — RM-3 visit glow (fan_checkins, migration 0050).
//
// A fan's visit is one row per calendar day. It is written only here, with the
// service client, for the fan behind an ACTIVE link token; it is read back for
// the fan's own page and, through RLS, by the owning creator. Nothing here
// reads or writes a balance, a pass's spins or anything the spin engine uses:
// a visit never grants spins or changes odds.
import { isSupabaseConfigured, createServiceClient } from "@/lib/supabase/server";
import { CHECKIN_READ_DAYS, GLOW_WINDOW_DAYS } from "@/lib/glow/config";
import { glowGateOpen } from "@/lib/glow/gate";
import {
  addDays,
  checkinResult,
  clampCheckinDay,
  latestCheckinDay,
  computeGlow,
  glowAnchor,
  utcDay,
  visitsLast7,
  type CheckinResult,
  type FanGlow,
} from "@/lib/glow/glow";
import { mockRecordCheckin } from "./mock";
import type { AnyClient } from "./shared";

type Service = ReturnType<typeof createServiceClient>;

/** Rows a creator-wide read pages through at a time (PostgREST's row cap). */
const PAGE = 1000;

/** The oldest day a "last 7 days" read needs (a fan ahead of UTC may be on tomorrow). */
function last7From(now: Date): string {
  return addDays(utcDay(now), -GLOW_WINDOW_DAYS);
}

/**
 * Record that the fan behind `token` opened their link today (their own date,
 * clamped server-side) and return the glow. Idempotent per fan per day.
 *   - unknown, inactive or paused link → not_found
 *   - the glow gate is closed (blocked, or on a break) → not_allowed
 */
export async function recordCheckin(
  token: string,
  localDate: unknown,
  now: Date = new Date()
): Promise<({ ok: true } & CheckinResult) | { error: string }> {
  if (!isSupabaseConfigured()) return mockRecordCheckin(token, localDate, now);

  const sb: Service = createServiceClient();
  const { data: passRow } = await sb
    .from("fan_passes")
    .select("fan_id, creator_id, fan:fans(blocked_at, break_until)")
    .eq("token", token)
    .eq("is_active", true)
    .is("self_excluded_at", null)
    .maybeSingle();
  const pass = passRow as unknown as {
    fan_id: string;
    creator_id: string;
    fan: { blocked_at: string | null; break_until: string | null } | null;
  } | null;
  if (!pass || !pass.fan) return { error: "not_found" };
  if (!glowGateOpen({ blockedAt: pass.fan.blocked_at, breakUntil: pass.fan.break_until }, now)) return { error: "not_allowed" };

  const day = clampCheckinDay(localDate, now);
  // fan_id and creator_id come from the link, never from the request.
  const { data: inserted, error } = await sb
    .from("fan_checkins")
    .upsert(
      { fan_id: pass.fan_id, creator_id: pass.creator_id, day },
      { onConflict: "fan_id,day", ignoreDuplicates: true }
    )
    .select("day");
  if (error) return { error: "db_error" };
  const fresh = (inserted ?? []).length > 0;

  const { data: rows, error: readError } = await sb
    .from("fan_checkins")
    .select("day")
    .eq("fan_id", pass.fan_id)
    .gte("day", addDays(day, -(CHECKIN_READ_DAYS - 1)))
    .lte("day", latestCheckinDay(now))
    .order("day", { ascending: false })
    .limit(CHECKIN_READ_DAYS + 2);
  if (readError) return { error: "db_error" };
  const days = new Set(((rows ?? []) as { day: string }[]).map((r) => r.day));
  return { ok: true, ...checkinResult(days, day, fresh, now) };
}

/**
 * The fan page's glow before this visit's check-in (getFanPass). null when the
 * gate is closed, or when the table isn't there yet (a pre-0050 database), so
 * the page never fails over a glow.
 */
export async function readFanGlow(sb: Service, fanId: string, now: Date = new Date()): Promise<FanGlow | null> {
  try {
    return await readFanGlowOrThrow(sb, fanId, now);
  } catch {
    return null;
  }
}
async function readFanGlowOrThrow(sb: Service, fanId: string, now: Date): Promise<FanGlow | null> {
  const [{ data: fan }, { data: rows, error }] = await Promise.all([
    sb.from("fans").select("blocked_at, break_until").eq("id", fanId).maybeSingle(),
    sb
      .from("fan_checkins")
      .select("day")
      .eq("fan_id", fanId)
      .gte("day", last7From(now))
      .order("day", { ascending: false })
      .limit(GLOW_WINDOW_DAYS + 2),
  ]);
  if (error || !fan) return null;
  const f = fan as { blocked_at: string | null; break_until: string | null };
  if (!glowGateOpen({ blockedAt: f.blocked_at, breakUntil: f.break_until }, now)) return null;
  const days = new Set(((rows ?? []) as { day: string }[]).map((r) => r.day));
  return computeGlow(days, glowAnchor(days, now));
}

/**
 * Creator view: days each of the creator's fans visited in the last 7 days.
 * `sb` is the creator's RLS-scoped client. A failed read (e.g. a pre-0050
 * database) reads as no visits: the glow must never break the Fans list.
 */
export async function visitsByFan(sb: AnyClient, creatorId: string, now: Date = new Date()): Promise<Map<string, number>> {
  try {
    return await visitsByFanOrThrow(sb, creatorId, now);
  } catch {
    return new Map();
  }
}
async function visitsByFanOrThrow(sb: AnyClient, creatorId: string, now: Date): Promise<Map<string, number>> {
  const byFan = new Map<string, string[]>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("fan_checkins")
      .select("fan_id, day")
      .eq("creator_id", creatorId)
      .gte("day", last7From(now))
      .order("fan_id", { ascending: true })
      .order("day", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as { fan_id: string; day: string }[];
    for (const r of rows) (byFan.get(r.fan_id) ?? byFan.set(r.fan_id, []).get(r.fan_id)!).push(r.day);
    if (rows.length < PAGE) break;
  }
  const out = new Map<string, number>();
  for (const [fanId, days] of byFan) out.set(fanId, visitsLast7(days, now));
  return out;
}

/** Creator view: days one fan visited in the last 7 days (RLS-scoped client). */
export async function fanVisitsLast7(sb: AnyClient, fanId: string, now: Date = new Date()): Promise<number> {
  try {
    const { data, error } = await sb
      .from("fan_checkins")
      .select("day")
      .eq("fan_id", fanId)
      .gte("day", last7From(now))
      .limit(GLOW_WINDOW_DAYS + 2);
    if (error) return 0;
    return visitsLast7(((data ?? []) as { day: string }[]).map((r) => r.day), now);
  } catch {
    return 0;
  }
}
