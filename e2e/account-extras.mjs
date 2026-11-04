// A37 + A36: browser journeys for creator flows no other journey covered:
// DM templates (create → used in the drawer's Copy DM → delete), the Referrals
// card, Autopilot, the Close my account guard rails, and the demo's honest
// "Demo only" states (agency, access requests) plus a link-in-bio save that is
// really kept. MFA enrol/unenrol and agency writes need a real Supabase
// session; they are covered by route tests (src/app/api/account/mfa*,
// mfaSensitiveRoutes.test.ts, demoParity.test.ts) and e2e/supabase.mjs.
//
// Steps that expect a refusal (the demo's 400s) run on their own page with no
// error sink: the refusal is the point of the step.
import { randomUUID } from "node:crypto";
import { BASE, goto, clickTab } from "./harness.mjs";

async function json(response, what) {
  if (!response.ok()) throw new Error(`${what} failed (${response.status()})`);
  return response.json();
}

export async function accountExtrasJourney(page, { step, assert }, ctx) {
  const templateTitle = `E2E invite ${randomUUID().slice(0, 6)}`;
  let originalTagline = null;

  await step("dm templates: add one in Manage messages, use it from the drawer, delete it (A37)", async () => {
    await goto(page, "/dashboard", 1500);
    await clickTab(page, "Fans");
    await page.getByRole("button", { name: /Manage messages/ }).click();
    const dialog = page.getByRole("dialog", { name: "Manage DM templates" });
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByLabel("Title").fill(templateTitle);
    await dialog.getByLabel("Message").fill("Hi {name}! Your spins are waiting: {link}");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/dm-templates") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Add template" }).click();
    assert((await saved).ok(), "the template is saved");
    await dialog.getByText(templateTitle).waitFor({ timeout: 5000 });
    const listed = (await json(await ctx.request.get(BASE + "/api/dm-templates"), "read templates")).templates;
    assert(listed.some((t) => t.title === templateTitle), "the server lists the new template");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 4000 });

    await page.getByRole("button", { name: "View Demo Fan" }).click();
    const drawer = page.getByRole("dialog", { name: "Fan details" });
    await drawer.waitFor({ timeout: 5000 });
    const trigger = drawer.getByRole("button", { name: /^Copy DM/ });
    await trigger.waitFor({ timeout: 5000 });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "DM templates" });
    await menu.waitFor({ timeout: 4000 });
    assert(await menu.getByRole("menuitem", { name: new RegExp(templateTitle) }).count(), "the drawer's Copy DM menu offers the new template");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});

    await page.getByRole("button", { name: /Manage messages/ }).click();
    await dialog.waitFor({ timeout: 5000 });
    const deleted = page.waitForResponse((r) => r.url().includes("/api/dm-templates/") && r.request().method() === "DELETE");
    await dialog.getByRole("button", { name: `Delete template ${templateTitle}` }).click();
    assert((await deleted).ok(), "the template is deleted");
    await dialog.getByText(templateTitle).waitFor({ state: "hidden", timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  await step("referrals: the Boosts Referrals card shows the server's own counts (A37)", async () => {
    const stats = await json(await ctx.request.get(BASE + "/api/referrals/stats"), "read referral stats");
    for (const key of ["referredCount", "creditedCount", "bonusAwarded"]) {
      assert(Number.isInteger(stats[key]) && stats[key] >= 0, `stats.${key} is a count`);
    }
    await goto(page, "/dashboard", 1200);
    await clickTab(page, "Boosts");
    const card = page.getByRole("region", { name: /^Referrals/ });
    await card.waitFor({ timeout: 8000 });
    const shown = async () => card.evaluate((root) => Object.fromEntries([...root.querySelectorAll("dl > div")].map((cell) => [cell.querySelector("dt")?.textContent?.trim(), Number(cell.querySelector("dd")?.textContent?.trim())])));
    const want = { Referred: stats.referredCount, Credited: stats.creditedCount, "Bonus spins": stats.bonusAwarded };
    await page.waitForFunction(() => document.querySelector("#boosts-referrals")).catch(() => {});
    const got = await shown();
    assert(JSON.stringify(got) === JSON.stringify(want), `the card shows the server's counts (saw ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  });

  await step("autopilot: the demo says 'Demo only', never 'all caught up' (A36/A37)", async () => {
    const feed = await json(await ctx.request.get(BASE + "/api/autopilot"), "read autopilot");
    assert(Array.isArray(feed.cards) && feed.demo === true, "the demo feed reports demo");
    const refused = await ctx.request.post(BASE + "/api/autopilot", { data: { key: "fulfil" } });
    assert(refused.status() === 400 && (await refused.json()).error === "demo_only", "a demo dismissal is refused as demo_only, not a silent ok");
    await goto(page, "/dashboard", 1500);
    const note = page.getByTestId("autopilot-demo-only");
    await note.waitFor({ timeout: 10000 });
    assert(/Demo only/.test(await note.innerText()), "Needs you now says Demo only");
    const feedSection = page.locator("section[aria-labelledby='needs-you-now']");
    assert((await feedSection.getByText("You’re all caught up").count()) === 0, "it never claims the creator is all caught up");
  });

  await step("account close: guarded by password + exact phrase; the demo closes nothing (A37)", async () => {
    const other = await ctx.newPage();
    try {
      await goto(other, "/dashboard", 1500);
      await clickTab(other, "Settings");
      const card = other.getByRole("region", { name: "Close my account" });
      await card.getByRole("button", { name: "Close my account…" }).click();
      const go = card.getByRole("button", { name: "Permanently close my account" });
      await go.waitFor({ timeout: 5000 });
      assert(await go.isDisabled(), "off with nothing typed");
      await card.getByLabel("Current password").fill("demo-password");
      await card.getByLabel("Type DELETE MY ACCOUNT").fill("delete my account");
      assert(await go.isDisabled(), "off until the phrase matches exactly");
      await card.getByLabel("Type DELETE MY ACCOUNT").fill("DELETE MY ACCOUNT");
      assert(!(await go.isDisabled()), "on with a password and the exact phrase");
      const answered = other.waitForResponse((r) => r.url().endsWith("/api/account/close"));
      await go.click();
      const res = await answered;
      assert(res.status() === 400 && (await res.json()).error === "demo_mode", "the demo refuses to close an account");
      await card.getByRole("alert").filter({ hasText: /demo mode/ }).waitFor({ timeout: 5000 });
      assert(new URL(other.url()).pathname === "/dashboard", "the creator stays signed in on the dashboard");
      assert((await card.getByLabel("Current password").inputValue()) === "", "the password is cleared after the attempt");
      await card.getByRole("button", { name: "Cancel" }).click();
      await card.getByRole("button", { name: "Close my account…" }).waitFor({ timeout: 4000 });
      assert((await ctx.request.get(BASE + "/api/me")).ok(), "the account still answers");
    } finally {
      await other.close().catch(() => {});
    }
  });

  await step("agency + access requests: the demo says 'Demo only' and saves nothing (A36)", async () => {
    const other = await ctx.newPage();
    try {
      await goto(other, "/agency", 1200);
      const demo = other.getByTestId("agency-demo-only");
      await demo.waitFor({ timeout: 8000 });
      await other.getByPlaceholder("Agency name").fill("E2E Agency");
      const created = other.waitForResponse((r) => r.url().endsWith("/api/agency/manage"));
      await other.getByRole("button", { name: "Create agency" }).click();
      const res = await created;
      assert(res.status() === 400 && (await res.json()).error === "demo_only", "creating an agency is demo_only");
      await other.getByRole("alert").filter({ hasText: /nothing was saved/ }).waitFor({ timeout: 5000 });
      const agency = await json(await ctx.request.get(BASE + "/api/agency"), "read agency");
      assert(agency.org === null && agency.demo === true, "still no agency, and the read says demo");

      await goto(other, "/dashboard?section=admin", 1500);
      await other.getByTestId("admin-requests-demo").waitFor({ timeout: 10000 });
    } finally {
      await other.close().catch(() => {});
    }
  });

  await step("agency link: the Account group links to /agency, which restyled says 'Demo only' (A45/A53)", async () => {
    const other = await ctx.newPage();
    try {
      await goto(other, "/dashboard", 1500);
      const nav = other.getByRole("navigation", { name: "Dashboard sections" }).getByTestId("nav-agency");
      await nav.waitFor({ timeout: 8000 });
      assert((await nav.getAttribute("href")) === "/agency", "the Agency item links to /agency");
      assert((await nav.textContent())?.trim() === "Agency", "the item reads Agency");
      await Promise.all([other.waitForURL((u) => u.pathname === "/agency", { timeout: 15000 }), nav.click()]);
      await other.getByTestId("agency-demo-only").waitFor({ timeout: 8000 });
      const bg = await other.evaluate(() => getComputedStyle(document.querySelector("main")).backgroundColor);
      assert(bg === "rgb(12, 10, 14)", `the page uses the redesign base colour (got ${bg})`);
      await other.getByRole("link", { name: /Back to dashboard/ }).waitFor({ timeout: 4000 });
    } finally {
      await other.close().catch(() => {});
    }
  });

  await step("public page: a demo link-in-bio save is kept and shows on /c/ (A36)", async () => {
    const before = await json(await ctx.request.get(BASE + "/api/public-profile"), "read public profile");
    originalTagline = before.tagline ?? "";
    await goto(page, "/dashboard", 1200);
    await clickTab(page, "Settings");
    const pub = page.locator("section[aria-labelledby='settings-public']");
    const tagline = pub.getByPlaceholder(/Spin my wheel/);
    await tagline.waitFor({ timeout: 8000 });
    // The card fills itself from GET /api/public-profile after it renders; typing
    // before that lands lets the load overwrite the new tagline. The demo slug is
    // never empty, so a filled slug means the saved fields are in.
    const slug = pub.getByPlaceholder("your-name");
    await page.waitForFunction((el) => el && el.value !== "", await slug.elementHandle(), { timeout: 8000 });
    const value = `Spin with me ${randomUUID().slice(0, 4)}`;
    await tagline.fill(value);
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/public-profile") && r.request().method() === "PUT");
    await pub.getByRole("button", { name: /^Save$/ }).click();
    const put = await saved;
    assert(put.ok(), "the save is accepted");
    assert(put.request().postDataJSON()?.tagline === value, "the save sent the typed tagline");
    const after = await json(await ctx.request.get(BASE + "/api/public-profile"), "read public profile again");
    assert(after.tagline === value, "the demo really kept the tagline");
    // The save revalidates /c/<slug> (ISR); the next visits render the new tagline.
    let fresh = false;
    for (let i = 0; i < 4 && !fresh; i++) {
      await goto(page, `/c/${after.slug}`, 400 + i * 600);
      fresh = (await page.locator("main").innerText()).includes(value);
    }
    assert(fresh, "the public page shows the saved tagline");
  });

  // Leave the demo profile as we found it.
  if (originalTagline !== null) {
    await ctx.request.put(BASE + "/api/public-profile", { data: { tagline: originalTagline } }).catch(() => {});
  }
}
