import assert from "node:assert/strict";
import { boxesOverlap, shouldStepAside } from "./fabOverlap";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
// Measured on /spin/demo (QA 2026-11-04): 390×844, SPIN 20..370 × 755..815, Message 258..374 × 780..828.
const spin = { left: 20, right: 370, top: 755, bottom: 815 };
const fab = { left: 258, right: 374, top: 780, bottom: 828 };
check("the measured 390×844 layout overlaps", boxesOverlap(fab, spin));
check("so the button steps aside", shouldStepAside(fab, spin, false));
check("not while the chat is open or the button has focus", !shouldStepAside(fab, spin, true));
check("a play button scrolled above the floating button is not covered", !shouldStepAside({ ...fab, top: 600, bottom: 648 }, spin, false));
check("touching edges are not an overlap", !boxesOverlap({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 10, right: 20, top: 0, bottom: 10 }));
check("a missing play button (reward card, other screen) never hides it", !shouldStepAside(fab, null, false));
console.log(`fabOverlap.test: ${passed} checks passed`);
