import assert from "node:assert";
import {
  FIRST_STEPS_TOTAL,
  buildFirstSteps,
  firstStepsAllDone,
  firstStepsDone,
  isFirstRun,
} from "./firstSteps";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const fresh = { wheelSaved: false, fans: 0, spins: 0, fulfilled: 0 };

// --- shape -------------------------------------------------------------------
const steps = buildFirstSteps(fresh);
check("five steps, in the spec's order", steps.map((s) => s.key).join(",") === "account,wheel,fan,share,fulfil");
check("FIRST_STEPS_TOTAL matches", steps.length === FIRST_STEPS_TOTAL);
check("account step is always done and has no CTA", steps[0].done && steps[0].cta === undefined);
check("every other step has a CTA into a section", steps.slice(1).every((s) => !!s.cta?.label && !!s.cta?.go));
check("wheel step opens the editor", steps[1].cta?.go === "editor");
check("mint + share steps open Fans", steps[2].cta?.go === "fans" && steps[3].cta?.go === "fans");
check("fulfil step opens Fulfilment", steps[4].cta?.go === "prizes");

// --- the prior checklist's signals are preserved exactly ----------------------
check("fresh account: only the account step is done", firstStepsDone(fresh) === 1);
check("wheel saved ticks the wheel step", buildFirstSteps({ ...fresh, wheelSaved: true })[1].done);
check("fans > 0 ticks the mint step (prior: 'Add a fan & grant spins')", buildFirstSteps({ ...fresh, fans: 1 })[2].done);
check("spins > 0 ticks the share step (prior: 'Send them their spin link')", buildFirstSteps({ ...fresh, spins: 1 })[3].done);
check("fans alone does NOT tick share", !buildFirstSteps({ ...fresh, fans: 3 })[3].done);
check("fulfilled > 0 ticks the fulfil step", buildFirstSteps({ ...fresh, fulfilled: 1 })[4].done);
check("pending-only wins do not tick fulfil", !buildFirstSteps({ ...fresh, spins: 2, fans: 1 })[4].done);

// --- completion ---------------------------------------------------------------
const priorDone = { wheelSaved: true, fans: 1, spins: 1, fulfilled: 0 };
check("the prior three steps alone are not 'all done' any more (fulfil remains)", !firstStepsAllDone(priorDone));
check("4 of 5 done when only fulfil is left", firstStepsDone(priorDone) === 4);
check("all five done", firstStepsAllDone({ ...priorDone, fulfilled: 1 }));

// --- first-run detection -------------------------------------------------------
check("no fans + no spins is first run", isFirstRun({ fans: 0, spins: 0 }));
check("a fan ends first run", !isFirstRun({ fans: 1, spins: 0 }));
check("a spin ends first run", !isFirstRun({ fans: 0, spins: 1 }));

console.log(`firstSteps: ${passed} checks passed`);
