// b6 follow-ups in the browser (demo mode):
//  - "Leave agency" on /agency (0071 org_leave, POST /api/agency/leave). The
//    demo has no agencies, so /api/agency and /api/agency/leave are answered
//    by page.route with the shapes the real routes send; the real routes'
//    refusals (bad org, demo_only, cross-origin) are asserted against the
//    server. NEGATIVE: an owner's console and the demo show no leave control.
//  - Settings › Profile: an e-mail as display name is refused with a clear
//    message (0071 L2/M1), not a generic failure.
//
// Steps that expect a refusal run on their own page with no error sink: the
// refusal is the point of the step.
import { attachSink, BASE, clickTab, goto } from "./harness.mjs";

const ORG = { id: "0a0a0a0a-0000-4000-8000-00000000000a", name: "E2E Talent" };
const overview = (isOwner) => ({
  org: ORG,
  isOwner,
  totals: { creators: 1, fans: 3, spins: 5, pending: 0, revenue: 0 },
  creators: [{ id: "c0c0c0c0-0000-4000-8000-00000000000c", displayName: "Managed Creator", email: "", wheels: 1, fans: 3, spins: 5, pending: 0, revenue: 0 }],
  members: [],
  invites: [],
});
const activeText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

export async function agencyLeaveJourney(browser, { step, assert }, sink, ctx) {
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

  await step("agency leave (negative): an owner's console and the demo have no Leave agency control", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await goto(page, "/agency", 1200);
      await page.getByTestId("agency-demo-only").waitFor({ timeout: 8000 });
      assert((await page.getByTestId("agency-leave").count()) === 0, "the demo's start-an-agency page offers no leave");
      await page.route("**/api/agency", (r) => r.fulfill({ json: overview(true) }));
      await goto(page, "/agency", 1200);
      await page.getByRole("heading", { name: ORG.name, level: 1 }).waitFor({ timeout: 8000 });
      assert(/owner/.test(await page.getByText(/Agency console/).textContent()), "the console says owner");
      assert((await page.getByTestId("agency-leave").count()) === 0, "no leave section for the owner");
      assert((await page.getByRole("button", { name: "Leave agency" }).count()) === 0, "no Leave agency button for the owner");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("agency leave: a managed creator confirms, cancels, sees an error, retries and leaves", async () => {
    const page = await ctx.newPage();
    const posts = [];
    let answers = 0;
    try {
      await page.route("**/api/agency", (r) => r.fulfill({ json: { org: null, managed: true, orgId: ORG.id } }));
      await page.route("**/api/agency/leave", async (r) => {
        posts.push({ method: r.request().method(), type: r.request().headers()["content-type"], body: r.request().postData() });
        answers++;
        if (answers === 1) return r.fulfill({ status: 400, json: { error: "not_member" } });
        await new Promise((resolve) => setTimeout(resolve, 900));
        return r.fulfill({ json: { ok: true } });
      });
      await goto(page, "/agency", 1200);
      await page.getByTestId("agency-managed").waitFor({ timeout: 8000 });
      const start = page.getByRole("button", { name: "Leave agency" });
      await start.waitFor({ timeout: 5000 });

      // Confirmation first; Cancel sends nothing and gives the keyboard back.
      await start.click();
      const confirmGroup = page.getByRole("group", { name: /Leave this agency\?/ });
      await confirmGroup.waitFor({ timeout: 4000 });
      assert((await activeText(page)) === "Cancel", "the confirmation opens on Cancel, the safe choice");
      await page.keyboard.press("Enter");
      await confirmGroup.waitFor({ state: "hidden", timeout: 4000 });
      assert((await activeText(page)) === "Leave agency", "Cancel returns focus to Leave agency");
      assert(posts.length === 0, "nothing is sent before the confirmation");

      // A refusal shows as an alert and keeps the retry.
      await start.click();
      await confirmGroup.getByRole("button", { name: "Yes, leave" }).click();
      const alert = page.getByRole("alert").filter({ hasText: /not in this agency any more/ });
      await alert.waitFor({ timeout: 5000 });
      assert((await activeText(page)) === "Yes, leave", "after the error the keyboard is back on Yes, leave");

      // Pending, then the confirmation view.
      const yes = confirmGroup.getByRole("button", { name: /Yes, leave|Leaving/ });
      await yes.click();
      await confirmGroup.getByRole("button", { name: "Leaving…" }).waitFor({ timeout: 3000 });
      assert(await confirmGroup.getByRole("button", { name: "Leaving…" }).isDisabled(), "the button is disabled while leaving");
      assert(await confirmGroup.getByRole("button", { name: "Cancel" }).isDisabled(), "Cancel is disabled while leaving");
      assert((await confirmGroup.getAttribute("aria-busy")) === "true", "the group is marked busy");
      await page.getByTestId("agency-left").waitFor({ timeout: 6000 });
      assert((await activeText(page)) === "You left the agency", "focus moves to the result heading");
      assert((await page.getByRole("status").filter({ hasText: /can no longer act for your account/ }).count()) === 1, "the result is a status line");
      assert((await page.getByRole("link", { name: /Back to dashboard/ }).getAttribute("href")) === "/dashboard", "a full page load back to the dashboard");

      assert(posts.length === 2, `two POSTs: the refused one and the retry (got ${posts.length})`);
      assert(posts.every((p) => p.method === "POST" && /application\/json/.test(p.type ?? "")), "JSON POSTs");
      assert(posts.every((p) => p.body === JSON.stringify({ orgId: ORG.id })), "each POST names only the org");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("agency leave: a staff seat leaves from the console (phone width)", async () => {
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    attachSink(page, sink);
    try {
      await page.route("**/api/agency", (r) => r.fulfill({ json: overview(false) }));
      await page.route("**/api/agency/leave", (r) => r.fulfill({ json: { ok: true } }));
      await goto(page, "/agency", 1200);
      await page.getByRole("heading", { name: ORG.name, level: 1 }).waitFor({ timeout: 8000 });
      const section = page.getByRole("region", { name: `Leave ${ORG.name}` });
      await section.waitFor({ timeout: 5000 });
      await section.getByRole("button", { name: "Leave agency" }).click();
      await section.getByRole("button", { name: "Yes, leave" }).click();
      await page.getByTestId("agency-left").waitFor({ timeout: 6000 });
      assert((await page.getByRole("status").filter({ hasText: /staff seat has ended/ }).count()) === 1, "the seat ended");
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 0, `/agency overflows by ${over}px at 390`);
    } finally {
      await context.close().catch(() => {});
    }
  });

  await step("agency leave: the real route still refuses a bad org, the demo and a cross-origin write", async () => {
    const post = (data, headers) => ctx.request.post(BASE + "/api/agency/leave", { data, headers });
    const bad = await post({ orgId: "not-a-uuid" });
    assert(bad.status() === 400 && (await bad.json()).error === "invalid_org", "a non-UUID org is 400 invalid_org");
    const demo = await post({ orgId: ORG.id });
    assert(demo.status() === 400 && (await demo.json()).error === "demo_only", "the demo leaves nothing (demo_only)");
    const cross = await post({ orgId: ORG.id }, { origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: "sb-e2e-auth-token=x" });
    assert(cross.status() === 403 && (await cross.json()).error === "forbidden", "a cross-origin cookie write is refused by the proxy");
  });

  await step("settings: an e-mail as display name is refused with a clear message (0071)", async () => {
    const page = await ctx.newPage();
    try {
      await goto(page, "/dashboard", 1500);
      await clickTab(page, "Settings");
      const input = page.getByPlaceholder("Your creator name");
      await input.waitFor({ timeout: 8000 });
      await page.waitForFunction(() => !document.querySelector("input[placeholder='Your creator name']")?.disabled, null, { timeout: 8000 });
      const original = await input.inputValue();
      await input.fill("someone@example.com");
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/account/profile") && r.request().method() === "PUT");
      await page.getByRole("button", { name: "Save profile" }).click();
      const res = await saved;
      const body = await res.json();
      assert(res.status() === 400 && body.error === "name_looks_like_email", `400 name_looks_like_email (got ${res.status()} ${JSON.stringify(body)})`);
      await page.getByText(/can't be or contain an e-mail address/).waitFor({ timeout: 5000 });
      const me = await (await ctx.request.get(BASE + "/api/account")).json().catch(() => ({}));
      assert(me.displayName !== "someone@example.com", "the address was not saved");
      await input.fill(original || "Demo Creator");
    } finally {
      await page.close().catch(() => {});
    }
  });
}
