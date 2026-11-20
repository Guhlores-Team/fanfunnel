/**
 * Fulfilment due dates (RD-06). A due date is a calendar day ("YYYY-MM-DD")
 * chosen by the creator; it has no time of day and no zone of its own.
 *   • The browser commits one only when it is complete and inside a sane
 *     window, so typing "12 / 25 / 2026" never saves the year 2, 20 or 26.
 *   • "Overdue" starts at the creator's local midnight AFTER the due day
 *     (the due day itself is still on time), never at 00:00 UTC.
 *   • The server refuses dates outside today − 1 year … today + 10 years.
 */
export const DUE_DATE_PAST_DAYS = 366;
export const DUE_DATE_FUTURE_DAYS = 3660;
const DAY_MS = 86_400_000;

/** The "YYYY-MM-DD" part of a stored due date, or "" when none. */
export function dueDateValue(dueAt: string | null | undefined): string {
  return typeof dueAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(dueAt) ? dueAt.slice(0, 10) : "";
}

/** Parse "YYYY-MM-DD" into its calendar parts; null for anything else. */
export function parseDueDay(value: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // setUTCFullYear, not Date.UTC: the latter maps years 0..99 to 1900..1999.
  const check = new Date(0);
  check.setUTCFullYear(y, mo - 1, d);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/**
 * Is `value` a complete calendar day inside the accepted window around `now`?
 * Used by the browser before committing and by the route before writing.
 */
export function dueDateInRange(value: string, now: number = Date.now()): boolean {
  const day = parseDueDay(value);
  if (!day) return false;
  const utc = new Date(0);
  utc.setUTCFullYear(day.y, day.m - 1, day.d);
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return utc.getTime() >= today - DUE_DATE_PAST_DAYS * DAY_MS && utc.getTime() <= today + DUE_DATE_FUTURE_DAYS * DAY_MS;
}

/**
 * Local midnight at the end of the due day: the moment a win becomes overdue
 * in the zone the browser runs in. Uses the local Date constructor on purpose.
 */
export function dueDeadlineLocal(value: string): number | null {
  const day = parseDueDay(value);
  if (!day) return null;
  const end = new Date(0);
  end.setFullYear(day.y, day.m - 1, day.d + 1);
  end.setHours(0, 0, 0, 0);
  return end.getTime();
}

/** True once the due day has ended in the browser's zone (statuses that can still be owed only). */
export function isOverdue(dueAt: string | null | undefined, status: string, now: number): boolean {
  if (status === "fulfilled" || status === "cancelled") return false;
  const deadline = dueDeadlineLocal(dueDateValue(dueAt));
  return deadline !== null && now >= deadline;
}

/** Today + `days` as "YYYY-MM-DD" in the browser's zone (PR-10 default due date). */
export function localDayPlus(days: number, now: number = Date.now()): string {
  const d = new Date(now);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${mm}-${dd}`;
}

/** A short local label for a "YYYY-MM-DD" due day ("Nov 17"); the raw value otherwise. */
export function dueDayLabel(value: string): string {
  const day = parseDueDay(value);
  if (!day) return value;
  return new Date(day.y, day.m - 1, day.d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
