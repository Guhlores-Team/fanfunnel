// b7 dashboard gaps in the browser (demo mode):
//  RD-01/09 a failed Settings / Inbox auto-messages read is a failure with
//           Retry and Save stays off, so one Save can never wipe the public
//           page or the auto-messages.
//  RD-02/03/04 agency, admin and seat reads that fail say so (never "Start
//           your agency" / "No creator accounts yet").
//  RD-05/10 + WC-01 a refused grant (4xx) names the reason, keeps the form
//           usable and leaves no receipt; decimals and empty handles are
//           refused before any request.
//  RD-06    a typed due date saves once, as a complete date; year 2 is refused.
//  RD-07    campaign "pending" drops when a win is cancelled.
//  RD-08    Today's date is the browser's day, in any zone.
//  RD-21    toasts are regions with sibling buttons; errors are alerts.
//  WC-02/03/06 the minted card is focused; Set active asks first and offers
//           Undo; Start / Mark fulfilled offer Undo.
//  WG-12    reactivate / demote ask first (admin demo accounts).
// Steps that answer API calls with errors run on their own page with no error
// sink: the failures are the point of the step. Every fixture is removed again.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, goto } from "./harness.mjs";
import { json } from "./focus.mjs";

const path = (p) => (url) => url.pathname === p;
const answer = (status, error = status === 429 ? "rate_limited" : "boom") => (route) => route.fulfill({ status, json: { error } });

export async function dashB7Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;

  await step("b7 RD-01: a failed public-profile read shows Retry and keeps Save off; Retry restores the saved text", async () => {
    const page = await ctx.newPage();
    const before = await json(await request.get(BASE + "/api/public-profile"), "read profile");
    await json(await request.put(BASE + "/api/public-profile", { data: { tagline: "b7 keep me", note: "b7 hey fans" } }), "seed profile");
    const puts = [];
    page.on("request", (r) => { if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/public-profile") puts.push(r.postData()); });
    try {
      const profile = path("/api/public-profile");
      await page.route(profile, (route) => (route.request().method() === "GET" ? answer(429)(route) : route.continue()));
      await goto(page, "/dashboard?section=settings", 1200);
      const failed = page.getByTestId("settings-public-load-failed");
      await failed.waitFor({ timeout: 10000 });
      assert(/Too many requests/.test(await failed.innerText()), "the Public page card says the read was rate-limited");
      const save = page.locator('section[aria-labelledby="settings-public"]').getByRole("button", { name: "Save", exact: true });
      assert(await save.isDisabled(), "Save is disabled until the profile loaded");
      assert(await page.getByLabel("Tagline").inputValue() === "", "the fields are empty, not pretending to be loaded");
      await page.unroute(profile);
      await failed.getByRole("button", { name: "Retry" }).click();
      await failed.waitFor({ state: "detached", timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('section[aria-labelledby="settings-public"] input[placeholder*="spin away"], section[aria-labelledby="settings-public"] input')?.value !== undefined);
      await page.waitForTimeout(400);
      assert(await page.getByLabel("Tagline").inputValue() === "b7 keep me", "Retry brought the saved tagline back");
      assert(await save.isEnabled(), "Save is enabled once loaded");
      assert(puts.length === 0, "no PUT was ever sent while the read had failed");
      const after = await json(await request.get(BASE + "/api/public-profile"), "re-read profile");
      assert(after.tagline === "b7 keep me" && after.note === "b7 hey fans", "the profile was never wiped");
    } finally {
      await page.close().catch(() => {});
      await request.put(BASE + "/api/public-profile", { data: { tagline: before.tagline ?? "", note: before.note ?? "", tipUrl: before.tipUrl ?? "" } }).catch(() => {});
    }
  });

  await step("b7 RD-01/RD-09: failed auto-messages and account reads show Retry with Save off", async () => {
    const page = await ctx.newPage();
    try {
      await page.route(path("/api/chat-settings"), (route) => (route.request().method() === "GET" ? answer(500)(route) : route.continue()));
      await page.route(path("/api/account"), (route) => (route.request().method() === "GET" ? answer(500)(route) : route.continue()));
      await goto(page, "/dashboard?section=inbox", 1200);
      await page.getByRole("button", { name: /Auto-messages/ }).click();
      const failed = page.getByTestId("auto-messages-load-failed");
      await failed.waitFor({ timeout: 10000 });
      const save = page.locator("#auto-messages-form").getByRole("button", { name: "Save" });
      assert(await save.isDisabled(), "auto-messages Save is off after a failed read");
      await goto(page, "/dashboard?section=settings", 1200);
      await page.getByTestId("settings-account-load-failed").waitFor({ timeout: 10000 });
      await page.getByTestId("settings-notifications-load-failed").waitFor({ timeout: 10000 });
      assert(await page.getByRole("button", { name: "Save profile" }).isDisabled(), "Save profile is off after a failed account read");
      assert(await page.getByRole("button", { name: "New spins & wins" }).isDisabled(), "notification switches are off after a failed read");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b7 RD-02/RD-03: failed agency and admin reads are failures with Retry, never empty states", async () => {
    const page = await ctx.newPage();
    try {
      await page.route(path("/api/agency"), answer(429));
      await goto(page, "/agency", 800);
      await page.getByTestId("agency-load-failed").waitFor({ timeout: 10000 });
      assert((await page.getByText("Start your agency").count()) === 0, "no 'Start your agency' after a failed read");
      assert((await page.getByRole("button", { name: "Create agency" }).count()) === 0, "no create button either");
      await page.unrouteAll();
      await page.route(path("/api/admin"), answer(500));
      await goto(page, "/dashboard?section=admin", 800);
      await page.getByTestId("admin-load-failed").waitFor({ timeout: 10000 });
      assert((await page.getByText("No creator accounts yet.").count()) === 0, "admin never claims there are no accounts");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b7 RD-05 + WC-01: decimals and empty handles are refused before any request; a 400 releases the form and leaves no receipt", async () => {
    const page = await ctx.newPage();
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/passes") posts.push(r.postData()); });
    try {
      await goto(page, "/dashboard?section=fans", 1200);
      const form = page.locator("fieldset").filter({ has: page.getByPlaceholder("@username") }).first();
      const spins = form.getByLabel("Spins", { exact: true });
      assert((await spins.getAttribute("step")) === "1", "the spins field is a whole-number field");
      await form.getByPlaceholder("@username").fill("b7-decimal");
      await spins.fill("2.5");
      await form.getByRole("button", { name: "Create" }).click();
      const toast = page.locator('[data-testid="toast"]').filter({ hasText: /whole number/ });
      await toast.waitFor({ timeout: 5000 });
      assert((await toast.getAttribute("role")) === "alert", "a refusal toast is an alert (RD-21)");
      assert((await toast.locator("button button").count()) === 0, "no control is nested in another (RD-21)");
      assert(posts.length === 0, "nothing was sent for a decimal");
      assert(!(await form.isDisabled()), "the form is not locked");
      await spins.fill("2");
      await form.getByPlaceholder("@username").fill("   ");
      await form.getByRole("button", { name: "Create" }).click();
      await page.locator('[data-testid="toast"]').filter({ hasText: /handle or name/ }).waitFor({ timeout: 5000 });
      assert(posts.length === 0, "nothing was sent for an empty handle");

      // The API refuses the same on its own (name_required / bad_request).
      const empty = await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "  ", spins: 2 } });
      assert(empty.status() === 400 && (await empty.json()).error === "name_required", "POST /api/passes refuses an empty handle with 400 name_required");
      const decimal = await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "b7 api", spins: 2.5 } });
      assert(decimal.status() === 400, "POST /api/passes refuses a decimal spin count with 400");

      // A definitive server refusal: the form is released, the reason named, no receipt kept.
      await page.route(path("/api/passes"), (route) => (route.request().method() === "POST" ? answer(400, "no_wheel")(route) : route.continue()));
      await form.getByPlaceholder("@username").fill("b7-refused");
      await form.getByRole("button", { name: "Create" }).click();
      await page.locator('[data-testid="toast"]').filter({ hasText: /Create and save a game first/ }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
      assert((await page.getByText("This request is not yet confirmed").count()) === 0, "a refusal never shows the 'not yet confirmed' lock");
      assert((await form.getByRole("button", { name: "Create" }).count()) === 1, "the button still says Create, not 'Check this link again'");
      const receipts = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes("creator-intent")));
      assert(receipts.length === 0, `no receipt survives a refusal (${receipts.join(",")})`);
      assert((await page.locator('[data-testid="toast"]').filter({ hasText: /couldn.t confirm/i }).count()) === 0, "no 'couldn't confirm' wording for a refusal (RD-10)");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b7 RD-06 + WC-06: a typed due date saves once as a full date, year 2 is refused, Start offers Undo", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `@b7due${Date.now().toString(36)}`;
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2 } }), "create due fan");
    const patches = [];
    page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/api/redemptions/")) patches.push(JSON.parse(r.postData() || "{}")); });
    try {
      await json(await acknowledgeFixtureFan(request, fan.token), "ack due fan");
      await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "b7-due" } }), "fan plays");
      const overview = await json(await request.get(BASE + "/api/overview"), "read overview");
      const win = overview.redemptions.find((r) => r.fanName === name && r.status === "pending");
      assert(win, "the win is pending");
      const bad = await request.patch(BASE + `/api/redemptions/${win.id}`, { data: { dueAt: "0002-12-25" } });
      assert(bad.status() === 400 && (await bad.json()).error === "bad_due_date", "the server refuses the year 2");

      await goto(page, "/dashboard?section=prizes", 1200);
      const row = page.locator("li").filter({ hasText: name }).first();
      await row.waitFor({ timeout: 10000 });
      const date = row.locator('input[type="date"]');
      await date.focus();
      await page.keyboard.type("12");
      await page.keyboard.type("25");
      await page.keyboard.type("2027");
      await page.waitForTimeout(800);
      assert(patches.length === 1, `exactly one PATCH for a typed date (got ${patches.length}: ${JSON.stringify(patches)})`);
      assert(patches[0].dueAt === "2027-12-25", `the full date was saved (${patches[0].dueAt})`);
      assert((await row.getByText("Overdue").count()) === 0, "a future date is not overdue");

      await row.getByRole("button", { name: /^Start:/ }).click();
      const undo = page.locator('[data-testid="toast"]').filter({ hasText: /Marked in progress/ });
      await undo.waitFor({ timeout: 5000 });
      await undo.getByRole("button", { name: "Undo" }).click();
      await page.waitForTimeout(800);
      const after = await json(await request.get(BASE + "/api/overview"), "re-read overview");
      assert(after.redemptions.find((r) => r.id === win.id)?.status === "pending", "Undo put the win back to pending");
    } finally {
      await page.close().catch(() => {});
      await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 RD-07: a cancelled win leaves the campaign's pending count", async () => {
    const name = `@b7camp${Date.now().toString(36)}`;
    const campaignId = (await json(await request.post(BASE + "/api/campaigns", { data: { name: `b7 ${Date.now().toString(36)}` } }), "create campaign")).campaign.id;
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2, campaignId } }), "create campaign fan");
    try {
      await json(await acknowledgeFixtureFan(request, fan.token), "ack campaign fan");
      await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "b7-c1" } }), "spin 1");
      await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "b7-c2" } }), "spin 2");
      const statsFor = async () => (await json(await request.get(BASE + "/api/campaigns/stats"), "stats")).stats.find((s) => s.campaign.id === campaignId);
      const before = await statsFor();
      assert(before && before.pending === 2, `two wins pending before (got ${before?.pending})`);
      const overview = await json(await request.get(BASE + "/api/overview"), "overview");
      const win = overview.redemptions.find((r) => r.fanName === name && r.status === "pending");
      await json(await request.patch(BASE + `/api/redemptions/${win.id}`, { data: { status: "cancelled" } }), "cancel one");
      const after = await statsFor();
      assert(after.pending === 1, `pending drops to 1 after a cancel (got ${after.pending})`);
    } finally {
      await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
      if (campaignId) await request.delete(BASE + `/api/campaigns/${campaignId}`).catch(() => {});
    }
  });

  await step("b7 RD-08: Today's date is the browser's day in its own zone, with no hydration warning", async () => {
    for (const tz of ["Pacific/Honolulu", "Pacific/Kiritimati"]) {
      const c = await browser.newContext({ timezoneId: tz, locale: "en-US", viewport: { width: 1280, height: 900 } });
      const page = await c.newPage();
      const errors = [];
      page.on("console", (m) => { if (/hydrat|did not match/i.test(m.text())) errors.push(m.text()); });
      try {
        await goto(page, "/dashboard?section=today", 1500);
        const shown = await page.getByTestId("today-date").innerText();
        const expected = await page.evaluate(() => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
        assert(shown === expected, `${tz}: header shows ${shown}, the browser's day is ${expected}`);
        assert(errors.length === 0, `${tz}: no hydration warning (${errors.join(" | ")})`);
      } finally {
        await c.close().catch(() => {});
      }
    }
  });

  await step("b7 WC-02 + WC-03: the minted card takes focus; Set active asks first, names what changes, and offers Undo", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `@b7mint${Date.now().toString(36)}`;
    let token = null;
    let dupId = null;
    try {
      await goto(page, "/dashboard?section=fans", 1200);
      const form = page.locator("fieldset").filter({ has: page.getByPlaceholder("@username") }).first();
      await form.getByPlaceholder("@username").fill(name);
      await form.getByRole("button", { name: "Create" }).click();
      const card = page.getByTestId("minted-link");
      await card.waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
      assert(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "minted-link"), "the link card has focus after minting");
      token = (await card.getByLabel(`Spin link for ${name}`).inputValue()).split("/spin/")[1];
      assert((await page.locator('[data-testid="toast"]').count()) <= 1, "toasts do not stack after a mint");

      // A second ready game (a duplicate of the live one) to make live.
      const list = (await json(await request.get(BASE + "/api/wheels"), "list games")).wheels;
      const live = list.find((w) => w.isActive) ?? list[0];
      const dup = await json(await request.post(BASE + `/api/wheels/${live.id}/duplicate`), "duplicate the live game");
      dupId = dup.wheel.id;
      await goto(page, "/dashboard?section=editor", 1500);
      const switcher = page.locator("section[aria-label='Game switcher']");
      const dupTitle = (await json(await request.get(BASE + "/api/wheels"), "list again")).wheels?.find((w) => w.id === dupId)?.title ?? `${live.title} (copy)`;
      const setActive = switcher.getByRole("button", { name: `Set ${dupTitle} active` });
      await setActive.waitFor({ timeout: 10000 });
      const box = await setActive.boundingBox();
      assert(box && box.height >= 44, `Set active is a 44px target (got ${box?.height})`);
      await setActive.click();
      const confirm = page.getByTestId("confirm-set-active");
      await confirm.waitFor({ timeout: 5000 });
      assert((await confirm.innerText()).includes(live.title) && /goes inactive/.test(await confirm.innerText()), "the confirm names the game that goes inactive");
      const stillLive = (await json(await request.get(BASE + "/api/wheels"), "list before confirm")).wheels?.find((w) => w.id === live.id);
      assert(stillLive?.isActive === true, "nothing changed before the confirm");
      await confirm.getByRole("button", { name: "Make it live" }).click();
      const undo = page.locator('[data-testid="toast"]').filter({ hasText: /now live/ });
      await undo.waitFor({ timeout: 8000 });
      await undo.getByRole("button", { name: /^Undo/ }).click();
      await page.waitForTimeout(1200);
      const restored = (await json(await request.get(BASE + "/api/wheels"), "list after undo")).wheels?.find((w) => w.id === live.id);
      assert(restored?.isActive === true, "Undo made the original game live again");
    } finally {
      await page.close().catch(() => {});
      if (dupId) await request.delete(BASE + `/api/wheels/${dupId}?hard=1`).catch(() => {});
      if (token) await request.post(BASE + "/api/fan-data/delete", { data: { token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 WG-12: reactivate and demote ask first in Admin", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/admin/account") posts.push(JSON.parse(r.postData() || "{}")); });
    try {
      await goto(page, "/dashboard?section=admin", 1500);
      const row = page.locator("li").filter({ hasText: "Suspended" }).filter({ has: page.getByRole("button", { name: "Reactivate" }) }).first();
      await row.waitFor({ timeout: 10000 });
      await row.getByRole("button", { name: "Reactivate" }).click();
      const confirm = row.getByRole("group", { name: /Confirm reactivating/ });
      await confirm.waitFor({ timeout: 5000 });
      assert(posts.length === 0, "nothing was sent before the confirm");
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await confirm.waitFor({ state: "detached", timeout: 5000 });
      assert(posts.length === 0, "Cancel sent nothing");

      const adminRow = page.locator("li").filter({ has: page.getByText("ADMIN", { exact: true }) }).first();
      await adminRow.getByRole("button", { name: /Show role and features/ }).click();
      await adminRow.getByRole("combobox").selectOption("creator");
      const demote = adminRow.getByRole("group", { name: /Confirm removing admin/ });
      await demote.waitFor({ timeout: 5000 });
      assert(posts.length === 0, "a role change asks before sending");
      await demote.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.close().catch(() => {});
    }
  });
}
