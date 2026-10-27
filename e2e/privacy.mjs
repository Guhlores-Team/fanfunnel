// Privacy self-service journey (privacy & safety pack). Runs on its own
// throwaway fan link, never the demo link, and before the first-run wipe.
//
// Covers: a fan downloads ONLY their own data from the Safety menu (no other
// fan, full link code never in the file); a made-up token gets nothing; a fan
// deletes their data (typed confirm, plain explanation, the link then explains
// itself instead of 404ing); the creator gets a notice that names nobody; a
// dead link's 404 still offers the data controls; the creator downloads their
// own account data from Settings. Closing the creator's account is NOT run
// here (it would end the demo session); its route tests cover it.

import { readFileSync } from "node:fs";
import { goto, clickTab, passAgeGate, BASE } from "./harness.mjs";

const FAN_NAME = "Privacy Fan";

async function readDownload(page, trigger) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), trigger()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), json: JSON.parse(readFileSync(path, "utf8")) };
}

export async function privacyJourney(page, { step, assert }, ctx) {
  let token = null;
  const safety = () => page.getByRole("button", { name: "Safety & privacy" }).first();
  const dialog = () => page.getByRole("dialog", { name: "Safety and privacy" });

  await step("privacy: mint a throwaway fan link (setup)", async () => {
    const res = await ctx.request.post(BASE + "/api/passes", { data: { name: FAN_NAME, spins: 2 } });
    assert(res.ok(), `minted a link (${res.status()})`);
    token = (await res.json()).token;
    assert(typeof token === "string" && token.length > 8, "got a token");
  });

  await step("privacy: a fan downloads only their own data", async () => {
    await goto(page, `/spin/${token}`, 1600);
    await passAgeGate(page);
    await safety().click();
    await dialog().waitFor({ timeout: 5000 });
    const { name, json } = await readDownload(page, () =>
      dialog().getByRole("button", { name: /Download my data/ }).click()
    );
    assert(/^fanfunnel-my-data-.*\.json$/.test(name), `file name (${name})`);
    assert(json.format === "fanfunnel.fan-data.v1", "fan export format");
    assert(json.profile?.displayName === FAN_NAME, `it is this fan's file (${json.profile?.displayName})`);
    const text = JSON.stringify(json);
    assert(!text.includes("Demo Fan"), "no other fan's data in the file");
    assert(!text.includes(token), "the full link code is never in the file");
    assert(json.links?.length >= 1 && json.links.every((l) => /^….{0,4}$/.test(l.linkEndsWith)), "links are masked");
    assert(json.consents?.ageAndTermsAcceptedAt, "the age/terms consent is included");
    const status = dialog().getByRole("status");
    await status.waitFor({ timeout: 5000 });
    assert(/downloading/i.test(await status.innerText()), "the fan is told the download started");
    await dialog().getByRole("button", { name: "Close" }).click();
    await dialog().waitFor({ state: "hidden", timeout: 4000 });
  });

  await step("privacy: the fan export refuses a made-up link and is never cached", async () => {
    const res = await ctx.request.post(BASE + "/api/fan-data/export", { data: { token: "not-a-real-link-0000" } });
    assert(res.status() === 404, `made-up token → 404 (got ${res.status()})`);
    assert(/no-store/.test(res.headers()["cache-control"] ?? ""), "no-store on the refusal");
  });

  await step("privacy: a fan deletes their data, and the link then explains itself", async () => {
    await safety().click();
    await dialog().waitFor({ timeout: 5000 });
    await dialog().getByRole("button", { name: /Delete my data/ }).click();
    const confirm = dialog().getByRole("button", { name: "Delete my data permanently" });
    assert(/Your past spins stay/.test(await dialog().innerText()), "the fan is told exactly what happens");
    assert(await confirm.isDisabled(), "delete is disabled until the word is typed");
    await dialog().getByLabel("Type DELETE to confirm").fill("DELETE");
    const deleted = page
      .waitForResponse((r) => r.url().includes("/api/fan-data/delete") && r.request().method() === "POST")
      .catch(() => null);
    await confirm.click();
    const res = await deleted;
    assert(res && res.ok(), `delete accepted (${res?.status()})`);
    assert(/no-store/.test(res.headers()["cache-control"] ?? ""), "no-store on the delete");
    const status = dialog().getByRole("status");
    await status.waitFor({ timeout: 5000 });
    assert(/Your data was deleted/.test(await status.innerText()), "the fan sees the confirmation");
    await Promise.all([
      page.waitForEvent("load", { timeout: 20000 }),
      dialog().getByRole("button", { name: "Close" }).click(),
    ]);
    await page.getByRole("heading", { name: "This link was deleted" }).waitFor({ timeout: 10000 });
    assert(await page.getByRole("heading", { name: "This link was deleted" }).count(), "the dead link explains why");
  });

  await step("privacy: after delete the link's data is gone and the creator is told without a name", async () => {
    const res = await ctx.request.post(BASE + "/api/fan-data/export", { data: { token } });
    assert(res.status() === 404, `export after delete → 404 (got ${res.status()})`);
    const feed = await (await ctx.request.get(BASE + "/api/notifications")).json();
    const notice = feed.items.find((i) => i.kind === "fan_deleted");
    assert(notice, "the creator has a 'fan deleted their data' notice");
    assert(!JSON.stringify(notice).includes(FAN_NAME), "the notice does not name the fan");
  });

  await step("privacy: a dead link's 404 still offers the data controls", async () => {
    // A page with no error sink: this 404 is the expected outcome, not a signal.
    const probe = await ctx.newPage();
    try {
      const res = await probe.goto(BASE + "/spin/no-such-link-0000", { waitUntil: "domcontentloaded", timeout: 45000 });
      assert(res?.status() === 404, `unknown link stays a 404 (got ${res?.status()})`);
      const rescue = probe.getByRole("button", { name: "Was this your link? Download or delete your data" });
      await rescue.waitFor({ timeout: 10000 });
      assert((await rescue.getAttribute("aria-expanded")) === "false", "the rescue is a collapsed disclosure");
      await rescue.click();
      await probe.getByRole("button", { name: "Delete my data" }).waitFor({ timeout: 4000 });
      assert(await probe.getByRole("button", { name: "Download my data" }).count(), "both data controls open on the 404");
    } finally {
      await probe.close();
    }
  });

  await step("privacy: the creator downloads their own account data from Settings", async () => {
    await goto(page, "/dashboard", 1800);
    await clickTab(page, "Settings");
    const btn = page.getByRole("button", { name: "Download my data" });
    await btn.waitFor({ timeout: 10000 });
    const { name, json } = await readDownload(page, () => btn.click());
    assert(/^fanfunnel-account-data-.*\.json$/.test(name), `file name (${name})`);
    assert(json.format === "fanfunnel.creator-data.v1", "creator export format");
    assert(json.sections && typeof json.sections === "object", "has sections");
    assert(!JSON.stringify(json).includes(token), "no full fan link code in the file");
    assert(await page.getByRole("button", { name: /Close my account/ }).count(), "Close my account is offered");
  });
}
