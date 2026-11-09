// b6 dashboard gaps in the browser (demo mode):
//  C2  a failed load is an error with Retry in every list and tile, never an
//      empty state or a reset checklist; 429 says "Too many requests"; 401
//      sends the creator to /login?next= once, never in a loop.
//  C14 unsaved text: Public page text and an inbox reply survive a section
//      switch; other forms ask before a switch; a reload asks first.
//  C12 minting shows a link card (Copy / Share / QR) and the new row.
//  C18 a fulfilment row links to the fan's drawer and their Inbox thread.
//  C4  Settings › Clear all data says what fans are still owed (never run).
//  C16 two tabs: a save that would overwrite the other tab's change is refused
//      with Reload.
// Steps that answer API calls with errors run on their own page with no error
// sink: the failures are the point of the step. Every fixture is removed again.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, clickTab, goto } from "./harness.mjs";
import { json } from "./focus.mjs";

const path = (p) => (url) => url.pathname === p;
const answer = (status) => (route) => route.fulfill({ status, json: { error: status === 429 ? "rate_limited" : "boom" } });
const STALE = "This game was changed in another tab or by a team member. Reload to see the latest.";

async function noText(page, text) {
  return (await page.getByText(text, { exact: false }).count()) === 0;
}

export async function dashB6Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;

  await step("b6 C2: a failed load (500) is 'Couldn't load' with Retry in every section, never an empty state", async () => {
    const page = await ctx.newPage();
    try {
      for (const p of ["/api/fans", "/api/messages/inbox", "/api/campaigns/stats", "/api/autopilot", "/api/overview", "/api/metrics", "/api/referrals/stats"]) {
        await page.route(path(p), answer(500));
      }
      await goto(page, "/dashboard?section=fans", 600);
      const fans = page.getByTestId("fans-load-failed");
      await fans.waitFor({ timeout: 10000 });
      assert(/Couldn.t load your fans\./.test(await fans.innerText()), "Fans says it couldn't load");
      assert(await fans.getByRole("button", { name: "Retry" }).count() === 1, "Fans offers Retry");
      assert(await noText(page, "No fans yet"), "Fans never claims there are no fans");

      await goto(page, "/dashboard?section=prizes", 600);
      await page.getByTestId("prizes-load-failed").waitFor({ timeout: 10000 });
      assert(await noText(page, "All clear here"), "Fulfilment never says all clear");

      await goto(page, "/dashboard?section=inbox", 600);
      await page.getByTestId("inbox-load-failed").waitFor({ timeout: 10000 });
      assert(await noText(page, "No conversations yet"), "Inbox never says no conversations");

      await goto(page, "/dashboard?section=campaigns", 600);
      await page.getByTestId("campaigns-load-failed").waitFor({ timeout: 10000 });
      assert(await noText(page, "No campaigns yet"), "Campaigns never says no campaigns");

      await goto(page, "/dashboard?section=today", 600);
      await page.getByTestId("today-load-failed").waitFor({ timeout: 10000 });
      await page.getByTestId("today-cards-load-failed").waitFor({ timeout: 10000 });
      assert(await noText(page, "all clear"), "the To fulfil tile never says all clear");
      assert(await noText(page, "no spins yet"), "no first-run 'no spins yet' after a failed load");
      assert(await noText(page, "Your first steps"), "the checklist is not reset to step 1");

      await goto(page, "/dashboard?section=analytics", 600);
      await page.getByTestId("analytics-load-failed").waitFor({ timeout: 10000 });
      assert(await noText(page, "No activity yet"), "Analytics never says no activity");

      await goto(page, "/dashboard?section=boosts", 600);
      await page.getByText("Couldn’t load referral numbers right now.").or(page.getByText("Couldn't load referral numbers right now.")).waitFor({ timeout: 10000 });

      // Retry recovers once the server answers again (unroute needs the same matcher).
      await page.unrouteAll();
      const fansOnly = path("/api/fans");
      await page.route(fansOnly, answer(500));
      await goto(page, "/dashboard?section=fans", 600);
      await page.getByTestId("fans-load-failed").waitFor({ timeout: 10000 });
      await page.unroute(fansOnly);
      await page.getByTestId("fans-load-failed").getByRole("button", { name: "Retry" }).click();
      await page.getByTestId("fans-load-failed").waitFor({ state: "detached", timeout: 10000 });
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b6 C2: a 429 says 'Too many requests, try again in a moment'", async () => {
    const page = await ctx.newPage();
    try {
      await page.route(path("/api/fans"), answer(429));
      await page.route(path("/api/messages/inbox"), answer(429));
      await goto(page, "/dashboard?section=fans", 600);
      const fans = page.getByTestId("fans-load-failed");
      await fans.waitFor({ timeout: 10000 });
      assert((await fans.innerText()).includes("Too many requests, try again in a moment."), "Fans says too many requests");
      assert(await fans.getAttribute("data-load-kind") === "rate", "kind is rate");
      await goto(page, "/dashboard?section=inbox", 600);
      assert((await page.getByTestId("inbox-load-failed").innerText()).includes("Too many requests"), "Inbox says too many requests");
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b6 C2: a 401 sends the creator to /login?next=<here> once, and never loops", async () => {
    const page = await ctx.newPage();
    const logins = [];
    page.on("request", (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).pathname === "/login") logins.push(r.url()); });
    try {
      await page.route(path("/api/fans"), answer(401));
      await page.goto(BASE + "/dashboard?section=fans", { waitUntil: "domcontentloaded" });
      await page.waitForURL((u) => u.pathname === "/login", { timeout: 15000 });
      const next = new URL(page.url()).searchParams.get("next");
      assert(next === "/dashboard?section=fans", `next is the section the creator was on (got ${next})`);
      // Back on the dashboard straight away (as after signing in) and still 401:
      // the page stays and says so instead of bouncing to /login again.
      await goto(page, "/dashboard?section=fans", 2500);
      assert(new URL(page.url()).pathname === "/dashboard", "no second redirect");
      const failed = page.getByTestId("fans-load-failed");
      await failed.waitFor({ timeout: 8000 });
      assert(/signed out/i.test(await failed.innerText()), "it says the creator is signed out");
      const link = failed.getByRole("link", { name: "Sign in" });
      assert(/\/login\?next=%2Fdashboard%3Fsection%3Dfans/.test(await link.getAttribute("href")), "Sign in returns here");
      assert(logins.length === 1, `exactly one trip to /login (got ${logins.length}: ${logins.join(" ")})`);
    } finally {
      await page.close().catch(() => {});
    }
  });

  await step("b6 C14: Public page text and an inbox reply survive a section switch; a reload asks first", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.type()); void d.accept(); });
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "@b6 drafts", spins: 2 } }), "create drafts fan");
    try {
      await json(await acknowledgeFixtureFan(request, fan.token), "ack drafts fan");
      await json(await request.post(BASE + "/api/messages/creator", { data: { fanId: fan.fanId, body: "hi from b6" } }), "start a thread");
      await goto(page, "/dashboard?section=settings", 1200);
      const tagline = page.getByLabel("Tagline");
      const note = page.getByLabel(/Personal note to fans/);
      await tagline.fill("b6 tagline draft");
      await note.fill("b6 note draft, carefully written");
      await clickTab(page, "Today");
      await page.waitForTimeout(400);
      assert(await page.getByRole("dialog", { name: "Discard unsaved changes?" }).count() === 0, "no prompt: the text is kept");
      await clickTab(page, "Settings");
      await page.getByLabel("Tagline").waitFor({ timeout: 8000 });
      await page.waitForTimeout(600);
      assert(await page.getByLabel("Tagline").inputValue() === "b6 tagline draft", "tagline still there after coming back");
      assert(await page.getByLabel(/Personal note to fans/).inputValue() === "b6 note draft, carefully written", "note still there");

      // A guarded form asks before a switch; Keep editing keeps the text.
      await page.getByLabel("New password").fill("half-typed-pass");
      await clickTab(page, "Today");
      const ask = page.getByRole("dialog", { name: "Discard unsaved changes?" });
      await ask.waitFor({ timeout: 4000 });
      assert(/password change/.test(await ask.innerText()), "the prompt names the password change");
      await ask.getByRole("button", { name: "Keep editing" }).click();
      assert(await page.getByLabel("New password").inputValue() === "half-typed-pass", "Keep editing keeps it");
      await page.getByLabel("New password").fill("");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      assert(dialogs.includes("beforeunload"), `a reload asks first (dialogs: ${dialogs.join(",")})`);

      // Inbox reply draft, per thread.
      dialogs.length = 0;
      await goto(page, "/dashboard?section=inbox", 1200);
      const thread = page.getByRole("list", { name: "Conversations" }).getByRole("button").filter({ hasText: "@b6 drafts" }).first();
      await thread.waitFor({ timeout: 10000 });
      await thread.click();
      const reply = page.getByLabel("Reply to this fan");
      await reply.fill("Half-typed reply to my fan");
      await clickTab(page, "Fans");
      await page.waitForTimeout(400);
      assert(await page.getByRole("dialog", { name: "Discard unsaved changes?" }).count() === 0, "no prompt: the reply is kept");
      await clickTab(page, "Inbox");
      await page.getByRole("list", { name: "Conversations" }).getByRole("button").filter({ hasText: "@b6 drafts" }).first().click();
      assert(await page.getByLabel("Reply to this fan").inputValue() === "Half-typed reply to my fan", "the reply is still there");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      assert(dialogs.includes("beforeunload"), "a reload with an unsent reply asks first");
    } finally {
      await page.close().catch(() => {});
      await request.delete(`${BASE}/api/fans/${fan.fanId}`).catch(() => {});
    }
  });

  await step("b6 C12: minting shows the link card (personal link, Copy, Share, QR) and the new row", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `@b6mint${Date.now().toString(36)}`;
    let fanId = null;
    try {
      await goto(page, "/dashboard?section=fans", 1200);
      await page.getByLabel("Fan handle").fill(name);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const card = page.getByTestId("minted-link");
      await card.waitFor({ timeout: 10000 });
      const text = await card.innerText();
      assert(text.includes(`Link ready for ${name}`), "the card names the fan");
      assert(/personal link for this fan only/i.test(text), "it says the link is for this fan only");
      assert(!/\bbio\b/i.test(text), "it never suggests a bio");
      const url = await card.getByRole("textbox").inputValue();
      assert(new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/spin/[A-Za-z0-9_-]+$`).test(url), `the card holds the spin link (${url})`);
      for (const label of ["Copy", "Share"]) assert(await card.getByRole("button", { name: label, exact: true }).count() === 1, `${label} is offered`);
      await card.getByRole("button", { name: /QR/ }).first().waitFor({ timeout: 8000 }); // QR: code-split, appears once loaded
      await card.getByRole("button", { name: "Copy", exact: true }).click();
      await page.getByText(/Link copied|Couldn.t copy the link/).first().waitFor({ timeout: 4000 });
      const row = page.locator("li[data-fresh='true']");
      await row.waitFor({ timeout: 8000 });
      assert((await row.innerText()).includes(name), "the new row is marked");
      fanId = (await row.getAttribute("id"))?.replace("fan-row-", "") ?? null;
      // The row scrolls itself into view with a smooth scroll (reduced motion: instant); wait for it to arrive.
      await page.waitForFunction((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }, await row.elementHandle(), { timeout: 5000 });
      assert(await row.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }), "the new row is in view");
    } finally {
      await page.close().catch(() => {});
      if (fanId) await request.delete(`${BASE}/api/fans/${fanId}`).catch(() => {});
    }
  });

  await step("b6 C18 + C4: a fulfilment row opens the fan and their thread; Clear all data says what is owed", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    const name = `@b6owed${Date.now().toString(36)}`;
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 3, amountDollars: 3 } }), "create owed fan");
    try {
      await json(await acknowledgeFixtureFan(request, fan.token), "ack owed fan");
      await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "b6-owed" } }), "fan plays");
      await goto(page, "/dashboard?section=prizes", 1200);
      await page.getByRole("button", { name: /^All/ }).first().click().catch(() => {});
      const fanLink = page.getByRole("button", { name: `Open ${name}'s fan details` }).first();
      await fanLink.waitFor({ timeout: 10000 });
      await fanLink.click();
      await page.waitForURL((u) => u.searchParams.get("section") === "fans" && u.searchParams.get("fan") === fan.fanId, { timeout: 8000 });
      const drawer = page.getByRole("dialog", { name: "Fan details" });
      await drawer.waitFor({ timeout: 8000 });
      await drawer.getByText(name).first().waitFor({ timeout: 8000 });

      await goto(page, "/dashboard?section=prizes", 1200);
      await page.getByRole("button", { name: `Message ${name}` }).first().click();
      await page.waitForURL((u) => u.searchParams.get("section") === "inbox", { timeout: 8000 });

      await goto(page, "/dashboard?section=boosts", 1000);
      assert(await page.getByRole("button", { name: /Clear all data/ }).count() === 0, "Clear all data is no longer in Boosts");
      await goto(page, "/dashboard?section=settings", 1200);
      const clear = page.getByTestId("clear-data");
      await clear.getByRole("button", { name: "Clear all data…" }).click();
      const owed = clear.getByTestId("clear-data-owed");
      await owed.waitFor({ timeout: 10000 });
      const text = await owed.innerText();
      assert(/fans? (is|are) owed \d+ prizes?/.test(text), `it says what fans are owed (${text})`);
      assert(/who paid hold/.test(text) || /who paid holds/.test(text), "and the paid spins still held");
      assert(await clear.getByRole("button", { name: "Permanently clear everything" }).isDisabled(), "RESET is still required");
      await clear.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.close().catch(() => {});
      await request.delete(`${BASE}/api/fans/${fan.fanId}`).catch(() => {});
    }
  });

  await step("b6 C16: a stale second tab can't overwrite the game; Reload shows the latest", async () => {
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const title = `B6 stale ${suffix}`;
    const created = (await json(await request.post(BASE + "/api/wheels", { data: { name: title, gameKind: "wheel" } }), "create stale fixture")).wheel;
    const { gameKindLocked: _l, gameReady: _r, ...editable } = created;
    await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable, prizes: [
      { id: randomUUID(), label: "Stale A", rarity: "common", weight: 10, stock: null },
      { id: randomUUID(), label: "Stale B", rarity: "rare", weight: 2, stock: null },
    ] } } }), "save stale fixture");
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    attachSink(a, sink);
    attachSink(b, sink);
    const open = async (page) => {
      await goto(page, "/dashboard?section=editor", 1000);
      const chip = page.getByRole("region", { name: "Game switcher" }).getByRole("button").filter({ has: page.getByText(title, { exact: true }) });
      await chip.waitFor({ timeout: 10000 });
      await chip.click();
      await page.waitForFunction((t) => (document.querySelector("[data-testid='wheel-title-input']"))?.value === t, title, { timeout: 8000 });
    };
    try {
      await open(a);
      await open(b);
      await b.getByTestId("wheel-title-input").fill(`${title} (tab B)`);
      await b.getByRole("button", { name: "Save game" }).click();
      await b.getByText("Saved", { exact: true }).waitFor({ timeout: 8000 });

      await a.getByTestId("wheel-title-input").fill(`${title} (tab A)`);
      await a.getByRole("button", { name: "Save game" }).click();
      const error = a.getByTestId("game-save-error");
      await error.waitFor({ timeout: 8000 });
      assert((await error.innerText()).includes(STALE), "tab A is told the game changed elsewhere");
      const saved = (await json(await request.get(`${BASE}/api/wheels/${created.id}`), "read game")).wheel;
      assert(saved.title === `${title} (tab B)`, "tab B's change was not overwritten");
      await a.getByTestId("game-reload-latest").click();
      await a.waitForFunction((t) => (document.querySelector("[data-testid='wheel-title-input']"))?.value === t, `${title} (tab B)`, { timeout: 8000 });
      // After Reload, tab A saves normally.
      await a.getByTestId("wheel-title-input").fill(`${title} (tab A after reload)`);
      await a.getByRole("button", { name: "Save game" }).click();
      await a.getByText("Saved", { exact: true }).waitFor({ timeout: 8000 });
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
      await request.delete(`${BASE}/api/wheels/${created.id}`).catch(() => {});
    }
  });
}
