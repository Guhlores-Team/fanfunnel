import assert from "node:assert";
import {
  FIRST_STEPS_TOTAL,
  buildFirstSteps,
  firstStepsAllDone,
  firstStepsDone,
  isFirstRun,
  orderFirstSteps,
  profileStepDone,
  type FirstStepSignals,
} from "./firstSteps";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const fresh = { wheelSaved: false, fans: 0, spins: 0, fulfilled: 0 };

const step = (sig: FirstStepSignals, key: string) => buildFirstSteps(sig).find((x) => x.key === key)!;

// --- shape -------------------------------------------------------------------
const steps = buildFirstSteps(fresh);
check("six steps, in the spec's order", steps.map((s) => s.key).join(",") === "account,profile,wheel,fan,share,fulfil");
check("FIRST_STEPS_TOTAL matches", steps.length === FIRST_STEPS_TOTAL);
check("account step is always done and has no CTA", steps[0].done && steps[0].cta === undefined);
check("every other step has a CTA into a section", steps.slice(1).every((s) => !!s.cta?.label && !!s.cta?.go));
check("profile step opens Settings", step(fresh, "profile").cta?.go === "settings");
check("wheel step opens the editor", step(fresh, "wheel").cta?.go === "editor");
check("mint + share steps open Fans", step(fresh, "fan").cta?.go === "fans" && step(fresh, "share").cta?.go === "fans");
check("fulfil step opens Fulfilment", step(fresh, "fulfil").cta?.go === "prizes");
// C13: a /spin link is one fan's paid balance, never a bio link.
check("the share step never says to put a spin link in a bio", !/drop it in .*bio/i.test(step(fresh, "share").body) && /never for your bio/.test(step(fresh, "share").body));
check("the profile step points the bio at /c/", step(fresh, "profile").body.includes("/c/"));

// --- the prior checklist's signals are preserved exactly ----------------------
check("fresh account (profile unknown): account + profile done", firstStepsDone(fresh) === 2);
check("wheel saved ticks the wheel step", step({ ...fresh, wheelSaved: true }, "wheel").done);
check("fans > 0 ticks the mint step (prior: 'Add a fan & grant spins')", step({ ...fresh, fans: 1 }, "fan").done);
check("spins > 0 ticks the share step (prior: 'Send them their spin link')", step({ ...fresh, spins: 1 }, "share").done);
check("fans alone does NOT tick share", !step({ ...fresh, fans: 3 }, "share").done);
check("fulfilled > 0 ticks the fulfil step", step({ ...fresh, fulfilled: 1 }, "fulfil").done);
check("pending-only wins do not tick fulfil", !step({ ...fresh, spins: 2, fans: 1 }, "fulfil").done);

// --- C9: name and public link ----------------------------------------------------
check("profile not set → step open", !step({ ...fresh, profileSet: false }, "profile").done);
check("profileStepDone: name and handle", profileStepDone({ displayName: "Bella", publicSlug: "bella" }));
check("profileStepDone: a blank name is not done", !profileStepDone({ displayName: "  ", publicSlug: "bella" }));
check("profileStepDone: no handle is not done", !profileStepDone({ displayName: "Bella", publicSlug: null }));
check("profileStepDone: still loading is not done (never persists a premature 'all done')", !profileStepDone(undefined));

// --- completion ---------------------------------------------------------------
const priorDone = { wheelSaved: true, fans: 1, spins: 1, fulfilled: 0, profileSet: true };
check("the prior three steps alone are not 'all done' any more (fulfil remains)", !firstStepsAllDone(priorDone));
check("5 of 6 done when only fulfil is left", firstStepsDone(priorDone) === 5);
check("all six done", firstStepsAllDone({ ...priorDone, fulfilled: 1 }));
check("everything but the profile is not all done", !firstStepsAllDone({ ...priorDone, fulfilled: 1, profileSet: false }));

// --- WC-22: order by state, and no "build your first game" under a ticked mint step
{
  const demo = { ...fresh, fans: 1, spins: 1 };
  const ordered = orderFirstSteps(buildFirstSteps(demo));
  const firstOpen = ordered.findIndex((x) => !x.done);
  check("finished steps are listed before open ones", ordered.slice(firstOpen).every((x) => !x.done));
  check("the order within each group is unchanged", ordered.map((x) => x.key).join() === "account,profile,fan,share,wheel,fulfil");
  check("a fresh account keeps the original order", orderFirstSteps(buildFirstSteps(fresh)).map((x) => x.key).join() === "account,profile,wheel,fan,share,fulfil");
  check("still six steps", ordered.length === 6);
  check("a fan on the sample game is told so", step(demo, "wheel").title === "Make the game yours" && /sample game/.test(step(demo, "wheel").body));
  check("a fresh account still reads 'Build your first game'", step(fresh, "wheel").title === "Build your first game");
  check("a saved game keeps the original title", step({ ...demo, wheelSaved: true }, "wheel").title === "Build your first game");
}

// --- first-run detection -------------------------------------------------------
check("no fans + no spins is first run", isFirstRun({ fans: 0, spins: 0 }));
check("a fan ends first run", !isFirstRun({ fans: 1, spins: 0 }));
check("a spin ends first run", !isFirstRun({ fans: 0, spins: 1 }));

console.log(`firstSteps: ${passed} checks passed`);
