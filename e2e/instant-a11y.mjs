import { randomUUID } from "node:crypto";
// Standalone accessibility fixtures: each prep creates its own wheel/fan and
// works after e2e's final account reset. Register these states in a11y.mjs.
import { BASE, clickTab, goto } from "./harness.mjs";
import {
  archiveInstantFixture,
  instantFixture,
  openInstantEditor,
  seedInstantCodes,
  spinInstantForCard,
} from "./instant.mjs";

const fixtures = new WeakMap();
const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 360, height: 800 };

async function fixtureFor(page, name) {
  const fixture = await instantFixture(page.request, name, 3);
  fixtures.set(page, fixture);
  await seedInstantCodes(page.request, fixture);
  return fixture;
}

export async function instantA11yCleanup(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.emulateMedia({ reducedMotion: null }).catch(() => {});
  await archiveInstantFixture(page.request, fixtures.get(page));
  fixtures.delete(page);
}

export async function openCodeDelivery(page) {
  const fixture = await fixtureFor(page, "A11y codes");
  const editor = await openInstantEditor(page, fixture);
  await editor.scrollIntoViewIfNeeded();
}

export async function openCodeRemoval(page) {
  const fixture = await fixtureFor(page, "A11y code removal");
  const editor = await openInstantEditor(page, fixture);
  await editor.getByTestId("delivery-kind").selectOption("manual");
  await editor.getByTestId("delivery-remove-codes-confirm").check();
  await editor.scrollIntoViewIfNeeded();
}

export async function openDeliveryValidation(page) {
  const fixture = await fixtureFor(page, "A11y delivery validation");
  const editor = await openInstantEditor(page, fixture, fixture.link);
  await editor.getByTestId("delivery-kind").selectOption("link");
  await editor.getByTestId("delivery-value").fill("javascript:alert(1)");
  await editor.getByTestId("delivery-save").click();
  await editor.getByTestId("delivery-error").waitFor({ timeout: 4000 });
  await editor.scrollIntoViewIfNeeded();
}

export async function openInstantCodeReveal(page) {
  const fixture = await fixtureFor(page, "A11y code win");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await spinInstantForCard(page, fixture);
  await page.getByTestId("reward-value").waitFor({ timeout: 5000 });
}

export async function openSavedInstantReward(page) {
  const fixture = await fixtureFor(page, "A11y saved reward");
  const result = await page.request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fixture.token, clientSeed: "a11y-instant" } });
  if (!result.ok()) throw new Error(`could not make an instant reward for the scan (${result.status()})`);
  await goto(page, `/spin/${fixture.token}`, 500);
  await page.getByTestId("view-reward").click();
  await page.getByTestId("saved-reward-dialog").getByTestId("reward-value").waitFor({ timeout: 8000 });
}

export async function openInstantFulfilment(page) {
  const fixture = await fixtureFor(page, "A11y auto delivery");
  const result = await page.request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fixture.token, clientSeed: "a11y-auto" } });
  if (!result.ok()) throw new Error(`could not make an Auto row for the scan (${result.status()})`);
  await goto(page, "/dashboard", 600);
  await clickTab(page, "Fulfilment");
  await page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: "Fulfilled", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search redemptions by fan or prize" }).fill(fixture.name);
  await page.getByTestId("redemption-auto").waitFor({ timeout: 8000 });
}

export function instantA11yStates(dashboardAdvisory) {
  const state = (name, prep, viewport, advisory) => ({ path: null, name, prep, cleanup: instantA11yCleanup, context: {}, ...(viewport ? { viewport } : {}), ...(advisory ? { advisory } : {}) });
  return [
    state("dashboard (instant delivery: codes and masked previews)", openCodeDelivery, null, dashboardAdvisory),
    state("dashboard phone (instant delivery: codes)", openCodeDelivery, PHONE, dashboardAdvisory),
    state("dashboard small phone (instant delivery: replacement consent)", openCodeRemoval, SMALL_PHONE, dashboardAdvisory),
    state("dashboard phone (instant delivery: link validation)", openDeliveryValidation, PHONE, dashboardAdvisory),
    state("fan phone (instant code reveal, reduced motion)", openInstantCodeReveal, PHONE),
    state("fan small phone (saved private reward dialog)", openSavedInstantReward, SMALL_PHONE),
    state("dashboard phone (Auto delivery and view count)", openInstantFulfilment, PHONE, dashboardAdvisory),
  ];
}
