// Real creator writes with dropped browser delivery. No response terms or
// economic outcomes are rewritten, and every replay retains its original ID.
import { randomUUID } from "node:crypto";
import { BASE, goto, clickTab } from "./harness.mjs";
import { instantFixture } from "./instant.mjs";
import { json } from "./focus.mjs";

const grantState = (request, fixture) => request.get(`${BASE}/api/fans/${fixture.fanId}`).then(response => json(response, "read current grant terms"));
async function openCreatorFan(page, fixture) {
  await goto(page, "/dashboard", 300);
  await clickTab(page, "Fans");
  await page.getByRole("button", { name: `View ${fixture.name}`, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Fan details" });
  await drawer.waitFor({ timeout: 8000 });
  return drawer;
}
async function beginEdit(drawer, spins) {
  const row = drawer.locator("li").filter({ hasText: new RegExp(`^\\s*\\+${spins}\\b`) });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const form = drawer.getByTestId("grant-edit-form");
  await form.waitFor();
  return form;
}
const readGrant = (detail, grantId) => detail.grants.find(grant => grant.id === grantId);

export async function creatorRecoveryJourney(page, { step, assert }, ctx) {
  let fixture; let grantId; let drawer; let form; let firstBody; let cancelledBody;
  try {
    await step("creator edit: lost reply locks the original patch and stores only an opaque receipt", async () => {
      fixture = await instantFixture(ctx.request, "Creator retry", 5);
      const initial = await grantState(ctx.request, fixture);
      grantId = initial.grants.find(grant => grant.spins === 10)?.id;
      assert(grantId, "owned ten-spin grant exists");
      drawer = await openCreatorFan(page, fixture);
      form = await beginEdit(drawer, 10);
      await form.getByLabel("Spins", { exact: true }).fill("20");
      await page.route(`**/api/grants/${grantId}`, async route => {
        firstBody = route.request().postDataJSON();
        await json(await route.fetch(), "commit original edit before lost response");
        await route.abort("aborted");
      });
      await form.getByTestId("grant-edit-save").click();
      await form.getByTestId("creator-request-recovery").waitFor({ timeout: 8000 });
      assert(await form.getByLabel("Spins", { exact: true }).isDisabled(), "unknown edit cannot change its original fields");
      const saved = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`ff:creator-intent:grant-edit:${id}`)), grantId);
      assert(saved.id === firstBody.requestId && Object.keys(saved).sort().join(",") === "id,signature", "browser receipt contains only UUID and request hash");
      assert(readGrant(await grantState(ctx.request, fixture), grantId).spins === 20, "server committed the first edit despite dropped delivery");
      await page.unroute(`**/api/grants/${grantId}`);
    });
    await step("creator edit: replay cannot overwrite a newer edit or add duplicate credits", async () => {
      await json(await ctx.request.patch(`${BASE}/api/grants/${grantId}`, { data: { requestId: randomUUID(), spins: 12 } }), "make a later independent edit");
      const wait = page.waitForRequest(request => request.url().endsWith(`/api/grants/${grantId}`) && request.method() === "PATCH");
      wait.catch(() => {});
      await form.getByTestId("grant-edit-save").click();
      const retry = (await wait).postDataJSON();
      assert(JSON.stringify(retry) === JSON.stringify(firstBody), "explicit retry preserves exact original body and identity");
      await form.waitFor({ state: "hidden", timeout: 8000 });
      const current = await grantState(ctx.request, fixture);
      assert(readGrant(current, grantId).spins === 12 && current.spinsRemaining === 12, "newer twelve-spin terms and balance survive old twenty-spin replay");
      assert((await drawer.locator("li").filter({ hasText: /^\s*\+12\b/ }).innerText()).includes("+12"), "UI refreshes current terms instead of displaying the old receipt terms");
    });
    await step("creator edit: reload recovers by Check outcome without persisting private form fields", async () => {
      form = await beginEdit(drawer, 12);
      await form.getByLabel("Spins", { exact: true }).fill("14");
      await page.route(`**/api/grants/${grantId}`, async route => {
        await json(await route.fetch(), "commit edit before reload");
        await route.abort("aborted");
      });
      await form.getByTestId("grant-edit-save").click();
      await form.getByTestId("creator-request-recovery").waitFor({ timeout: 8000 });
      await page.unroute(`**/api/grants/${grantId}`);
      await json(await ctx.request.patch(`${BASE}/api/grants/${grantId}`, { data: { requestId: randomUUID(), spins: 13 } }), "edit again before recovery reload");
      // Real reload: the draft guard remains enabled; explicitly accept this
      // intentional reload without leaving a dialog listener on the page.
      const acceptReload = dialog => dialog.accept();
      page.on("dialog", acceptReload);
      try { await page.reload(); } finally { page.off("dialog", acceptReload); }
      await clickTab(page, "Fans");
      await page.getByRole("button", { name: `View ${fixture.name}`, exact: true }).click();
      drawer = page.getByRole("dialog", { name: "Fan details" });
      form = drawer.getByTestId("grant-edit-form");
      await form.getByTestId("creator-request-check").waitFor({ timeout: 8000 });
      assert(await form.getByLabel("Spins", { exact: true }).isDisabled() && await form.getByTestId("grant-edit-save").isDisabled(), "reloaded opaque receipt permits status checks, not a reconstructed private edit");
      await form.getByTestId("creator-request-check").click();
      await form.waitFor({ state: "hidden", timeout: 8000 });
      const current = await grantState(ctx.request, fixture);
      assert(readGrant(current, grantId).spins === 13 && current.spinsRemaining === 13, "status recovery preserves newest thirteen-spin terms without applying again");
    });
    await step("creator edit: confirmed cancellation fences an edit that never reached the server", async () => {
      form = await beginEdit(drawer, 13);
      await form.getByLabel("Spins", { exact: true }).fill("15");
      await page.route(`**/api/grants/${grantId}`, async route => { cancelledBody = route.request().postDataJSON(); await route.abort("aborted"); });
      await form.getByTestId("grant-edit-save").click();
      await form.getByTestId("creator-request-cancel").waitFor({ timeout: 8000 });
      await page.unroute(`**/api/grants/${grantId}`);
      await form.getByTestId("creator-request-cancel").click();
      await form.getByTestId("creator-request-cancel-confirm").click();
      await form.getByRole("status").filter({ hasText: /Cancellation confirmed/ }).waitFor({ timeout: 8000 });
      const late = await ctx.request.patch(`${BASE}/api/grants/${grantId}`, { data: cancelledBody });
      assert(!late.ok(), "late delivery of the cancelled identity cannot commit");
      const current = await grantState(ctx.request, fixture);
      assert(readGrant(current, grantId).spins === 13 && current.spinsRemaining === 13, "cancelled edit changes no terms or credits");
      assert(await page.evaluate(id => sessionStorage.getItem(`ff:creator-intent:grant-edit:${id}`) === null, grantId), "only verified cancellation releases the local receipt");
      await form.getByRole("button", { name: "Discard edits", exact: true }).click();
      await form.waitFor({ state: "hidden", timeout: 4000 });
    });
  } finally {
    if (grantId) await page.unroute(`**/api/grants/${grantId}`).catch(() => {});
    if (fixture) {
      // Cleanup follows verified terminal cases in the journey. No browser
      // storage is silently cleared to conceal an unresolved operation.
      await json(await ctx.request.delete(`${BASE}/api/fans/${fixture.fanId}`), "erase creator retry fixture fan");
      await json(await ctx.request.delete(`${BASE}/api/wheels/${fixture.wheel.id}`), "archive creator retry fixture wheel");
    }
  }
}
