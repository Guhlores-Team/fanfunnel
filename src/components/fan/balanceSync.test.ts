import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BALANCE_POLL_MAX, BALANCE_POLL_MS, shouldPollBalance, topUpDelta, topUpNote } from "./balanceSync";

// WF-06 / RF-03: an open page learns of a top-up without the fan leaving the
// tab, a payload that arrived mid-play is never adopted, and the poll is bounded.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const waiting = { spinsRemaining: 0, idle: true, visible: true, online: true, stopped: false, polls: 0 };
check("an idle, visible, out-of-plays page polls", shouldPollBalance(waiting));
check("a page with plays left does not poll", !shouldPollBalance({ ...waiting, spinsRemaining: 1 }));
check("nothing is read mid-play", !shouldPollBalance({ ...waiting, idle: false }));
check("a hidden tab does not poll", !shouldPollBalance({ ...waiting, visible: false }));
check("an offline page does not poll", !shouldPollBalance({ ...waiting, online: false }));
check("a paused, on-break or blocked link does not poll", !shouldPollBalance({ ...waiting, stopped: true }));
check("the poll stops at its budget", shouldPollBalance({ ...waiting, polls: BALANCE_POLL_MAX - 1 }) && !shouldPollBalance({ ...waiting, polls: BALANCE_POLL_MAX }));
check("the budget is ten minutes of half-minute reads", BALANCE_POLL_MS === 30_000 && BALANCE_POLL_MAX === 20);

check("a higher server balance is a top-up", topUpDelta(0, 3) === 3 && topUpDelta(2, 3) === 1);
check("an equal or lower balance is not", topUpDelta(3, 3) === null && topUpDelta(3, 1) === null);
check("garbage is not a top-up", topUpDelta(Number.NaN, 3) === null && topUpDelta(0, Infinity) === null);

check("the note counts spins on a wheel", topUpNote(3, "Mia", "wheel") === "+3 spins from Mia" && topUpNote(1, "Mia", "wheel") === "+1 spin from Mia");
check("and plays on scratch and bingo", topUpNote(2, "Mia", "scratch") === "+2 plays from Mia" && topUpNote(1, "Mia", "bingo") === "+1 play from Mia");

const controller = readFileSync(new URL("./FanGameController.tsx", import.meta.url), "utf8");
check("the controller polls through the shared rule", /shouldPollBalance\(\{/.test(controller) && /BALANCE_POLL_MS/.test(controller));
check("a payload that arrived mid-play is dropped and read again, never adopted",
  /if \(!idle\) \{ if \(skippedPass !== pass\) setSkippedPass\(pass\); \}/.test(controller)
  && /else if \(skippedPass === pass\) \{[^}]*setSyncedPass\(pass\);[^}]*setResync\(/.test(controller));
check("the top-up note is a polite status the next play clears", /data-testid="topup-note"/.test(controller) && /role="status"[^>]*data-testid="topup-note"/.test(controller) && /setToppedUp\(null\)/.test(controller));

console.log(`balanceSync: ${passed} checks passed`);
