// Data layer — win-back outreach log (RM-5, migration 0051).
//
// The creator's own session client only (anon key + RLS): fan_outreach's
// policies pin every row to a creator the caller may act for, and the fan (and
// any template) to that same creator. The creator id always comes from
// auth.getUser(), never from the request. FanFunnel sends nothing to the fan:
// a row only records that the creator copied a message, or snoozed the fan.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import {
  OUTREACH_ACTIONS,
  WINBACK_CONTACT_COOLDOWN_DAYS,
  WINBACK_RESULTS_WINDOW_DAYS,
  WINBACK_SNOOZE_DAYS,
  type OutreachAction,
} from "@/lib/winback/config";
import type { OutreachRow } from "@/lib/winback/list";
import { mockAgeFanActivity, mockListOutreach, mockRecordOutreach } from "./mock";

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How far back the win-back maths needs the log: the longest of its windows. */
export const OUTREACH_LOOKBACK_DAYS = Math.max(
  WINBACK_CONTACT_COOLDOWN_DAYS,
  WINBACK_RESULTS_WINDOW_DAYS,
  WINBACK_SNOOZE_DAYS,
);

export function isOutreachAction(v: unknown): v is OutreachAction {
  return typeof v === "string" && (OUTREACH_ACTIONS as readonly string[]).includes(v);
}

/**
 * Record that the signed-in creator contacted (copied a filled DM for) or
 * snoozed one of their fans. `templateId` is kept only when it is a saved
 * template's id (the built-in default has none).
 */
export async function recordOutreach(input: {
  fanId: string;
  action: OutreachAction;
  templateId?: string | null;
}): Promise<{ ok: true } | { error: string }> {
  const { fanId, action } = input;
  const templateId = input.templateId ?? null;
  if (!isSupabaseConfigured()) return mockRecordOutreach(fanId, action, templateId);
  if (!UUID.test(fanId)) return { error: "not_found" };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const now = Date.now();
  const insert = (template_id: string | null) =>
    sb.from("fan_outreach").insert({
      creator_id: user.id,
      fan_id: fanId,
      template_id,
      kind: "winback",
      contacted_at: action === "contacted" ? new Date(now).toISOString() : null,
      snoozed_until: action === "snoozed" ? new Date(now + WINBACK_SNOOZE_DAYS * DAY).toISOString() : null,
    });
  const tpl = templateId && UUID.test(templateId) ? templateId : null;
  const refused = (code?: string) => code === "42501" || code === "23503";
  let { error } = await insert(tpl);
  // A template that was deleted meanwhile (or isn't this creator's) must not
  // lose the contact: log it without the template, as the demo path does.
  if (error && tpl && refused(error.code)) ({ error } = await insert(null));
  if (!error) return { ok: true };
  // The insert check refuses a fan that isn't this creator's: report it like
  // a missing fan, never as a raw database message.
  if (refused(error.code)) return { error: "not_found" };
  console.error("recordOutreach: insert failed", { code: error.code });
  return { error: "db_error" };
}

/**
 * The signed-in creator's recent outreach (the lookback window), or null when
 * it can't be read: the caller must then fail closed (show nobody to win back)
 * rather than risk re-suggesting a fan inside the contact cooldown.
 */
export async function listRecentOutreach(now: number = Date.now()): Promise<OutreachRow[] | null> {
  const since = new Date(now - OUTREACH_LOOKBACK_DAYS * DAY).toISOString();
  if (!isSupabaseConfigured()) return mockListOutreach(since);

  try {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb
      .from("fan_outreach")
      .select("fan_id, contacted_at, snoozed_until")
      .eq("creator_id", user.id)
      .eq("kind", "winback")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error || !Array.isArray(data)) return null;
    return (data as { fan_id: string; contacted_at: string | null; snoozed_until: string | null }[]).map((r) => ({
      fanId: r.fan_id,
      contactedAt: r.contacted_at,
      snoozedUntil: r.snoozed_until,
    }));
  } catch {
    return null;
  }
}

/**
 * Demo mode only (no Supabase): move a demo fan's activity `days` into the
 * past so the win-back list can be shown and tested without waiting two
 * weeks. With Supabase configured it does nothing and reports not_found, so it
 * can never touch real data.
 */
export function ageFanActivityForDemo(fanId: string, days: number): { ok: true } | { error: string } {
  if (isSupabaseConfigured()) return { error: "not_found" };
  return mockAgeFanActivity(fanId, days);
}
