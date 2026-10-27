// Data layer — the fan's spend-awareness guardrail (RM-6): their rolling spin
// counts, their private daily reminder, and their break.
//
// Fans have no Supabase session. Their writes arrive through token-scoped
// server routes (POST /api/fan/reminder, POST /api/fan/break) and run here on
// the service client, server-side only. A token reaches only its own fan, and
// only while its link is live (active, not paused, fan not blocked).
//
// The break is the hard part: claim_spin refuses a spin during it, the
// server-only fan_take_break() can only lengthen it, and a trigger stops
// anyone shortening it (migration 0049). The reminder is soft: it only makes
// the fan page ask "Want a breather?" before the next spin.
import { isSupabaseConfigured, createServiceClient } from "@/lib/supabase/server";
import { BREAK_MAX_MS, PLAY_TODAY_WINDOW_MS, PLAY_WEEK_WINDOW_MS } from "@/lib/play/config";
import { isOnBreak, reminderDue } from "@/lib/play/playGuard";
import type { FanPlayView } from "./types";
import type { AnyClient } from "./shared";
import { mockSetPlayReminder, mockTakeBreak } from "./mock";

export type PlayGuardError = { error: "not_found" | "blocked" | "bad_request" | "db_error" };

/** Rolling spin counts. Never throws: a failed count reads as 0. */
export async function readPlayCounts(
  sb: AnyClient,
  fanId: string,
  now: number = Date.now(),
): Promise<{ today: number; week: number }> {
  const since = (ms: number) => new Date(now - ms).toISOString();
  const count = async (ms: number) => {
    try {
      const { count: n, error } = await sb
        .from("spins")
        .select("id", { count: "exact", head: true })
        .eq("fan_id", fanId)
        .gte("created_at", since(ms));
      return error || typeof n !== "number" ? 0 : n;
    } catch {
      return 0;
    }
  };
  const [today, week] = await Promise.all([count(PLAY_TODAY_WINDOW_MS), count(PLAY_WEEK_WINDOW_MS)]);
  return { today, week: Math.max(week, today) };
}

/**
 * Everything the fan page shows about the fan's own play. Each part is read on
 * its own and best-effort (a DB without 0049 still renders the page): the
 * server, not this view, is what refuses a spin during a break.
 */
export async function readPlayState(sb: AnyClient, fanId: string, now: number = Date.now()): Promise<FanPlayView> {
  const [counts, fanRes, reminderRes] = await Promise.all([
    readPlayCounts(sb, fanId, now),
    Promise.resolve(sb.from("fans").select("break_until").eq("id", fanId).maybeSingle()).catch(() => null),
    Promise.resolve(sb.from("fan_play_reminders").select("daily").eq("fan_id", fanId).maybeSingle()).catch(() => null),
  ]);
  const breakUntil = (fanRes?.data as { break_until?: string | null } | null)?.break_until ?? null;
  const daily = (reminderRes?.data as { daily?: number | null } | null)?.daily;
  return {
    ...counts,
    reminder: typeof daily === "number" ? daily : null,
    breakUntil: isOnBreak(breakUntil, now) ? breakUntil : null,
  };
}

/**
 * This creator's fans who are on a break right now: fan id -> break end. Read
 * on the caller's client (RLS-scoped for a creator). Best-effort: an error
 * yields an empty map (a DB without 0049 has no breaks).
 */
export async function readFansOnBreak(
  sb: AnyClient,
  creatorId: string,
  now: number = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { data, error } = await sb
      .from("fans")
      .select("id, break_until")
      .eq("creator_id", creatorId)
      .gt("break_until", new Date(now).toISOString());
    if (error || !Array.isArray(data)) return out;
    for (const r of data as { id: string; break_until: string | null }[]) {
      if (r.break_until && isOnBreak(r.break_until, now)) out.set(r.id, r.break_until);
    }
  } catch {
    /* no breaks known */
  }
  return out;
}

/**
 * After a recorded spin: the fan's fresh counts and whether today's spins have
 * reached their reminder. Best-effort and never throws: a recorded win must
 * not fail over a count.
 */
export async function readPlayAfterSpin(
  sb: AnyClient,
  fanId: string,
  now: number = Date.now(),
): Promise<{ play: { today: number; week: number }; reminderDue: boolean }> {
  const [play, reminderRes] = await Promise.all([
    readPlayCounts(sb, fanId, now),
    Promise.resolve(sb.from("fan_play_reminders").select("daily").eq("fan_id", fanId).maybeSingle()).catch(() => null),
  ]);
  const daily = (reminderRes?.data as { daily?: number | null } | null)?.daily;
  return { play, reminderDue: reminderDue(play.today, typeof daily === "number" ? daily : null) };
}

/** The fan behind a live link (F5's refusal rule), on the service client. */
async function resolveLiveFan(
  sb: ReturnType<typeof createServiceClient>,
  token: string,
): Promise<{ fanId: string } | PlayGuardError> {
  const { data, error } = await sb
    .from("fan_passes")
    .select("fan_id, is_active, self_excluded_at, fan:fans(blocked_at)")
    .eq("token", token)
    .maybeSingle();
  if (error) return { error: "db_error" };
  const row = data as unknown as {
    fan_id: string;
    is_active: boolean;
    self_excluded_at: string | null;
    fan: { blocked_at: string | null } | null;
  } | null;
  if (!row) return { error: "not_found" };
  // Paused (self-excluded) or blocked first: pausing also deactivates the link,
  // and the mock store reports a paused link as blocked too.
  if (row.self_excluded_at || row.fan?.blocked_at) return { error: "blocked" };
  if (!row.is_active) return { error: "not_found" };
  return { fanId: row.fan_id };
}

/** Set (or, with null, turn off) the fan's own daily reminder. */
export async function setPlayReminder(
  token: string,
  daily: number | null,
): Promise<{ ok: true; reminder: number | null } | PlayGuardError> {
  if (!isSupabaseConfigured()) return mockSetPlayReminder(token, daily);
  const sb = createServiceClient();
  const fan = await resolveLiveFan(sb, token);
  if ("error" in fan) return fan;
  const { error } =
    daily === null
      ? await sb.from("fan_play_reminders").delete().eq("fan_id", fan.fanId)
      : await sb
          .from("fan_play_reminders")
          .upsert({ fan_id: fan.fanId, daily, updated_at: new Date().toISOString() }, { onConflict: "fan_id" });
  return error ? { error: "db_error" } : { ok: true, reminder: daily };
}

/**
 * Start (or lengthen) the fan's break. The end is computed here from a fixed
 * menu of durations, never sent by the client, and fan_take_break keeps any
 * longer break already in force: asking for less leaves it unchanged.
 */
export async function takeBreak(
  token: string,
  durationMs: number,
): Promise<{ ok: true; breakUntil: string } | PlayGuardError> {
  if (!(durationMs > 0 && durationMs <= BREAK_MAX_MS)) return { error: "bad_request" };
  if (!isSupabaseConfigured()) return mockTakeBreak(token, durationMs);
  const sb = createServiceClient();
  const fan = await resolveLiveFan(sb, token);
  if ("error" in fan) return fan;
  const { data, error } = await sb.rpc("fan_take_break", {
    p_token: token,
    p_until: new Date(Date.now() + durationMs).toISOString(),
  });
  if (error) return { error: "db_error" };
  if (typeof data !== "string") return { error: "not_found" };
  return { ok: true, breakUntil: new Date(data).toISOString() };
}
