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
//  PA-03/PR-11 the Fans list is paged and searched on the server; sort and
//           "Needs a top-up" apply to the loaded rows; obligations are one read.
//  PR-04    a locked game type can be asked for; the admin bell lists it
//           until the feature is on.
//  PR-13    one link can be switched off (paused page) and on again without
//           blocking the fan.
//  PR-15    "Send test" delivers a marked sample to a webhook.
//  PR-07    fans, wins and daily numbers download as formula-safe CSV.
//  RD-19    a long conversation loads its earlier messages on demand.
//  PR-10    a delivery promise is saved and suggested as the expected-by day.
//  C16/WC-11 a save over a newer game version is a 409 with Reload; an
//           unfinished bingo saves as a draft with a checklist.
//  WC-09/26 leaving a just-created empty game offers its removal; a status
//           change shows it is being saved.
//  PR-13    a link can be given an expiry and made permanent again.
//  WG-18    Admin search, request ages and the build commit.
//  PA-01/12 + WC-18/19/23/30 too-dark brand colours are refused; skip link,
//           field errors, the handle hint and the discard list.
// Steps that answer API calls with errors run on their own page with no error
// sink: the failures are the point of the step. Every fixture is removed again.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, goto, NAV_ITEMS } from "./harness.mjs";
import { json } from "./focus.mjs";
import { gameFeatureSettings, setGameFeatures } from "./games.mjs";

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

  await step("b7 PA-03 + PR-11: /api/fans pages with a cursor and searches on the server; the list sorts and filters; obligations are one read", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const tag = `b7p${randomUUID().slice(0, 6)}`;
    const made = [];
    try {
      for (const [name, spins, amountDollars] of [[`${tag} alpha`, 0, 9], [`${tag} beta`, 5, 0], [`${tag} gamma`, 2, 3]]) {
        const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins, amountDollars } }), `create ${name}`);
        made.push(fan);
      }
      const first = await json(await request.get(BASE + `/api/fans?q=${tag}&limit=2`), "first page");
      assert(first.fans.length === 2 && typeof first.nextCursor === "string", "a page of 2 carries a cursor for the next page");
      const second = await json(await request.get(BASE + `/api/fans?q=${tag}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`), "second page");
      assert(second.fans.length === 1 && second.nextCursor === null && !second.fans.some((f) => first.fans.some((g) => g.fanId === f.fanId)), "the second page holds the remaining fan and ends");
      const whole = await json(await request.get(BASE + "/api/fans"), "default page");
      assert(typeof whole.total === "number" && whole.total >= 3 && whole.fans.length <= 50, "the default page is at most 50 fans with the creator's total");
      assert((await request.get(BASE + "/api/fans?limit=x")).status() === 400, "a bad limit is a 400");
      const owed = await json(await request.get(BASE + "/api/account/obligations"), "obligations");
      assert(typeof owed.prizes === "number" && typeof owed.paidSpins === "number" && owed.payingFans >= 1, "obligations come back as one summary");

      const searches = [];
      page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === "/api/fans" && u.searchParams.get("q")) searches.push(u.searchParams.get("q")); });
      await goto(page, "/dashboard?section=fans", 1200);
      const search = page.getByTestId("fans-search");
      await search.waitFor({ timeout: 10000 });
      await search.fill(`${tag} be`);
      await page.waitForFunction((t) => document.querySelectorAll("li[id^='fan-row-']").length === 1 && document.body.innerText.includes(`${t} beta`), tag, { timeout: 10000 });
      assert(searches.some((q) => q === `${tag} be`), "the search was answered by the server");
      await search.fill(tag);
      await page.waitForFunction(() => document.querySelectorAll("li[id^='fan-row-']").length === 3, null, { timeout: 10000 });
      const names = async () => page.locator("li[id^='fan-row-'] p.font-semibold").allInnerTexts();
      await page.getByTestId("fans-sort").selectOption("spent");
      assert((await names())[0] === `${tag} alpha`, "Most tips recorded puts the 900-cent fan first");
      await page.getByTestId("fans-sort").selectOption("spinsLeft");
      assert((await names())[0] === `${tag} beta`, "Most spins left puts the 5-spin fan first");
      await page.getByTestId("fans-show").selectOption("topup");
      await page.waitForFunction(() => document.querySelectorAll("li[id^='fan-row-']").length === 1, null, { timeout: 5000 });
      assert((await names())[0] === `${tag} alpha`, "Needs a top-up shows only the tipped fan with no spins");
      assert(/Showing 3 matches/.test(await page.getByTestId("fans-paging").innerText()), "the paging line counts the matches");
    } finally {
      await page.close().catch(() => {});
      for (const fan of made) await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 PR-04: a locked game type shows \"Ask to enable\"; the request reaches the admin bell until the feature is on", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await json(await request.post(BASE + "/api/admin/account", { data: { id: "acc-you", features: { scratch: false } } }), "lock scratch");
      await goto(page, "/dashboard?section=editor", 1200);
      await page.getByRole("button", { name: "New game", exact: true }).click();
      const locked = page.getByTestId("new-game-locked-scratch");
      await locked.waitFor({ timeout: 10000 });
      assert((await page.getByTestId("new-game-kind-scratch").count()) === 0, "a locked type is not a selectable radio");
      await locked.getByRole("button", { name: "Ask to enable" }).click();
      await page.getByTestId("toast").filter({ hasText: /Asked/ }).first().waitFor({ timeout: 10000 });
      await page.waitForFunction(() => /Asked — you'll see it here once it's on/.test(document.body.innerText), null, { timeout: 5000 });
      const feed = await json(await request.get(BASE + "/api/notifications"), "admin bell");
      const item = (feed.items ?? []).find((i) => i.kind === "game_unlock_request");
      assert(item && /scratch tickets/.test(item.title) && item.target?.section === "admin", "the admin bell lists the request, naming the game");
      const again = await json(await request.post(BASE + "/api/me/game-unlock", { data: { game: "scratch" } }), "ask again");
      assert(again.ok === true && again.already === true, "asking twice is answered as the earlier request");
      assert((await request.post(BASE + "/api/me/game-unlock", { data: { game: "poker" } })).status() === 400, "an unknown game is a 400");
      await json(await request.post(BASE + "/api/admin/account", { data: { id: "acc-you", features: { scratch: true } } }), "enable scratch");
      const after = await json(await request.get(BASE + "/api/notifications"), "admin bell after enabling");
      assert(!(after.items ?? []).some((i) => i.kind === "game_unlock_request" && /scratch/.test(i.title)), "once the feature is on the request leaves the bell");
      const enabled = await request.post(BASE + "/api/me/game-unlock", { data: { game: "scratch" } });
      assert(enabled.status() === 409 && (await enabled.json()).error === "already_enabled", "asking for a game that is on is refused as already_enabled");
    } finally {
      await page.close().catch(() => {});
      await request.post(BASE + "/api/admin/account", { data: { id: "acc-you", features: { scratch: true } } }).catch(() => {});
    }
  });

  await step("b7 PR-13: one link can be switched off (the fan sees the paused page) and on again; the fan is never blocked", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `b7 link ${randomUUID().slice(0, 6)}`;
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2 } }), "create fan");
    try {
      assert((await request.get(BASE + `/spin/${fan.token}`)).status() === 200, "the fresh link opens");
      const off = await json(await request.post(BASE + `/api/fans/${fan.fanId}/links`, { data: { token: fan.token, active: false } }), "switch off");
      assert(off.ok === true, "the switch answers ok");
      assert((await request.get(BASE + `/spin/${fan.token}`)).status() === 404, "a switched-off link no longer opens");
      const detail = await json(await request.get(BASE + `/api/fans/${fan.fanId}`), "fan detail");
      assert(detail.blocked === false && detail.passes?.[0]?.isActive === false, "the fan is not blocked; the pass reads as switched off");
      assert((await request.post(BASE + `/api/fans/${fan.fanId}/links`, { data: { token: "nope", active: true } })).status() === 404, "an unknown token is a 404");
      assert((await request.post(BASE + `/api/fans/${fan.fanId}/links`, { data: { token: fan.token, active: "yes" } })).status() === 400, "a non-boolean active is a 400");

      await goto(page, `/dashboard?section=fans&fan=${encodeURIComponent(fan.fanId)}`, 1200);
      const sw = page.getByTestId("link-switch").first();
      await sw.waitFor({ timeout: 10000 });
      assert((await sw.getAttribute("data-active")) === "false" && /Switched off/.test(await sw.innerText()), "the drawer shows the link as switched off");
      await sw.getByRole("button", { name: "Switch this link on" }).click();
      await page.getByTestId("toast").filter({ hasText: /Link switched on/ }).first().waitFor({ timeout: 10000 });
      await page.waitForFunction(() => document.querySelector("[data-testid='link-switch']")?.getAttribute("data-active") === "true", null, { timeout: 10000 });
      assert((await request.get(BASE + `/spin/${fan.token}`)).status() === 200, "the link opens again");
    } finally {
      await page.close().catch(() => {});
      await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 PR-15 + PR-07: a webhook gets a test delivery; fans, wins and daily numbers download as formula-safe CSV", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const hook = await json(await request.post(BASE + "/api/webhooks", { data: { url: "https://example.com/b7-hook", event: "all" } }), "add webhook");
    const evil = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "=HYPERLINK(\"http://evil\")", spins: 1 } }), "create formula-named fan");
    try {
      const fired = await json(await request.post(BASE + `/api/webhooks/${hook.webhook.id}/test`), "test delivery");
      assert(fired.ok === true && fired.event === "prize_pending" && typeof fired.status === "number", "the test delivery answers with the receiver's status");
      await goto(page, "/dashboard?section=boosts", 1200);
      const btn = page.getByTestId("webhook-test").first();
      await btn.waitFor({ timeout: 10000 });
      await btn.click();
      await page.getByTestId("toast").filter({ hasText: /Delivered|answered|No answer/ }).first().waitFor({ timeout: 10000 });

      const fans = await request.get(BASE + "/api/fans/export");
      const csv = await fans.text();
      assert(fans.status() === 200 && /text\/csv/.test(fans.headers()["content-type"] ?? "") && /attachment/.test(fans.headers()["content-disposition"] ?? ""), "the fans export is a CSV attachment");
      assert(csv.includes("\"'=HYPERLINK(\"\"http://evil\"\")\"") && !/\r\n"=HYPERLINK/.test(csv), "a formula-looking name is neutralised in the file");
      const wins = await request.get(BASE + "/api/redemptions/export?status=pending");
      assert(wins.status() === 200 && (await wins.text()).startsWith('\uFEFF"Fan","Prize"'), "the queue export starts with its header");
      assert((await request.get(BASE + "/api/redemptions/export?status=bogus")).status() === 400, "an unknown status is refused");
      const dailyRes = await request.get(BASE + "/api/metrics/export?days=14");
      const daily = (await dailyRes.text()).trim().split("\r\n");
      assert(dailyRes.status() === 200 && daily.length === 15, "the daily export has 14 rows and a header");
      await goto(page, "/dashboard?section=fans", 1200);
      assert((await page.getByTestId("fans-export").getAttribute("href")) === "/api/fans/export", "the Fans tab offers the export");
    } finally {
      await page.close().catch(() => {});
      await request.delete(BASE + `/api/webhooks/${hook.webhook.id}`).catch(() => {});
      await request.post(BASE + "/api/fan-data/delete", { data: { token: evil.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 RD-19 + PR-10: a long thread loads its earlier messages on demand; a delivery promise suggests an expected-by day in the queue", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `b7 thread ${randomUUID().slice(0, 6)}`;
    const before = await json(await request.get(BASE + "/api/public-profile"), "read profile");
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 1 } }), "create fan");
    try {
      await json(await acknowledgeFixtureFan(request, fan.token), "ack fan");
      for (const body of ["b7 one", "b7 two", "b7 three", "b7 four", "b7 five"]) {
        await json(await request.post(BASE + "/api/messages/creator", { data: { fanId: fan.fanId, body } }), "send " + body);
      }
      const first = await json(await request.get(BASE + `/api/messages/thread/${fan.fanId}?limit=2`), "first page");
      assert(first.more === true && first.messages.map((m) => m.body).join() === "b7 four,b7 five", "the first page is the newest two");
      const older = await json(await request.get(BASE + `/api/messages/thread/${fan.fanId}?limit=2&before=${encodeURIComponent(first.messages[0].at)}`), "older page");
      assert(older.messages.map((m) => m.body).join() === "b7 two,b7 three" && older.more === true, "before= continues with the older two");
      assert((await request.get(BASE + `/api/messages/thread/${fan.fanId}?before=nope`)).status() === 400, "a before that is no date is a 400");

      // The panel asks for whole pages; shrink them so five messages span three.
      await page.route((url) => url.pathname === `/api/messages/thread/${fan.fanId}`, (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET" || url.searchParams.has("limit")) return route.continue();
        url.searchParams.set("limit", "2");
        return route.continue({ url: url.toString() });
      });
      await goto(page, "/dashboard?section=inbox", 1200);
      await page.getByRole("list", { name: "Conversations" }).getByRole("button").filter({ hasText: name }).first().click();
      const more = page.getByTestId("thread-load-earlier");
      await more.waitFor({ timeout: 10000 });
      assert(await page.getByText("b7 five", { exact: true }).count() === 1 && await page.getByText("b7 two", { exact: true }).count() === 0, "only the newest page is shown at first");
      await more.click();
      await page.getByText("b7 two", { exact: true }).waitFor({ timeout: 10000 });
      await more.click();
      await page.getByText("b7 one", { exact: true }).waitFor({ timeout: 10000 });
      assert(await page.getByText("b7 four", { exact: true }).count() === 1, "loading earlier pages never duplicates a message");

      // PR-10: the promise is saved from Settings and suggested in the queue.
      assert((await request.put(BASE + "/api/public-profile", { data: { deliveryDays: 99 } })).status() === 400, "a 99-day promise is refused");
      await goto(page, "/dashboard?section=settings", 1200);
      const days = page.getByTestId("delivery-days");
      await days.waitFor({ timeout: 10000 });
      await days.fill("4");
      await page.locator('section[aria-labelledby="settings-public"]').getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTestId("toast").filter({ hasText: /Link-in-bio saved/ }).first().waitFor({ timeout: 10000 });
      assert((await json(await request.get(BASE + "/api/public-profile"), "re-read")).deliveryDays === 4, "the promise was saved");
      await goto(page, "/dashboard?section=prizes", 1200);
      const hint = page.getByTestId("expected-by").first();
      if (await hint.count()) {
        assert(/4-day promise/.test(await hint.innerText()), "a win without a due date shows the expected-by day");
      }
    } finally {
      await page.close().catch(() => {});
      await request.put(BASE + "/api/public-profile", { data: { deliveryDays: before.deliveryDays ?? null } }).catch(() => {});
      await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 C16 + WC-11: a save over a newer game version is refused and offers Reload; an unfinished bingo saves as a draft with a checklist", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const tag = randomUUID().slice(0, 6);
    let dupId = null;
    let bingoId = null;
    const features = await gameFeatureSettings(request);
    const read = async (id) => (await json(await request.get(BASE + `/api/wheels/${id}`), "read game")).wheel;
    const editable = (wheel) => {
      const { gameKindLocked: _l, gameReady: _r, updatedAt: _u, ...rest } = wheel;
      return rest;
    };
    try {
      const list = (await json(await request.get(BASE + "/api/wheels"), "list games")).wheels;
      const live = list.find((w) => w.isActive) ?? list[0];
      dupId = (await json(await request.post(BASE + `/api/wheels/${live.id}/duplicate`), "duplicate the live game")).wheel.id;
      const v1 = await read(dupId);
      assert(typeof v1.updatedAt === "string" && Number.isFinite(Date.parse(v1.updatedAt)), "a loaded game carries its version");
      await page.waitForTimeout(20);
      const saved = await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable(v1), title: `b7 cas ${tag}` }, expectedUpdatedAt: v1.updatedAt } }), "save with the loaded version");
      assert(saved.wheel.updatedAt && saved.wheel.updatedAt !== v1.updatedAt, "a settings save moves the version on");
      const stale = await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable(v1), title: `b7 lost ${tag}` }, expectedUpdatedAt: v1.updatedAt } });
      assert(stale.status() === 409 && (await stale.json()).error === "game_changed", "a save from the older version is a 409 game_changed");
      assert((await read(dupId)).title === `b7 cas ${tag}`, "the refused save changed nothing");
      assert((await request.put(BASE + "/api/wheel", { data: { wheel: editable(v1), expectedUpdatedAt: "yesterday" } })).status() === 400, "a version that is no date is a 400");
      assert((await request.put(BASE + "/api/wheel", { data: { wheel: editable(v1), draft: "yes" } })).status() === 400, "a non-boolean draft is a 400");

      // The editor: load the game, let "another tab" save it, then save here.
      await goto(page, "/dashboard?section=editor", 1500);
      const switcher = page.locator("section[aria-label='Game switcher']");
      await switcher.getByRole("button", { name: new RegExp(`^b7 cas ${tag}`) }).click();
      const title = page.getByLabel("Title", { exact: true });
      await page.waitForFunction((want) => document.querySelector("input[value]") && [...document.querySelectorAll("input")].some((i) => i.value === want), `b7 cas ${tag}`, { timeout: 10000 });
      const current = await read(dupId);
      await page.waitForTimeout(20);
      await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable(current), title: `b7 other tab ${tag}` }, expectedUpdatedAt: current.updatedAt } }), "another tab saves");
      await title.fill(`b7 mine ${tag}`);
      await page.getByRole("button", { name: "Save game", exact: true }).click();
      const error = page.getByTestId("game-save-error");
      await error.waitFor({ timeout: 10000 });
      assert(/changed in another tab or by a team member/.test(await error.innerText()), "the editor says the game changed elsewhere");
      assert((await read(dupId)).title === `b7 other tab ${tag}`, "the other tab's save was not overwritten");
      await page.getByTestId("game-reload-latest").click();
      await page.waitForFunction((want) => [...document.querySelectorAll("input")].some((i) => i.value === want), `b7 other tab ${tag}`, { timeout: 10000 });
      assert((await error.count()) === 0, "Reload clears the refusal");

      // WC-11: a never-published bingo game may be stored unfinished.
      await setGameFeatures(request, { ...features, bingo: true });
      const bingo = (await json(await request.post(BASE + "/api/wheels", { data: { name: `b7 bingo ${tag}`, gameKind: "bingo", gameConfig: { size: 3, linePrizeId: null } } }), "create a bingo draft")).wheel;
      bingoId = bingo.id;
      const prizes = [1, 2].map((n) => ({ id: randomUUID(), label: `b7 square ${n}`, rarity: "common", weight: 1, emoji: "⭐", stock: null, cost: 0 }));
      const strict = await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable(bingo), prizes } } });
      assert(strict.status() === 400, `an unfinished bingo is still refused as a finished save (${strict.status()})`);
      const draft = await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable(bingo), prizes }, draft: true } }), "save the bingo draft");
      assert(draft.wheel.gameReady === false && draft.wheel.prizes.length === 2, "the draft keeps its prizes and stays not ready");
      const listed = (await json(await request.get(BASE + "/api/wheels"), "list with the draft")).wheels.find((w) => w.id === bingoId);
      assert(listed && listed.isActive === false, "a draft is never the live game");
      const ready = await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable(await read(dupId)), prizes: [] }, draft: true } });
      assert(ready.status() === 400, "draft: true does not loosen the rules for a published game");

      await goto(page, "/dashboard?section=editor", 1500);
      await switcher.getByRole("button", { name: new RegExp(`^b7 bingo ${tag}`) }).click();
      const checklist = page.getByTestId("bingo-checklist");
      await checklist.waitFor({ timeout: 10000 });
      assert((await checklist.locator("li[data-done='false']").count()) >= 1, "the checklist shows what is still to do");
      assert(/save it as a draft/.test(await page.getByTestId("bingo-missing").innerText()), "the editor says a draft can be saved");
      await page.getByLabel("Title", { exact: true }).fill(`b7 bingo ${tag} v2`);
      const saveDraft = page.getByRole("button", { name: "Save draft", exact: true });
      await saveDraft.waitFor({ timeout: 10000 });
      await saveDraft.click();
      await page.getByTestId("toast").filter({ hasText: /Draft saved/ }).first().waitFor({ timeout: 10000 });
      const after = await read(bingoId);
      assert(after.title === `b7 bingo ${tag} v2` && after.gameReady === false, "the draft was stored and is still a draft");
    } finally {
      await page.close().catch(() => {});
      for (const id of [dupId, bingoId]) if (id) await request.delete(BASE + `/api/wheels/${id}?hard=1`).catch(() => {});
      await setGameFeatures(request, features).catch(() => {});
    }
  });

  await step("b7 WC-09 + WC-26: leaving a just-created empty game offers to remove it; a status change shows it is being saved", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const gameName = `b7 empty ${randomUUID().slice(0, 6)}`;
    const name = `@b7busy${Date.now().toString(36)}`;
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2 } }), "create fan");
    let createdId = null;
    try {
      const before = (await json(await request.get(BASE + "/api/wheels"), "list games")).wheels;
      const live = before.find((w) => w.isActive) ?? before[0];
      await goto(page, "/dashboard?section=editor", 1500);
      await page.getByRole("button", { name: "New game", exact: true }).click();
      await page.getByPlaceholder("Give this game a name").fill(gameName);
      await page.getByRole("button", { name: "Create game", exact: true }).click();
      await page.getByTestId("toast").filter({ hasText: /Game created/ }).first().waitFor({ timeout: 10000 });
      createdId = (await json(await request.get(BASE + "/api/wheels"), "list after create")).wheels.find((w) => w.title === gameName)?.id ?? null;
      assert(createdId, "the game was stored on create");
      await page.waitForTimeout(600);
      assert((await page.getByTestId("toast").filter({ hasText: /has no prizes yet/ }).count()) === 0, "nothing is offered while the new game is still open");
      const switcher = page.locator("section[aria-label='Game switcher']");
      await switcher.getByRole("button", { name: new RegExp(`^${live.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
      const offer = page.getByTestId("toast").filter({ hasText: /has no prizes yet/ });
      await offer.waitFor({ timeout: 10000 });
      assert((await offer.innerText()).includes(gameName), "the notice names the empty game");
      assert((await json(await request.get(BASE + "/api/wheels"), "list before removal")).wheels.some((w) => w.id === createdId), "nothing is removed without the tap");
      await offer.getByRole("button", { name: "Remove it" }).click();
      await page.getByTestId("toast").filter({ hasText: `Removed "${gameName}"` }).first().waitFor({ timeout: 10000 });
      assert(!(await json(await request.get(BASE + "/api/wheels?archived=1"), "list after removal")).wheels.some((w) => w.id === createdId), "the empty game is gone");
      createdId = null;

      // WC-26: the queue button is disabled and says so while the change is on its way.
      await json(await acknowledgeFixtureFan(request, fan.token), "ack fan");
      await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "b7-busy" } }), "fan plays");
      await page.route((url) => url.pathname.startsWith("/api/redemptions/"), async (route) => {
        if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 900));
        await route.continue();
      });
      await goto(page, "/dashboard?section=prizes", 1200);
      const row = page.locator("li").filter({ hasText: name }).first();
      await row.waitFor({ timeout: 10000 });
      await row.getByRole("button", { name: /^Start:/ }).click();
      const busy = row.locator("button[aria-busy='true']");
      await busy.waitFor({ timeout: 3000 });
      assert(await busy.isDisabled() && /Saving…/.test(await busy.innerText()), "the button is disabled and reads Saving… while the change is sent");
      await row.getByRole("button", { name: /^Mark fulfilled:/ }).waitFor({ timeout: 10000 });
      await page.waitForFunction((n) => ![...document.querySelectorAll("li")].some((li) => li.textContent?.includes(n) && li.querySelector("button[aria-busy='true']")), name, { timeout: 10000 });
    } finally {
      await page.close().catch(() => {});
      if (createdId) await request.delete(BASE + `/api/wheels/${createdId}?hard=1`).catch(() => {});
      await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 PR-13: a link can be given an expiry and made permanent again from the fan sheet", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `b7 expiry ${randomUUID().slice(0, 6)}`;
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2 } }), "create fan");
    const links = (data) => request.post(BASE + `/api/fans/${fan.fanId}/links`, { data: { token: fan.token, ...data } });
    const pass = async () => (await json(await request.get(BASE + `/api/fans/${fan.fanId}`), "fan detail")).passes?.[0];
    try {
      assert((await pass()).expiresAt === null, "a fresh link never expires");
      assert((await links({ expiresAt: new Date(Date.now() - 60_000).toISOString() })).status() === 400, "an expiry in the past is refused");
      assert((await links({ expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status() === 400, "an expiry over a year out is refused");
      assert((await links({ expiresAt: "soon" })).status() === 400, "an expiry that is no date is refused");
      assert((await links({})).status() === 400, "a body with neither field is refused");

      await goto(page, `/dashboard?section=fans&fan=${encodeURIComponent(fan.fanId)}`, 1200);
      const expiry = page.getByTestId("link-expiry").first();
      await expiry.waitFor({ timeout: 10000 });
      assert(/Never expires/.test(await expiry.innerText()), "the sheet says the link never expires");
      await expiry.getByRole("combobox").selectOption("7");
      await page.getByTestId("toast").filter({ hasText: /stops working in 7 days/ }).first().waitFor({ timeout: 10000 });
      const set = (await pass()).expiresAt;
      const days = (Date.parse(set) - Date.now()) / 86_400_000;
      assert(days > 6.9 && days < 7.1, `the link expires in seven days (${days.toFixed(2)})`);
      await page.waitForFunction(() => /Expires/.test(document.querySelector("[data-testid='link-expiry']")?.textContent ?? ""), null, { timeout: 10000 });
      assert((await request.get(BASE + `/spin/${fan.token}`)).status() === 200, "a link with a future expiry still opens");
      await expiry.getByRole("combobox").selectOption("never");
      await page.getByTestId("toast").filter({ hasText: /no longer expires/ }).first().waitFor({ timeout: 10000 });
      assert((await pass()).expiresAt === null, "Never clears the expiry");
    } finally {
      await page.close().catch(() => {});
      await request.post(BASE + "/api/fan-data/delete", { data: { token: fan.token, confirm: "DELETE" } }).catch(() => {});
    }
  });

  await step("b7 WG-18: Admin searches its accounts, shows how long a request has waited and names the build", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await goto(page, "/dashboard?section=admin", 1500);
      const count = page.getByTestId("admin-accounts-count");
      await count.waitFor({ timeout: 10000 });
      const total = Number((await count.innerText()).match(/(\d+) total/)?.[1]);
      assert(total > 0, "the accounts header counts every account");
      const search = page.getByTestId("admin-accounts-search");
      await search.fill("zz-no-such-account");
      await page.getByTestId("admin-accounts-none").waitFor({ timeout: 5000 });
      assert(new RegExp(`^0 of ${total}$`).test((await count.innerText()).trim()), "the count reads 0 of the total");
      await search.fill("");
      await page.getByTestId("admin-accounts-none").waitFor({ state: "detached", timeout: 5000 });
      const ages = page.getByTestId("request-age");
      if (await ages.count()) {
        const text = await ages.first().innerText();
        assert(/^Asked /.test(text), `a request says when it was asked (${text})`);
        assert(["true", "false"].includes(await ages.first().getAttribute("data-overdue")), "each request is marked overdue or not");
      }
      const build = page.getByTestId("build-commit");
      await build.waitFor({ timeout: 10000 });
      assert(/^Build: \S+/.test((await build.innerText()).trim()), "System health names the deployed build");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b7 PA-01 + PA-12 + WC-18/19/23/30: a too-dark brand colour is refused; skip link, field errors, slug hint and the discard list", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const profile = await json(await request.get(BASE + "/api/public-profile"), "read profile");
    try {
      const dark = await request.put(BASE + "/api/account/brand-color", { data: { color: "#050505" } });
      assert(dark.status() === 400 && (await dark.json()).error === "brand_too_dark", "the route refuses a colour that cannot be read on the dark dashboard");

      await goto(page, "/dashboard?section=settings", 1500);
      // PA-12: the first Tab stop is the skip link, and it lands on the content.
      await page.keyboard.press("Tab");
      const skip = page.getByTestId("skip-to-content");
      assert(await skip.evaluate((el) => el === document.activeElement), "the skip link is the first Tab stop");
      await page.keyboard.press("Enter");
      assert(await page.evaluate(() => location.hash === "#dash-content" && !!document.getElementById("dash-content")), "it jumps to the content");

      // WC-18: a password problem is said under its field, as an alert, with no error toast.
      const security = page.locator("div").filter({ has: page.getByRole("button", { name: "Update password" }) }).last();
      await security.getByLabel("Current password").fill("whatever-1");
      await security.getByLabel("New password").fill("longenough-1");
      await security.getByLabel("Confirm new").fill("different-1");
      await security.getByRole("button", { name: "Update password" }).click();
      const fieldError = security.getByTestId("field-error");
      await fieldError.waitFor({ timeout: 5000 });
      assert(/don.t match/.test(await fieldError.innerText()) && (await fieldError.getAttribute("role")) === "alert", "the mismatch is an alert under the field");
      assert((await page.locator('[data-testid="toast"][data-tone="error"]').count()) === 0, "no error toast for a field problem");
      await security.getByLabel(/^Confirm new/).fill("longenough-1x");
      await fieldError.waitFor({ state: "detached", timeout: 5000 });

      // WC-30: the handle field says what a save stores and what it breaks.
      const pub = page.locator('section[aria-labelledby="settings-public"]');
      const handle = pub.getByPlaceholder("your-name");
      const hint = page.getByTestId("public-slug-hint");
      await handle.fill("B7 New Name");
      await page.waitForFunction(() => /Will be saved as/.test(document.querySelector("[data-testid='public-slug-hint']")?.textContent ?? ""), null, { timeout: 5000 });
      assert((await hint.innerText()).includes("/c/b7-new-name"), "the stored form is previewed");
      if (profile.slug) assert((await page.getByTestId("public-slug-retires").innerText()).includes(`/c/${profile.slug}`), "the link that would stop working is named");
      await handle.fill("Walk Creator!!");
      await page.waitForFunction(() => /letters, numbers/.test(document.querySelector("[data-testid='public-slug-hint']")?.textContent ?? ""), null, { timeout: 5000 });
      assert((await handle.getAttribute("aria-invalid")) === "true", "a handle the save would refuse is marked invalid while typing");

      // WC-19: with three unsaved forms the leave dialog lists them.
      await page.getByLabel("Display name").fill(`b7 name ${Date.now().toString(36)}`);
      await page.getByLabel("New email").fill("b7-nobody@example.com");
      await page.locator(NAV_ITEMS).filter({ hasText: /^Today/ }).first().click();
      const list = page.getByTestId("discard-list");
      await list.waitFor({ timeout: 5000 });
      assert((await list.locator("li").count()) >= 3, "the unsaved forms are listed one per line");
      await page.getByRole("dialog").getByRole("button", { name: /Discard/ }).first().click();
      await list.waitFor({ state: "detached", timeout: 5000 });
      assert((await json(await request.get(BASE + "/api/public-profile"), "re-read profile")).slug === profile.slug, "nothing was saved");
    } finally {
      await page.close().catch(() => {});
    }
  });
}
