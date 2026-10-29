// Game switching: the owner scheduled a scratch ticket and a link whose screen
// said "Spin to Win" started playing it. This journey schedules a scratch game
// from the Games screen, accepts the takeover warning, and checks that the
// campaign card, the fan drawer and the real fan page all agree on what plays.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, BASE, goto, clickTab, attachSink } from "./harness.mjs";
import { json } from "./focus.mjs";
import { gameFeatureSettings, setGameFeatures } from "./games.mjs";

/** Local value for <input type="datetime-local"> (minute precision). */
function localInput(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

async function readyScratch(request, title) {
  const created = await json(await request.post(BASE + "/api/wheels", { data: { name: title, gameKind: "scratch", gameConfig: { style: "classic" } } }), "create switching scratch");
  const prizes = ["🌿", "🌷", "☀️"].map((emoji, index) => ({ id: randomUUID(), label: `${title} prize ${index + 1}`, rarity: index === 2 ? "rare" : "common",
    weight: index + 1, emoji, stock: null, cost: 100 }));
  const { gameKindLocked: _locked, gameReady: _ready, ...editable } = created.wheel;
  const saved = (await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable, gameKind: "scratch", gameConfig: { style: "classic" }, prizes } } }), "save switching scratch")).wheel;
  if (saved.gameReady !== true) throw new Error("switching scratch did not become ready");
  return saved;
}

async function openGames(page) {
  await goto(page, "/dashboard", 600);
  await clickTab(page, "Games");
  await page.getByTestId("live-game").waitFor({ timeout: 10000 });
}

export async function gameSwitchingJourney(browser, { step, assert }, sink, ctx) {
  const page = await ctx.newPage(); attachSink(page, sink);
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const state = { campaigns: [], fans: [] };
  try {
    await step("game switching: scheduling a scratch warns which game it replaces, then shows it live", async () => {
      state.original = await gameFeatureSettings(ctx.request);
      await setGameFeatures(ctx.request, { ...state.original, scratch: true });
      state.scratch = await readyScratch(ctx.request, `Switch Scratch ${suffix}`);
      await openGames(page);
      state.before = await page.getByTestId("live-game").getAttribute("data-live-game-id");
      const games = (await json(await ctx.request.get(BASE + "/api/wheels"), "read games")).wheels;
      const beforeGame = games.find((w) => w.id === state.before);
      assert(beforeGame && beforeGame.id !== state.scratch.id, "a different game is live before scheduling");
      state.beforeTitle = beforeGame.title;
      state.wheelId = games.find((w) => (w.gameKind ?? "wheel") === "wheel" && w.gameReady !== false && !w.archivedAt)?.id;
      assert(state.wheelId, "a playable wheel exists to choose for a campaign");
      assert(await page.getByTestId("live-game").getByTestId("kind-badge").count() === 1, "live line carries a visible kind badge");
      const switcher = page.getByRole("region", { name: "Game switcher" });
      const chip = switcher.getByRole("button", { name: new RegExp(`^Switch Scratch ${suffix}`) });
      assert(await chip.locator("[data-testid='kind-badge'][data-kind='scratch']").count() === 1, "every chip shows its kind");
      await chip.click();
      await page.getByRole("region", { name: `Schedule for Switch Scratch ${suffix}` }).waitFor({ timeout: 8000 });
      assert(/replaces your live game/.test(await page.locator("#schedule-effect").innerText()), "schedule inputs explain the takeover in plain words");
      const until = new Date(Date.now() + 2 * 86400000);
      await page.getByLabel("Active from").fill(localInput(new Date()));
      await page.getByLabel("Active until").fill(localInput(until));
      await page.getByRole("button", { name: "Save schedule" }).click();
      const dialog = page.getByRole("dialog", { name: `Replace ${state.beforeTitle} for fans?` });
      await dialog.waitFor({ timeout: 5000 });
      assert((await dialog.innerText()).includes(`Switch Scratch ${suffix}`), "confirm names the game that takes over");
      assert(await page.evaluate(() => document.activeElement?.textContent?.includes("Don’t schedule")), "focus lands on the safe choice");
      await dialog.getByRole("button", { name: "Yes, schedule it" }).click();
      await page.locator(`[data-testid='live-game'][data-live-game-id='${state.scratch.id}']`).waitFor({ timeout: 8000 });
      const line = await page.getByTestId("live-game").innerText();
      assert(line.includes(`Switch Scratch ${suffix}`) && /Scratch/.test(line) && /scheduled until/.test(line), "live line says the scratch is live because of its schedule");
      assert(await page.getByTestId("game-used-by").count() === 1, "editor lists which campaigns use the game");
    });

    await step("game switching: campaign cards say what they play and new campaigns pick a game", async () => {
      await clickTab(page, "Campaigns");
      const name = page.getByLabel("Campaign name");
      await name.waitFor({ timeout: 8000 });
      const select = page.getByLabel("Game fans play");
      for (let i = 0; i < 40 && !(await select.isEnabled() && await select.inputValue() === state.scratch.id); i++) await page.waitForTimeout(200);
      assert(await select.inputValue() === state.scratch.id, "a new campaign defaults to the game fans get now");
      await name.fill(`Follow ${suffix}`);
      await select.selectOption("");
      assert(/Follow my live game: /.test(await page.getByText(/^Follow my live game: this campaign/).innerText()), "following the live game is explained");
      const created = page.waitForResponse((r) => r.url().endsWith("/api/campaigns") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Create campaign" }).click();
      const follow = await json(await created, "create following campaign");
      state.campaigns.push(follow.campaign.id); state.follow = follow.campaign;
      assert(follow.campaign.pinnedWheelId === null, "follow choice reaches the server");
      const card = page.locator("section").filter({ has: page.getByRole("heading", { name: `Follow ${suffix}` }) });
      const plays = card.getByTestId("campaign-plays");
      await plays.waitFor({ timeout: 8000 });
      assert(await plays.getAttribute("data-plays-game-id") === state.scratch.id && /Follows your live game/.test(await plays.innerText()) && /Scratch/.test(await plays.innerText()), "card says it follows the live game, currently the scratch");
      await name.fill(`Pinned ${suffix}`);
      await select.selectOption(state.wheelId);
      const made = page.waitForResponse((r) => r.url().endsWith("/api/campaigns") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Create campaign" }).click();
      const pinned = await json(await made, "create campaign with a chosen game");
      state.campaigns.push(pinned.campaign.id);
      assert(pinned.campaign.pinnedWheelId === state.wheelId, "chosen game reaches the server");
      const pinnedCard = page.locator("section").filter({ has: page.getByRole("heading", { name: `Pinned ${suffix}` }) }).getByTestId("campaign-plays");
      await pinnedCard.waitFor({ timeout: 8000 });
      assert(/Plays:/.test(await pinnedCard.innerText()) && await pinnedCard.getAttribute("data-plays-game-id") === state.wheelId, "card shows the chosen game, not the schedule");
      await plays.getByRole("button", { name: /^Edit game/ }).click();
      await page.getByRole("region", { name: `Schedule for Switch Scratch ${suffix}` }).waitFor({ timeout: 8000 });
      assert(/Choose games for campaigns/.test(await page.getByTestId("game-used-by").innerText()), "Edit game jumps straight to that game's editor");
    });

    await step("game switching: the fan drawer and the fan page agree on what a link plays", async () => {
      const fan = await json(await ctx.request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: `Switch fan ${suffix}`, spins: 4, campaignId: state.follow.id } }), "mint link in following campaign");
      state.fans.push(fan.fanId);
      await json(await acknowledgeFixtureFan(ctx.request, fan.token), "ack switching fan");
      await goto(page, "/dashboard", 600);
      await clickTab(page, "Fans");
      await page.getByRole("button", { name: `View Switch fan ${suffix}` }).first().click();
      const drawer = page.getByRole("dialog", { name: "Fan details" });
      const plays = drawer.getByTestId("link-plays").first();
      await plays.waitFor({ timeout: 8000 });
      assert(await plays.getAttribute("data-plays-game-id") === state.scratch.id && /This link plays:/.test(await plays.innerText()) && /your live game/.test(await plays.innerText()), "drawer shows the scheduled scratch, from the resolver");
      const fanPage = await ctx.newPage(); attachSink(fanPage, sink);
      await goto(fanPage, `/spin/${fan.token}`, 300);
      await fanPage.locator("[data-testid='fan-game'][data-game-kind='scratch']").waitFor({ timeout: 10000 });
      await fanPage.close();
      await plays.getByRole("button", { name: "Change game" }).click();
      const select = drawer.getByLabel(`Game for campaign “Follow ${suffix}”`);
      await select.waitFor({ timeout: 4000 });
      const saved = page.waitForResponse((r) => r.url().includes(`/api/campaigns/${state.follow.id}`) && r.request().method() === "PATCH");
      await select.selectOption(state.wheelId);
      assert((await saved).ok(), "campaign game change from the drawer is accepted");
      await drawer.locator(`[data-testid='link-plays'][data-plays-game-id='${state.wheelId}']`).first().waitFor({ timeout: 8000 });
      assert(/via campaign/.test(await drawer.getByTestId("link-plays").first().innerText()), "link now plays the campaign's game");
      const wheelPage = await ctx.newPage(); attachSink(wheelPage, sink);
      await goto(wheelPage, `/spin/${fan.token}`, 300);
      await wheelPage.locator("[data-testid='fan-game'][data-game-kind='wheel']").waitFor({ timeout: 10000 });
      await wheelPage.close();
    });
  } finally {
    await goto(page, "/dashboard", 100).catch(() => {});
    for (const fanId of state.fans) await ctx.request.delete(`${BASE}/api/fans/${fanId}`).catch(() => {});
    for (const id of state.campaigns) await ctx.request.delete(`${BASE}/api/campaigns/${id}`).catch(() => {});
    if (state.scratch) {
      await ctx.request.patch(`${BASE}/api/wheels/${state.scratch.id}`, { data: { activeFrom: null, activeUntil: null } }).catch(() => {});
      await ctx.request.delete(`${BASE}/api/wheels/${state.scratch.id}`).catch(() => {});
    }
    if (state.original) await setGameFeatures(ctx.request, state.original);
    await page.close();
  }
}
