import assert from "node:assert/strict";
import { scheduleHint } from "./scheduleHint";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
// QA b5 m11: the active game a schedule overrides read "Always on"/"Inactive".
check("the live, unscheduled active game", scheduleHint(null, null, true) === "Active, no schedule");
check("an active game another game's schedule is overriding", scheduleHint(null, null, true, "QA Scratch") === "Active, paused while QA Scratch is scheduled");
check("a game that is simply not active", scheduleHint(null, null, false, "QA Scratch") === "Not active");
check("a scheduled game shows its window", /^From /.test(scheduleHint("2026-11-05T10:00:00Z", null, false)) && / → /.test(scheduleHint("2026-11-05T10:00:00Z", "2026-11-09T10:00:00Z", true)));
console.log(`scheduleHint.test: ${passed} checks passed`);
