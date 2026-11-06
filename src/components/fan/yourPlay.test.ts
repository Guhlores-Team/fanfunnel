import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ackReminder, breakStatus, breatherTitle, formatBreakEnd, playSummary, reminderAcked } from "./yourPlay";
import { REMINDER_ACK_STORAGE_KEY } from "@/lib/play/config";

// RM-6 fan copy and the reminder card's once-per-threshold-per-day rule. The
// rendered cards are covered by e2e + a11y.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = Date.parse("2026-10-27T12:00:00Z");

// --- copy -------------------------------------------------------------------------
check("summary reads like the proposal", playSummary(12, 38) === "12 spins today · 38 this week");
check("singular spin", playSummary(1, 1) === "1 spin today · 1 this week");
check("breather headline", breatherTitle(50) === "You've played 50 spins today");
check("break status names the end", breakStatus("Fri 9:00 PM") === "You're taking a break until Fri 9:00 PM. Your spins and prizes are safe.");
check("break status without a time still reassures", /spins and prizes are safe/.test(breakStatus(null)));

// The end is an absolute time, never a countdown.
const soon = formatBreakEnd(new Date(t0 + DAY).toISOString(), t0, "en-US");
check(`a break this week shows a weekday and time (${soon})`, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(soon) && /\d/.test(soon));
const later = formatBreakEnd(new Date(t0 + 30 * DAY).toISOString(), t0, "en-US");
check(`a long break shows the date (${later})`, /Nov 26/.test(later));
check("an invalid date shows nothing", formatBreakEnd("nope", t0) === "");

// Copy rules: no countdowns and no loss framing, anywhere the fan reads.
const LOSS = /don.t lose|lose your|last chance|hurry|expires? in|left to|only \d+ (hours?|minutes?)|countdown|miss out/i;
// Comments (which name the banned phrases) are stripped first.
const surfaces = ["yourPlay.ts", "YourPlay.tsx", "BreatherCard.tsx", "BreakPicker.tsx"].map((f) =>
  readFileSync(join(import.meta.dirname, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
);
check("no loss-framed or countdown copy in the RM-6 fan surfaces", surfaces.every((src) => !LOSS.test(src)));
const card = surfaces[2];
const btnClass = (label: string) => {
  const i = card.indexOf(`>\n                ${label}`);
  const open = card.lastIndexOf("<button", i);
  return card.slice(open, i).match(/className=\{(\w+)\}/)?.[1];
};
check(
  "Keep playing and Take a break carry equal weight (same button style)",
  btnClass("Keep playing") === "equalBtn" && btnClass("Take a break") === "equalBtn"
);

// No new fan-page button may read like the SPIN control: tests, assistive tech
// and people find SPIN by its text, so "Your play" keeps its counts outside the
// toggle and no RM-6 button says "spin".
const buttonBlocks = surfaces.flatMap((src) => [...src.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]));
const buttonTexts = buttonBlocks.map((b) => b.replace(/<[^>]*>/g, " ")).join(" | ");
check(`no RM-6 button text mentions spins (${buttonTexts.match(/[^|]*spin[^|]*/i)?.[0] ?? "none"})`, !/spin/i.test(buttonTexts));
check("the play counts are never rendered inside a button", buttonBlocks.every((b) => !/playSummary\(|breatherTitle\(/.test(b)));

// --- once per threshold per day ----------------------------------------------------
const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
check("not acked before Keep playing", !reminderAcked(50, t0, store));
ackReminder(50, t0, store);
check("acked right after Keep playing", reminderAcked(50, t0 + 1000, store));
check("still acked 23h later", reminderAcked(50, t0 + 23 * HOUR, store));
check("shows again the next day", !reminderAcked(50, t0 + DAY, store));
check("a new reminder number re-arms the card", !reminderAcked(20, t0 + 1000, store));
check("the ack stores no link token", !/token|spin\//i.test(mem.get(REMINDER_ACK_STORAGE_KEY) ?? ""));
check("a future ack (clock skew) does not hide the card", !reminderAcked(50, t0 - HOUR, store));
mem.set(REMINDER_ACK_STORAGE_KEY, "garbage");
check("a corrupt value is ignored", !reminderAcked(50, t0, store));
const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};
check("blocked storage: the card shows (the safe side)", !reminderAcked(50, t0, throwing));
ackReminder(50, t0, throwing);
check("blocked storage: Keep playing does not throw", true);
check("no window (SSR): not acked", !reminderAcked(50, t0));

console.log(`yourPlay.test: ${passed} checks passed`);
