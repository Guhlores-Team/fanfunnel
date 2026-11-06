import assert from "node:assert/strict";
import { FAB_AVOID_SELECTOR, boxesOverlap, shouldStepAside } from "./fabOverlap";
import { readFileSync } from "node:fs";

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
// QA b5 m12: mid-scratch on 390×844 the button sat over the Sound pill.
const sound = { left: 250, right: 370, top: 790, bottom: 822 };
check("a covered Sound pill also makes it step aside", shouldStepAside(fab, [null, sound], false));
check("no covered control keeps it in place", !shouldStepAside(fab, [{ ...sound, top: 100, bottom: 130 }, null], false));
check("an empty control list never hides it", !shouldStepAside(fab, [], false));
const controller = readFileSync(new URL("./FanGameController.tsx", import.meta.url), "utf8");
const ticket = readFileSync(new URL("./ScratchTicket.tsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("./ChatPanel.tsx", import.meta.url), "utf8");
check("play and Sound are marked as controls to avoid", (controller.match(/data-fab-avoid/g) ?? []).length >= 2);
check("Reveal all is marked as a control to avoid", /data-fab-avoid/.test(ticket));
check("the chat button measures every marked control", chat.includes("FAB_AVOID_SELECTOR") && FAB_AVOID_SELECTOR === "[data-fab-avoid]");
console.log(`fabOverlap.test: ${passed} checks passed`);
