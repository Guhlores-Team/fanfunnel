// Independent owned fixtures; e2e firstRun reset cannot invalidate these scans.
import { BASE, goto } from "./harness.mjs";
import { cleanupFocus, editFocusTarget, focusFixture, json, openFocusFan, playFocus, readyChaseFinal } from "./focus.mjs";

const owned = new WeakMap();
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 360, height: 800 };
async function prepare(page, name, kind = "focus") {
  const fixture = await focusFixture(page.request, name, kind);
  owned.set(page, fixture);
  return fixture;
}
export async function focusA11yCleanup(page) {
  await page.unroute("**/api/spin").catch(() => {});
  await page.unroute("**/api/spin/status").catch(() => {});
  await page.evaluate(() => { if (window.__ffOriginalWrite) { Storage.prototype.setItem = window.__ffOriginalWrite; delete window.__ffOriginalWrite; } }).catch(() => {});
  await goto(page, "/dashboard", 100);
  const fixture = owned.get(page);
  await cleanupFocus(page.request, fixture);
  if (fixture) await page.evaluate(async token => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    localStorage.removeItem("ff-spin-intent-v1:" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""));
  }, fixture.token);
  owned.delete(page);
  await page.emulateMedia({ reducedMotion: null });
}
const active = async page => openFocusFan(page, await prepare(page, "A11y focused odds"));
const soldOut = async page => {
  const fixture = await prepare(page, "A11y paused focus");
  await editFocusTarget(page.request, fixture, { stock: 0 });
  await openFocusFan(page, fixture);
  await page.getByTestId("fan-focus-paused").waitFor();
};
const onBreak = async page => {
  const fixture = await prepare(page, "A11y focus break");
  await json(await page.request.post(BASE + "/api/fan/break", { data: { token: fixture.token, duration: "24h" } }), "take focus break");
  await openFocusFan(page, fixture);
  await page.getByTestId("fan-focus-paused").waitFor();
};
const chase = async page => {
  const fixture = await prepare(page, "A11y chase", "chase");
  await readyChaseFinal(page.request, fixture);
  await openFocusFan(page, fixture);
};
const chaseWin = async page => { await chase(page); await playFocus(page); await page.getByTestId("chase-complete").waitFor(); };
const pending = async page => {
  const fixture = await prepare(page, "A11y pending spin");
  await openFocusFan(page, fixture);
  await page.route("**/api/spin", route => route.abort("aborted"));
  await page.getByTestId("fan-spin").click();
  await page.getByTestId("spin-recovery-controls").waitFor();
  await page.unroute("**/api/spin");
  await page.getByTestId("spin-recovery-check").click();
  await page.getByTestId("spin-recovery-status").filter({ hasText: /not been confirmed/ }).waitFor();
};
const storage = async page => {
  await active(page);
  await page.evaluate(() => {
    window.__ffOriginalWrite = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("ff-spin-intent-v1:")) throw new DOMException("Storage unavailable", "QuotaExceededError");
      return window.__ffOriginalWrite.call(this, key, value);
    };
  });
  await page.getByTestId("fan-spin").click();
  await page.getByTestId("spin-storage-check").waitFor();
};
const book = color => async page => {
  const fixture = await prepare(page, "A11y focus prize book");
  await json(await page.request.put(BASE + "/api/wheel", { data: { wheel: { ...fixture.wheel, brandColor: color } } }), "set focus contrast extreme");
  await openFocusFan(page, fixture);
  await page.getByRole("button", { name: /Prize book/ }).click();
};
export function focusA11yStates() {
  const state = (name, prep, viewport) => ({ path: null, name, prep, cleanup: focusA11yCleanup, context: {}, ...(viewport ? { viewport } : {}) });
  return [
    state("fan (active focus)", active),
    state("fan phone (focus progress and odds)", active, PHONE),
    state("fan small phone (focus progress)", active, SMALL),
    state("fan phone (sold-out focused prize, paused)", soldOut, PHONE),
    state("fan small phone (focused pack during break)", onBreak, SMALL),
    state("fan phone (chase final eligible spin)", chase, PHONE),
    state("fan small phone (chase complete and private code)", chaseWin, SMALL),
    state("fan phone (unresolved absent spin)", pending, PHONE),
    state("fan small phone (storage unavailable before play)", storage, SMALL),
    state("fan small phone (white brand, real focused odds)", book("#ffffff"), SMALL),
    state("fan (black brand, real focused odds)", book("#000000")),
  ];
}
