// QA pass b5 regressions: the scratch reveal beat, keyboard and focus fixes, the
// drawer's truthful top-up, URL sections, the CSV import and starting a chat.
// Every fixture is the journey's own and is removed again.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, clickTab, goto, waitForSpinAcknowledged } from "./harness.mjs";
import { json } from "./focus.mjs";
import { cleanupGame, gameFeatureSettings, gameFixture, openGame, setGameFeatures, startGame } from "./games.mjs";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const activeLabel = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a && a !== document.body ? (a.getAttribute("data-testid") || a.getAttribute("aria-label") || a.textContent?.trim().slice(0, 40) || a.tagName) : "body";
});

async function newFan(request, name, spins = 3, { ack = true } = {}) {
  const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins } }), `create ${name}`);
  if (ack) await json(await acknowledgeFixtureFan(request, fan.token), `ack ${name}`);
  return fan;
}
const eraseFan = async (request, fanId) => { if (fanId) await request.delete(`${BASE}/api/fans/${fanId}`).catch(() => {}); };

async function emptyWheel(request, name) {
  return (await json(await request.post(BASE + "/api/wheels", { data: { name, gameKind: "wheel" } }), "create an empty wheel")).wheel;
}

export async function qaB5Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;
  const original = await gameFeatureSettings(request);
  let scratch = null;
  let bingo = null;
  const fans = [];
  const wheels = [];
  try {
    await setGameFeatures(request, { ...original, scratch: true, bingo: true });

    await step("qa-b5 M1: the revealed scratch ticket shows before the win card and stays after it", async () => {
      scratch = await gameFixture(request, "scratch", "QA b5 scratch", 6);
      const page = await (await browser.newContext(PHONE)).newPage();
      attachSink(page, sink);
      try {
        await openGame(page, scratch);
        await startGame(page);
        const revealAll = page.getByTestId("scratch-reveal-all");
        await revealAll.waitFor({ timeout: 8000 });
        // m6: PLAY went disabled; the keyboard lands on Reveal all, not <body>.
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "scratch-reveal-all", null, { timeout: 3000 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        assert(await page.getByTestId("scratch-ticket").getAttribute("data-revealed") === "true", "the ticket is revealed");
        assert(await page.getByTestId("reward-reveal").count() === 0, "the win card waits so the fan sees the ticket");
        await page.getByTestId("reward-reveal").waitFor({ timeout: 8000 });
        await page.getByRole("button", { name: "Awesome!" }).click();
        await page.getByTestId("reward-reveal").waitFor({ state: "hidden", timeout: 4000 });
        await waitForSpinAcknowledged(page);
        assert(await page.getByTestId("scratch-ticket").getAttribute("data-revealed") === "true", "after the card closes the ticket stays revealed");
        assert(await page.getByTestId("scratch-ready").count() === 0, "it does not reset to a blank ticket");
        assert(await activeLabel(page) === "fan-spin", "closing the card hands focus to PLAY");
        await page.getByTestId("fan-spin").click();
        await page.getByTestId("scratch-foil").waitFor({ timeout: 8000 });
        assert(await page.getByTestId("scratch-ticket").getAttribute("data-revealed") === "false", "the next play brings a fresh ticket");
      } finally { await page.context().close(); }
    });

    await step("qa-b5 M1: a bingo play shows the marked card before the win card", async () => {
      bingo = await gameFixture(request, "bingo", "QA b5 bingo", 4);
      const page = await (await browser.newContext(PHONE)).newPage();
      attachSink(page, sink);
      try {
        await openGame(page, bingo);
        const started = Date.now();
        const { result } = await startGame(page);
        await page.waitForTimeout(600);
        if (Date.now() - started < 1100) assert(await page.getByTestId("reward-reveal").count() === 0, "the win card waits on the marked card");
        assert(result.presentation.after.markedMask === 0 || await page.locator("[data-testid='bingo-cell'][data-marked='true']").count() > 0 || result.presentation.markedIndex === null, "the mark is on the card");
        await page.getByTestId("reward-reveal").waitFor({ timeout: 8000 });
        await page.getByRole("button", { name: "Awesome!" }).click();
        await waitForSpinAcknowledged(page);
      } finally { await page.context().close(); }
    });

    await step("qa-b5 M3: the fan chat dialog traps focus, closes on Escape and returns focus", async () => {
      const fan = await newFan(request, "QA b5 chat fan");
      fans.push(fan.fanId);
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      attachSink(page, sink);
      try {
        await goto(page, `/spin/${fan.token}`, 900);
        await page.getByTestId("chat-fab").focus();
        await page.keyboard.press("Enter");
        const panel = page.getByTestId("chat-panel");
        await panel.waitFor({ timeout: 4000 });
        assert(await panel.getAttribute("aria-modal") === "true", "opened from the button it is modal");
        await page.waitForFunction(() => document.querySelector("[data-testid='chat-panel']")?.contains(document.activeElement), null, { timeout: 3000 });
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
          assert(await page.evaluate(() => document.querySelector("[data-testid='chat-panel']")?.contains(document.activeElement)), `Tab stays inside the dialog (${i + 1})`);
        }
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden", timeout: 3000 });
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "chat-fab", null, { timeout: 3000 });
        await page.getByTestId("chat-fab").click();
        await panel.waitFor();
        await page.getByRole("button", { name: "Close chat" }).click();
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "chat-fab", null, { timeout: 3000 });
      } finally { await page.context().close(); }
    });

    await step("qa-b5 m6: after the age gate, focus lands on PLAY", async () => {
      const fan = await newFan(request, "QA b5 gate fan", 2, { ack: false });
      fans.push(fan.fanId);
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      attachSink(page, sink);
      try {
        await goto(page, `/spin/${fan.token}`, 900);
        const gate = page.getByRole("dialog", { name: "Before you play" });
        await gate.waitFor({ timeout: 5000 });
        for (const box of await gate.getByRole("checkbox").all()) await box.check();
        await gate.getByRole("button", { name: /Enter/ }).click();
        await gate.waitFor({ state: "hidden", timeout: 5000 });
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "fan-spin", null, { timeout: 3000 });
      } finally { await page.context().close(); }
    });

    await step("qa-b5 M2: Add spins to offers only real targets and a new link plays the chosen game", async () => {
      const empty = await emptyWheel(request, `QA b5 empty ${Date.now().toString(36)}`);
      wheels.push(empty.id);
      // An unscheduled playable second game: the scratch fixture, its schedule cleared.
      await json(await request.patch(`${BASE}/api/wheels/${scratch.wheel.id}`, { data: { activeFrom: null, activeUntil: null } }), "unschedule the scratch fixture");
      const name = `QA b5 topup ${Date.now().toString(36)}`;
      const fan = await newFan(request, name, 1);
      fans.push(fan.fanId);
      const page = await ctx.newPage();
      attachSink(page, sink);
      try {
        await goto(page, "/dashboard?section=fans", 1200);
        await page.getByRole("button", { name: `View ${name}`, exact: true }).click();
        const drawer = page.getByRole("dialog", { name: "Fan details" });
        await drawer.getByRole("button", { name: "Top up spins" }).click();
        const select = drawer.getByTestId("topup-target");
        await select.waitFor();
        const options = await select.locator("option").allInnerTexts();
        assert(!options.some((o) => o.includes(empty.title)), `a 0-prize wheel is never offered (${options.join(" / ")})`);
        assert(options.some((o) => /^Link \(no campaign\) · plays /.test(o)), "the fan's link is offered by what it plays");
        const fresh = options.find((o) => o.startsWith(`New link that plays ${scratch.wheel.title}`));
        assert(fresh, "the other playable game is offered only as a clearly new link");
        await select.selectOption({ label: fresh });
        assert(/Creates a new link/.test(await drawer.getByTestId("topup-outcome").innerText()), "the outcome says a new link is created");
        const pinned = page.waitForResponse((r) => r.url().includes(`/api/fans/${fan.fanId}/link-game`) && r.request().method() === "POST");
        await drawer.getByRole("button", { name: /^Grant/ }).click();
        assert((await pinned).ok(), "the new link is set to play the chosen game");
        await page.waitForFunction((id) => [...document.querySelectorAll("[data-testid='link-plays']")].some((el) => el.getAttribute("data-plays-game-id") === id), scratch.wheel.id, { timeout: 8000 });
        const names = await drawer.getByTestId("link-name").allInnerTexts();
        assert(new Set(names).size === names.length, `link names are distinct (${names.join(" / ")})`);
      } finally { await page.close(); }
      await json(await request.patch(`${BASE}/api/wheels/${scratch.wheel.id}`, { data: { activeFrom: new Date(Date.now() - 1000).toISOString(), activeUntil: null } }), "reschedule the scratch fixture");
    });

    await step("b5 follow-up: a new-link top-up confirmed only by Check outcome after a reload still plays the chosen game", async () => {
      // The scratch fixture unscheduled again, so the new link's chosen game is
      // not the live one: without its pin the link would play the live game.
      await json(await request.patch(`${BASE}/api/wheels/${scratch.wheel.id}`, { data: { activeFrom: null, activeUntil: null } }), "unschedule the scratch fixture");
      const name = `QA b5 recover ${Date.now().toString(36)}`;
      const fan = await newFan(request, name, 1);
      fans.push(fan.fanId);
      const page = await ctx.newPage();
      attachSink(page, sink);
      try {
        await goto(page, "/dashboard?section=fans", 1200);
        await page.getByRole("button", { name: `View ${name}`, exact: true }).click();
        let drawer = page.getByRole("dialog", { name: "Fan details" });
        await drawer.getByRole("button", { name: "Top up spins" }).click();
        const select = drawer.getByTestId("topup-target");
        await select.waitFor();
        const fresh = (await select.locator("option").allInnerTexts()).find((o) => o.startsWith(`New link that plays ${scratch.wheel.title}`));
        assert(fresh, "the scratch game is offered as a new link");
        await select.selectOption({ label: fresh });
        // The grant commits on the server; its reply never reaches the browser.
        await page.route("**/api/passes", async (route) => {
          await json(await route.fetch(), "commit the top-up before the lost reply");
          await route.abort("aborted");
        });
        await drawer.getByRole("button", { name: /^Grant/ }).click();
        await drawer.getByTestId("creator-request-recovery").waitFor({ timeout: 8000 });
        await page.unroute("**/api/passes");
        const receipt = await page.evaluate((id) => JSON.parse(sessionStorage.getItem(`ff:creator-intent:topup:${id}`) ?? "null"), fan.fanId);
        assert(receipt && Object.keys(receipt).sort().join(",") === "id,pin,signature" && receipt.pin === scratch.wheel.id, `the receipt keeps only the request id, its hash and the chosen game (${JSON.stringify(receipt && Object.keys(receipt))})`);
        const acceptReload = (dialog) => dialog.accept();
        page.on("dialog", acceptReload);
        try { await page.reload(); } finally { page.off("dialog", acceptReload); }
        drawer = page.getByRole("dialog", { name: "Fan details" });
        await drawer.waitFor({ timeout: 8000 });
        await drawer.getByRole("button", { name: "Top up spins" }).click();
        await drawer.getByTestId("creator-request-check").waitFor({ timeout: 8000 });
        const pinned = page.waitForResponse((r) => r.url().includes(`/api/fans/${fan.fanId}/link-game`) && r.request().method() === "POST", { timeout: 8000 });
        pinned.catch(() => {});
        await drawer.getByTestId("creator-request-check").click();
        assert((await pinned).ok(), "Check outcome sets the new link to play the chosen game");
        await page.waitForFunction((id) => [...document.querySelectorAll("[data-testid='link-plays']")].some((el) => el.getAttribute("data-plays-game-id") === id), scratch.wheel.id, { timeout: 8000 });
        const account = (await json(await request.get(`${BASE}/api/fans`), "read the fan list")).fans.find((f) => f.fanId === fan.fanId);
        const links = account?.passes ?? [];
        assert(links.length === 2 && links.filter((p) => p.wheelId === scratch.wheel.id && p.pinnedWheelId === scratch.wheel.id).length === 1, "exactly one new link, stored on and set to the chosen game");
        assert(links.some((p) => p.wheelId !== scratch.wheel.id && !p.pinnedWheelId), "the fan's original link was not re-pointed");
        assert(await page.evaluate((id) => sessionStorage.getItem(`ff:creator-intent:topup:${id}`) === null, fan.fanId), "the confirmed outcome released the receipt");
      } finally { await page.unroute("**/api/passes").catch(() => {}); await page.close(); }
      await json(await request.patch(`${BASE}/api/wheels/${scratch.wheel.id}`, { data: { activeFrom: new Date(Date.now() - 1000).toISOString(), activeUntil: null } }), "reschedule the scratch fixture");
    });

    await step("qa-b5 m5: the dashboard section lives in the URL; reload and Back keep it", async () => {
      const page = await ctx.newPage();
      attachSink(page, sink);
      try {
        await goto(page, "/dashboard?section=editor", 1200);
        await clickTab(page, "Fans");
        assert(new URL(page.url()).searchParams.get("section") === "fans", "switching section updates ?section=");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { level: 1, name: "Fans" }).waitFor({ timeout: 8000 });
        await page.goBack();
        await page.getByRole("heading", { level: 1, name: "Games" }).waitFor({ timeout: 8000 });
        await page.goForward();
        await page.getByRole("heading", { level: 1, name: "Fans" }).waitFor({ timeout: 8000 });
      } finally { await page.close(); }
    });

    await step("qa-b5 m5: on a phone, Back closes the fan drawer instead of leaving the dashboard", async () => {
      const page = await (await browser.newContext(PHONE)).newPage();
      attachSink(page, sink);
      try {
        await goto(page, "/dashboard?section=fans", 1400);
        await page.getByRole("button", { name: /^View / }).first().click();
        const drawer = page.getByRole("dialog", { name: "Fan details" });
        await drawer.waitFor({ timeout: 5000 });
        assert(new URL(page.url()).searchParams.get("fan"), "the open fan is in the URL");
        await page.goBack();
        await drawer.waitFor({ state: "hidden", timeout: 5000 });
        assert(new URL(page.url()).pathname === "/dashboard" && new URL(page.url()).searchParams.get("section") === "fans", "still on the dashboard's Fans section");
      } finally { await page.context().close(); }
    });

    await step("qa-b5 m4: the CSV import reads quotes and thousands, rejects negatives and warns on duplicates", async () => {
      const page = await ctx.newPage();
      attachSink(page, sink);
      try {
        await goto(page, "/dashboard?section=fans", 1200);
        await page.getByRole("button", { name: "Import fans" }).click();
        const form = page.getByRole("region", { name: "Bulk import fans" });
        await form.getByLabel("CSV rows").fill('name,spins,amount\nCarol,-3,2\n"Import, Cat",4,10\nEve,1,$1,200\nEve,2');
        const table = await form.locator("tbody tr").allInnerTexts();
        assert(table.length === 3 && table[0].includes("Import, Cat") && table[1].includes("$1200.00"), `quoted names and $1,200 parse (${table.join(" / ")})`);
        assert(/Line 2 \(Carol\): spins can't be negative/.test(await form.getByTestId("import-errors").innerText()), "a negative row is rejected with its line");
        assert(/same name as line 4/.test(await form.getByTestId("import-warnings").innerText()), "a repeated name is warned about");
        assert(await form.getByLabel("Imported fans join").getAttribute("data-testid") === "import-campaign", "the campaign imported fans join is shown");
        await form.getByLabel("CSV rows").fill("");
        await form.getByRole("button", { name: "Close" }).click();
      } finally { await page.close(); }
    });

    await step("qa-b5 m8: a creator can start a conversation from the fan drawer", async () => {
      const name = `QA b5 quiet ${Date.now().toString(36)}`;
      const fan = await newFan(request, name, 2);
      fans.push(fan.fanId);
      const page = await ctx.newPage();
      attachSink(page, sink);
      try {
        await goto(page, "/dashboard?section=fans", 1200);
        await page.getByRole("button", { name: `View ${name}`, exact: true }).click();
        const drawer = page.getByRole("dialog", { name: "Fan details" });
        const message = drawer.getByRole("button", { name: "Message" });
        await page.waitForFunction(() => [...document.querySelectorAll("[role='dialog'] button")].some((b) => b.textContent?.trim() === "Message" && b.getAttribute("data-has-thread") === "false"), null, { timeout: 8000 });
        assert(!(await message.isDisabled()), "Message works for a fan who hasn't written");
        await message.click();
        const compose = drawer.getByTestId("start-conversation");
        await compose.getByRole("textbox").fill("Hi from QA b5");
        await compose.getByRole("button", { name: "Send" }).click();
        await page.getByRole("list", { name: "Conversations" }).locator("button[aria-current='true']").filter({ hasText: name }).waitFor({ timeout: 8000 });
        const thread = await json(await request.post(BASE + "/api/messages/fan/thread", { data: { token: fan.token } }), "fan reads the thread");
        assert(thread.messages.some((m) => m.sender === "creator" && m.body === "Hi from QA b5"), "the fan's chat has the creator's first message");
      } finally { await page.close(); }
    });
  } finally {
    for (const id of fans) await eraseFan(request, id);
    for (const id of wheels) await request.delete(`${BASE}/api/wheels/${id}`).catch(() => {});
    await cleanupGame(request, scratch).catch(() => {});
    await cleanupGame(request, bingo).catch(() => {});
    await setGameFeatures(request, original).catch(() => {});
  }
}

// A11y states for the same fixes (registered in e2e/a11y.mjs).
const owned = new WeakMap();
async function chatOpen(page) {
  const fan = await newFan(page.request, "A11y b5 chat fan");
  owned.set(page, { fans: [fan.fanId] });
  await goto(page, `/spin/${fan.token}`, 900);
  await page.getByTestId("chat-fab").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("chat-panel").waitFor({ timeout: 4000 });
}
async function startConversation(page) {
  const name = `A11y b5 quiet ${Date.now().toString(36)}`;
  const fan = await newFan(page.request, name, 2);
  owned.set(page, { fans: [fan.fanId] });
  await goto(page, "/dashboard?section=fans", 1200);
  await page.getByRole("button", { name: `View ${name}`, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Fan details" });
  await page.waitForFunction(() => [...document.querySelectorAll("[role='dialog'] button")].some((b) => b.getAttribute("data-has-thread") === "false"), null, { timeout: 8000 });
  await drawer.getByRole("button", { name: "Message" }).click();
  await drawer.getByTestId("start-conversation").waitFor();
}
async function importErrors(page) {
  await clickTab(page, "Fans");
  await page.getByRole("button", { name: "Import fans" }).click();
  await page.getByRole("region", { name: "Bulk import fans" }).getByLabel("CSV rows").fill('Carol,-3,2\n"Import, Cat",4,10\nCarol,1');
  await page.getByTestId("import-errors").waitFor();
}
async function bingoDraft(page) {
  const original = await gameFeatureSettings(page.request);
  await setGameFeatures(page.request, { ...original, bingo: true });
  const wheel = (await json(await page.request.post(BASE + "/api/wheels", { data: { name: `A11y b5 bingo ${Date.now().toString(36)}`, gameKind: "bingo", gameConfig: { size: 3, linePrizeId: null } } }), "create a bingo draft")).wheel;
  owned.set(page, { wheels: [wheel.id], features: original });
  await goto(page, "/dashboard?section=editor", 1200);
  await page.locator("section[aria-label='Game switcher']").getByRole("button", { name: new RegExp(`^${wheel.title}`) }).click();
  await page.getByTestId("bingo-missing").waitFor({ timeout: 8000 });
}
async function cleanupOwned(page) {
  const state = owned.get(page);
  if (!state) return;
  owned.delete(page);
  for (const id of state.fans ?? []) await eraseFan(page.request, id);
  for (const id of state.wheels ?? []) await page.request.delete(`${BASE}/api/wheels/${id}`).catch(() => {});
  if (state.features) await setGameFeatures(page.request, state.features);
}
export function qaB5A11yStates(advisory = []) {
  const PHONE_VIEW = { width: 390, height: 844 };
  return [
    { path: null, name: "fan chat dialog (open from keyboard)", prep: chatOpen, cleanup: cleanupOwned },
    { path: null, name: "fan chat dialog phone (open from keyboard)", viewport: PHONE_VIEW, prep: chatOpen, cleanup: cleanupOwned },
    { path: null, name: "dashboard (fan drawer: start a conversation)", prep: startConversation, cleanup: cleanupOwned, advisory },
    { path: "/dashboard", name: "dashboard (Import fans: row errors and warnings)", prep: importErrors, advisory },
    { path: null, name: "dashboard (bingo draft: what's missing)", prep: bingoDraft, cleanup: cleanupOwned, advisory },
  ];
}
