import assert from "node:assert/strict";
import { formatLocal, formatUtc } from "./LocalTime";

// FD-11: the verify page never shows a bare server-zone time.
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
const at = "2026-11-09T12:40:01.000Z";
check("server fallback is labelled UTC", formatUtc(at) === "2026-11-09 12:40 UTC");
const london = formatLocal(at, "en-GB", "Europe/London");
check("London sees its own zone, labelled: " + london, /12:40:01/.test(london) && /GMT|UTC/.test(london));
const sydney = formatLocal(at, "en-AU", "Australia/Sydney");
check("Sydney sees its own time and zone: " + sydney, /11:40:01\s*pm/i.test(sydney) && /AEDT|GMT\+11/.test(sydney) && /9 Nov 2026/.test(sydney));
const la = formatLocal(at, "en-US", "America/Los_Angeles");
check("Los Angeles in US order with PST: " + la, /Nov 9, 2026/.test(la) && /4:40:01\s*AM/.test(la) && /PST/.test(la));
const de = formatLocal(at, "de-DE", "Europe/Berlin");
check("German locale formatting: " + de, /9\. Nov\. 2026/.test(de) && /13:40:01/.test(de) && /MEZ|GMT\+1/.test(de));
check("a bad date is shown as given", formatUtc("nope") === "nope" && formatLocal("nope") === "nope");
check("an unknown time zone falls back to UTC", formatLocal(at, "en-US", "Not/AZone") === "2026-11-09 12:40 UTC");
console.log(`verify LocalTime: ${passed} checks passed`);
