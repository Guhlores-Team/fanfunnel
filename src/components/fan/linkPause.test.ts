import assert from "node:assert";
import { pauseErrorMessage, spinControl } from "./linkPause";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// SPIN control: a paused link disables SPIN immediately, whatever the balance.
const live = spinControl({ spinsRemaining: 5, busy: false, paused: false });
check("live link with spins can spin", live.canSpin && live.label === "SPIN");

const paused = spinControl({ spinsRemaining: 5, busy: false, paused: true });
check("paused link cannot spin even with spins left", !paused.canSpin);
check("paused link labels the button as paused", paused.label === "Link paused");
check("paused link shows a paused balance chip", paused.balanceLabel === "Paused");

const pausedBusy = spinControl({ spinsRemaining: 5, busy: true, paused: true });
check("paused wins over the spinning label", !pausedBusy.canSpin && pausedBusy.label === "Link paused");

const out = spinControl({ spinsRemaining: 0, busy: false, paused: false });
check("no spins keeps the existing out-of-spins state", !out.canSpin && out.label === "Out of spins");

const busy = spinControl({ spinsRemaining: 3, busy: true, paused: false });
check("busy spin is disabled and says Spinning", !busy.canSpin && busy.label === "Spinning…");
check("live balance chip shows the count", live.balanceLabel === "5");

// RM-6: a break turns SPIN off but keeps the fan's balance on show.
const onBreak = spinControl({ spinsRemaining: 5, busy: false, paused: false, onBreak: true });
check("on a break: cannot spin even with spins left", !onBreak.canSpin);
check("on a break: the button says so", onBreak.label === "On a break");
check("on a break: the balance is kept on show", onBreak.balanceLabel === "5");
const pausedOnBreak = spinControl({ spinsRemaining: 5, busy: false, paused: true, onBreak: true });
check("a paused link still wins over a break", pausedOnBreak.label === "Link paused");
check("no break flag keeps today's behaviour", spinControl({ spinsRemaining: 5, busy: false, paused: false, onBreak: false }).canSpin);

// Error mapping: never raw server text.
check("rate_limited is mapped", /moment|slow|again/i.test(pauseErrorMessage("rate_limited")));
check("not_found is mapped", /couldn.t find|already/i.test(pauseErrorMessage("not_found")));
check("unknown code falls back to a generic retry message", /try again/i.test(pauseErrorMessage("db_error")));
check("undefined falls back to the generic message", /try again/i.test(pauseErrorMessage(undefined)));
check("network error message is distinct", /connection|network/i.test(pauseErrorMessage("network")));
check("raw codes never leak into the message", !/db_error|rate_limited|not_found/.test(pauseErrorMessage("db_error")));

console.log(`linkPause.test: ${passed} checks passed`);
