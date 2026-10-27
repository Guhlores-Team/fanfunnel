import assert from "node:assert";
import {
  breakDurationMs,
  countPlay,
  fanEngagementAllowed,
  isBreakOption,
  isOnBreak,
  isPlayReminder,
  lengthenBreak,
  playCountsVisible,
  reminderDue,
  remindersEnabled,
} from "./playGuard";
import {
  BREAK_MAX_MS,
  BREAK_OPTIONS,
  CREATOR_CAN_DISABLE_PLAY_GUARD,
  PLAY_REMINDER_MAX,
  PLAY_REMINDER_MIN,
  PLAY_REMINDER_OPTIONS,
  PLAY_VISIBILITY,
} from "./config";

// RM-6 spend-awareness guardrail + the F6 engagement gate: the pure rules every
// surface (fan page, dashboard, mock store, Supabase path) shares.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-27T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// --- owner decisions: the recommended defaults --------------------------------
check("D3 default: spin counts only", PLAY_VISIBILITY === "counts");
check("D4 default: platform-wide, no creator opt-out", CREATOR_CAN_DISABLE_PLAY_GUARD === false);
check("D3: counts show with no reminder set", playCountsVisible(null));
check("D4: reminders are offered", remindersEnabled());
check("D4: a creator opt-out is ignored while the guardrail is platform-wide", remindersEnabled(true));
check("reminder choices are Off / 20 / 50 / 100", PLAY_REMINDER_OPTIONS.join() === "20,50,100");
check(
  "every reminder choice fits the DB CHECK (10..500)",
  PLAY_REMINDER_OPTIONS.every((n) => n >= PLAY_REMINDER_MIN && n <= PLAY_REMINDER_MAX)
);
check("break choices are 24h / 7d / 30d", BREAK_OPTIONS.map((o) => o.ms).join() === [DAY, 7 * DAY, 30 * DAY].join());
check("every break fits fan_take_break's 31-day bound", BREAK_OPTIONS.every((o) => o.ms <= BREAK_MAX_MS));

// --- isOnBreak ------------------------------------------------------------------
check("no break: not on a break", !isOnBreak(null, now) && !isOnBreak(undefined, now) && !isOnBreak("", now));
check("a future end: on a break", isOnBreak(iso(now + HOUR), now));
check("an ended break: not on a break", !isOnBreak(iso(now - 1), now));
check("exactly at the end: the break is over (claim_spin's <= now())", !isOnBreak(iso(now), now));
check("garbage: not on a break", !isOnBreak("not a date", now));

// --- F6 engagement gate ---------------------------------------------------------
check("an ordinary fan may be engaged", fanEngagementAllowed({}, now));
check("blocked: never", !fanEngagementAllowed({ blocked: true }, now));
check("paused a link: never", !fanEngagementAllowed({ selfExcluded: true }, now));
check("on a break: never", !fanEngagementAllowed({ breakUntil: iso(now + DAY) }, now));
check("after the break ends: again", fanEngagementAllowed({ breakUntil: iso(now - HOUR) }, now));

// --- inputs the routes accept ---------------------------------------------------
for (const v of [null, 20, 50, 100]) check(`reminder ${v} is accepted`, isPlayReminder(v));
for (const v of [undefined, 0, 10, 19, 21, 500, 1000, -20, "20", 20.5, NaN, {}, []]) {
  check(`reminder ${JSON.stringify(v)} is refused`, !isPlayReminder(v));
}
check("24h / 7d / 30d are break options", ["24h", "7d", "30d"].every(isBreakOption));
for (const v of ["1h", "365d", "", null, undefined, 86_400_000, "__proto__", "toString"]) {
  check(`break ${JSON.stringify(v)} is refused`, !isBreakOption(v) && breakDurationMs(v) === null);
}

// --- a break only ever gets longer (mirror of fan_take_break's greatest()) ------
check("a first break ends after its duration", lengthenBreak(null, DAY, now) === iso(now + DAY));
const week = lengthenBreak(null, 7 * DAY, now);
check("asking for less keeps the longer break", lengthenBreak(week, DAY, now) === week);
check("asking for more lengthens it", lengthenBreak(week, 30 * DAY, now) === iso(now + 30 * DAY));
check("an ended break restarts from now", lengthenBreak(iso(now - DAY), DAY, now) === iso(now + DAY));
check("a duration past the bound is clamped", lengthenBreak(null, 365 * DAY, now) === iso(now + BREAK_MAX_MS));
check("a negative duration can't shorten anything", lengthenBreak(week, -DAY, now) === week);

// --- rolling counts -------------------------------------------------------------
const times = [now - 1000, now - 23 * HOUR, now - 25 * HOUR, now - 6 * DAY, now - 8 * DAY, now + HOUR].map(iso);
const c = countPlay(times, now);
check(`today counts the last 24h only (got ${c.today})`, c.today === 2);
check(`this week counts the last 7 days only (got ${c.week})`, c.week === 4);
check("a future timestamp (clock skew) is not counted", countPlay([iso(now + 1000)], now).week === 0);
check("no spins: zero", countPlay([], now).today === 0 && countPlay([], now).week === 0);

// --- reminder trigger -----------------------------------------------------------
check("no reminder: never due", !reminderDue(999, null) && !reminderDue(999, undefined));
check("below the number: not due", !reminderDue(19, 20));
check("reaching the number: due", reminderDue(20, 20));
check("past the number (set late): due", reminderDue(60, 50));

console.log(`playGuard.test: ${passed} checks passed`);
