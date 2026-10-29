// RM-7 real game fixtures. Gestures only present outcomes returned by the real play endpoint.
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { acknowledgeFixtureFan, BASE, goto, attachSink, ensureArtifacts } from "./harness.mjs";
import { json } from "./focus.mjs";
import { closeInstantCard } from "./instant.mjs";

const OWN_ACCOUNT = "acc-you";
export async function gameCapabilities(request) {
  const account = await json(await request.get(BASE + "/api/account"), "read game capabilities");
  if (!account.features || typeof account.features !== "object") throw new Error("server-controlled game capabilities missing");
  return account.features;
}
export async function gameFeatureSettings(request) {
  const overview = await json(await request.get(BASE + "/api/admin"), "read original demo game flags");
  const account = overview.accounts.find(account => account.id === OWN_ACCOUNT);
  if (!account || !account.features || typeof account.features !== "object") throw new Error("owned account feature settings missing");
  return { ...account.features };
}
export async function setGameFeatures(request, features) {
  await json(await request.post(BASE + "/api/admin/account", { data: { id: OWN_ACCOUNT, features } }), "set owned demo game features");
}
export async function gameFixture(request, kind = "scratch", title = "Games", spins = 24) {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const fixture = { kind, title: `${title} ${suffix}`, fans: [], packs: [] };
  try {
    const created = await json(await request.post(BASE + "/api/wheels", { data: { name: fixture.title, gameKind: kind,
      gameConfig: kind === "scratch" ? { style: "classic" } : { size: 3, linePrizeId: null } } }), "create game fixture");
    fixture.wheel = created.wheel;
    const cells = Array.from({ length: kind === "bingo" ? 10 : 3 }, (_, index) => ({ id: randomUUID(), label: `${title} prize ${index + 1}`,
      rarity: index === 8 || (kind === "scratch" && index === 2) ? "rare" : "common", weight: index + 1,
      emoji: ["🌿","🌷","☀️","🌙","🦋","🍀","🌺","🪷","⭐","🌻"][index], stock: null, cost: 100, boostable: index === 0 }));
    const linePrize = { id: randomUUID(), label: `${title} private line bonus`, rarity: "rare", weight: 0, emoji: "🎟️", stock: null, cost: 100 };
    const { gameKindLocked: _locked, gameReady: _ready, ...editable } = created.wheel;
    fixture.wheel = (await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable, gameKind: kind,
      gameConfig: kind === "scratch" ? { style: "classic" } : { size: 3, linePrizeId: linePrize.id }, prizes: kind === "bingo" ? [...cells,linePrize] : cells } } }), "save valid game fixture")).wheel;
    if (fixture.wheel.gameReady !== true) throw new Error("valid saved game did not become ready");
    fixture.cellPrizes = fixture.wheel.prizes.filter(prize => cells.some(cell => cell.id === prize.id));
    fixture.linePrize = fixture.wheel.prizes.find(prize => prize.id === linePrize.id);
    await json(await request.patch(`${BASE}/api/wheels/${fixture.wheel.id}`, { data: { activeFrom: new Date(Date.now() - 1000).toISOString(), activeUntil: null } }), "schedule own game fixture");
    const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: fixture.title + " fan", spins, wheelId: fixture.wheel.id } }), "create game fan");
    fixture.token = fan.token; fixture.fanId = fan.fanId; fixture.fans.push(fan.fanId);
    await json(await acknowledgeFixtureFan(request, fan.token), "ack game fan");
    return fixture;
  } catch (error) {
    try { await cleanupGame(request, fixture); }
    catch (cleanupError) { throw new AggregateError([error,cleanupError], "Game fixture and cleanup failed"); }
    throw error;
  }
}

export async function createGameFan(request, fixture, name, spins = 12) {
  const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins, wheelId: fixture.wheel.id } }), "create isolated game fan");
  fixture.fans.push(fan.fanId);
  await json(await acknowledgeFixtureFan(request, fan.token), "ack isolated game fan");
  return { ...fixture, token: fan.token, fanId: fan.fanId };
}
export async function grantGameFocus(request, fixture) {
  const pack = (await json(await request.post(BASE + "/api/campaign-packs", { data: { label: fixture.title + " focus", spins: 5, bonusSpins: 0,
    amountCents: 1000, packKind: "focus", focusMultiplier: 3, focusSpins: 5 } }), "create focused game pack")).pack;
  fixture.packs.push(pack.id);
  const context = await json(await request.get(`${BASE}/api/fans/${fixture.fanId}/focus`), "read game focus grant context");
  const pass = context.passes.find(pass => pass.wheelId === fixture.wheel.id);
  if (!pass) throw new Error("game focus pass unavailable");
  return json(await request.post(`${BASE}/api/fans/${fixture.fanId}/focus`, { data: { requestId: randomUUID(), packId: pack.id,
    prizeId: fixture.cellPrizes[0].id, passId: pass.id } }), "grant focused game pack");
}

export async function cleanupGame(request, fixture) {
  if (!fixture) return;
  for (const fanId of fixture.fans ?? []) await json(await request.delete(`${BASE}/api/fans/${fanId}`), "erase owned game fan");
  for (const packId of fixture.packs ?? []) await json(await request.delete(`${BASE}/api/campaign-packs/${packId}`), "delete owned game pack");
  if (fixture.wheel?.id) await json(await request.delete(`${BASE}/api/wheels/${fixture.wheel.id}`), "archive owned game");
}
export async function clearOwnedGameIntent(page, token) {
  if (!token) return;
  const key = "ff-spin-intent-v1:" + createHash("sha256").update(token).digest("hex");
  await page.evaluate(key => localStorage.removeItem(key), key);
}
export async function openGame(page, fixture, reduced = false) {
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await goto(page, `/spin/${fixture.token}`, 250);
  await page.locator(`[data-testid='fan-game'][data-game-kind='${fixture.kind}']`).waitFor({ timeout: 10000 });
}
export async function startGame(page) {
  const wait = page.waitForResponse(response => response.url().endsWith("/api/spin") && response.request().method() === "POST");
  wait.catch(() => {});
  await page.getByTestId("fan-spin").click();
  const response = await wait;
  return { response, result: await json(response, "play actual game"), body: response.request().postDataJSON() };
}
export async function scratchFoil(page) {
  for (let row = 0; row < 10 && await page.getByTestId("scratch-foil").isVisible(); row++) {
    const box = await page.getByTestId("scratch-foil").boundingBox();
    if (!box) break;
    const y = box.y + box.height * (0.06 + row * 0.095);
    await page.mouse.move(box.x + box.width * 0.03, y); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.97, y, { steps: 20 }); await page.mouse.up();
  }
  await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
}
export async function gameScreenshot(page, name, width) {
  const dir = ensureArtifacts() + "games/"; mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}-${width}.png`, fullPage: true });
}
async function assertProof(page, result, kind, assert) {
  await goto(page, `/verify/${result.shareId}`, 300);
  await page.getByRole("heading", { name: kind === "scratch" ? "Replayed scratch ticket" : "Replayed bingo card" }).waitFor({ timeout: 10000 });
  assert(/verified|matches/i.test(await page.locator("body").innerText()), "public verifier accepts actual committed game");
  if (kind === "scratch") {
    const labels = await page.getByRole("list", { name: "Scratch ticket cells, left to right by row" }).locator("li").allInnerTexts();
    assert(labels.length === 9 && result.presentation.cells.every((cell,index) => labels[index].includes(cell.label)), "public proof replays the exact ticket face");
  }
}

export async function scratchJourney(browser, { step, assert }, sink, ctx) {
  const page = await ctx.newPage(); attachSink(page, sink);
  let fixture; let original; let phoneContext;
  try {
    await step("scratch: real game, committed nine-cell ticket and one credit per play", async () => {
      original = await gameFeatureSettings(ctx.request);
      await setGameFeatures(ctx.request, { ...original, scratch: true });
      assert((await gameCapabilities(ctx.request)).scratch === true, "capability comes from the server-controlled feature flag");
      fixture = await gameFixture(ctx.request, "scratch", "Scratch", 16);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openGame(page, fixture);
      const { result, body } = await startGame(page); fixture.first = result; fixture.firstBody = body;
      assert(result.gameKind === "scratch" && result.presentation.cells.length === 9 && result.bonusWins.length === 0, "server decides face and ordinary win together");
      assert(result.spinsRemaining === 15, "one credited play spends exactly one credit");
      await page.getByTestId("scratch-foil").waitFor();
      const symbols = await page.getByTestId("scratch-cell").evaluateAll(cells => cells.map(cell => cell.dataset.symbolId));
      assert(JSON.stringify(symbols) === JSON.stringify(result.presentation.cells.map(cell => cell.id)), "renderer uses the immutable server face");
      assert(await page.getByTestId("scratch-face").getAttribute("aria-hidden") === "true", "foil has an explicit keyboard reveal path");
      await gameScreenshot(page, "scratch-foil", 1440);
      await scratchFoil(page);
      assert((await page.getByTestId("reward-reveal").innerText()).includes(result.prize.label), "scratching presents that exact primary prize");
      assert(await page.getByTestId("near-miss-beat").count() === 0, "scratch never shows wheel near-miss theater");
      await closeInstantCard(page);
      const replay = await json(await ctx.request.post(BASE + "/api/spin", { data: body }), "replay same scratched ticket");
      assert(replay.shareId === result.shareId && replay.spinsRemaining === 15 && JSON.stringify(replay.presentation) === JSON.stringify(result.presentation), "same intent cannot reroll face or debit twice");
    });
    await step("scratch: keyboard Reveal all and exact public proof", async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await openGame(page, fixture);
      const { result } = await startGame(page);
      await page.getByTestId("scratch-reveal-all").focus(); await page.keyboard.press("Enter");
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      assert((await page.getByTestId("reward-reveal").innerText()).includes(result.prize.label), "keyboard reveal presents committed winner");
      assert(await page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null), "shared reward dialog receives keyboard focus");
      await gameScreenshot(page, "scratch-keyboard-win", 390);
      await closeInstantCard(page);
      await assertProof(page, result, "scratch", assert);
    });
    await step("scratch: interrupted touch stroke, resize and DPR2 preserve the same foil", async () => {
      phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
      const phone = await phoneContext.newPage(); attachSink(phone, sink);
      await openGame(phone, fixture); const { result } = await startGame(phone);
      await phone.getByTestId("scratch-foil").waitFor();
      await phone.getByTestId("scratch-foil").evaluate(canvas => {
        const rect = canvas.getBoundingClientRect(); const x = rect.left + rect.width * 0.2; const y = rect.top + rect.height * 0.2;
        const event = (type, clientX) => new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX, clientY: y, buttons: 1, bubbles: true });
        canvas.dispatchEvent(event("pointerdown", x)); canvas.dispatchEvent(event("pointermove", x + rect.width * 0.2)); canvas.dispatchEvent(event("pointercancel", x + rect.width * 0.2));
      });
      await phone.setViewportSize({ width: 360, height: 800 });
      await phone.waitForTimeout(100);
      const alpha = await phone.getByTestId("scratch-foil").evaluate(canvas => canvas.getContext("2d").getImageData(Math.round(canvas.width * 0.3), Math.round(canvas.height * 0.2), 1, 1).data[3]);
      assert(alpha < 255, "normalized cosmetic stroke survives cancel, resize and backing-scale change");
      assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "360px has no horizontal overflow");
      await gameScreenshot(phone, "scratch-touch-dpr2", 360);
      await phone.getByTestId("scratch-reveal-all").click(); await phone.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      assert((await phone.getByTestId("reward-reveal").innerText()).includes(result.prize.label), "interrupted gestures cannot change winner");
      await closeInstantCard(phone);
      await phoneContext.close(); phoneContext = null;
    });
    await step("scratch: reload recovers the same committed ticket without auto-playing", async () => {
      await openGame(page, fixture);
      let committed; let intent; let posts = 0;
      await page.route("**/api/spin", async route => { posts++; intent = route.request().postDataJSON(); committed = await json(await route.fetch(), "commit before cancelled delivery"); await route.abort("aborted"); });
      await page.getByTestId("fan-spin").click(); await page.getByTestId("spin-recovery-controls").waitFor({ timeout: 10000 });
      await page.unroute("**/api/spin");
      await page.reload();
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      const status = await json(await ctx.request.post(BASE + "/api/spin/status", { data: intent }), "recover saved scratch");
      assert(posts === 1 && status.result.shareId === committed.shareId && JSON.stringify(status.result.presentation) === JSON.stringify(committed.presentation), "reload replays the original receipt and face only");
      await closeInstantCard(page);
    });
    await step("scratch: withdrawing feature blocks new games while paid links still work", async () => {
      await setGameFeatures(ctx.request, { ...original, scratch: false });
      const refused = await ctx.request.post(BASE + "/api/wheels", { data: { gameKind: "scratch", gameConfig: { style: "classic" }, name: "Refused scratch" } });
      assert(!refused.ok() && (await refused.json()).error === "feature_disabled", "server refuses unavailable game without a UI bypass");
      await openGame(page, fixture, true); const { result } = await startGame(page);
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      assert(result.gameKind === "scratch", "existing paid game remains playable with a calm reduced-motion reveal");
      await closeInstantCard(page);
      await setGameFeatures(ctx.request, { ...original, scratch: true });
    });
    await step("scratch: focus advances only once and a break closes every play prompt", async () => {
      const focused = await createGameFan(ctx.request, fixture, fixture.title + " focused fan", 3);
      await grantGameFocus(ctx.request, focused);
      await openGame(page, focused, true);
      const { result } = await startGame(page);
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      assert(result.focusConsumed === true && result.focus.spinsLeft === 4 && result.spinsRemaining === 7, "one scratch play consumes one credit and one eligible focused spin");
      await closeInstantCard(page);
      await json(await ctx.request.post(BASE + "/api/fan/break", { data: { token: focused.token, duration: "24h" } }), "take break from scratch");
      await openGame(page, focused, true);
      assert(await page.getByTestId("fan-spin").isDisabled(), "break prevents another paid game");
      assert(/progress is kept/.test(await page.getByTestId("fan-focus-paused").innerText()), "focused progress is kept without a play nudge");
      const refused = await ctx.request.post(BASE + "/api/spin", { data: { token: focused.token, requestId: randomUUID(), clientSeed: "on-break-scratch" } });
      assert(refused.status() === 403 && (await refused.json()).error === "on_break", "server enforces the same break for scratch");
      const state = await json(await ctx.request.get(`${BASE}/api/fans/${focused.fanId}/focus`), "read protected focus progress");
      assert(state.focus.spinsLeft === 4 && state.passes.find(pass => pass.wheelId === fixture.wheel.id).spinsRemaining === 7, "refusal advances no credit or focus state");
      await clearOwnedGameIntent(page, focused.token);
    });
  } finally {
    await page.unroute("**/api/spin").catch(() => {});
    if (phoneContext) await phoneContext.close();
    await goto(page, "/dashboard", 100);
    await cleanupGame(ctx.request, fixture);
    if (fixture) await clearOwnedGameIntent(page, fixture.token);
    if (original) await setGameFeatures(ctx.request, original);
    await page.close();
  }
}

// Owned page only: choose a legitimate browser-controlled client seed. UUIDs
// and every other random-byte request still use the native implementation.
export const GAME_CLIENT_SEED = "0011223344556677";
export async function knownGameClientSeed(page) {
  await page.addInitScript(() => {
    const original = crypto.getRandomValues.bind(crypto);
    const bytes = Uint8Array.from([0,17,34,51,68,85,102,119]);
    crypto.getRandomValues = array => array instanceof Uint8Array && array.length === 8 ? (array.set(bytes), array) : original(array);
  });
}
export async function privateLineReward(request, fixture) {
  fixture.privateBonusValue = `Private line note ${fixture.title}. Winner only.`;
  await json(await request.put(`${BASE}/api/prizes/${fixture.linePrize.id}/reward`, { data: { kind: "text", value: fixture.privateBonusValue } }), "configure private line reward");
}
export async function playBingoPrize(page, request, fixture, prizeId, { keepOpen = false } = {}) {
  // Respect the real eight-play/ten-second guard; no counter or clock is reset.
  const wait = Math.max(0, 1400 - (Date.now() - (fixture.lastRequestedAt ?? 0)));
  if (wait) await page.waitForTimeout(wait);
  const prepared = await json(await request.post(BASE + "/api/debug/game-fixture", { data: { token: fixture.token, clientSeed: GAME_CLIENT_SEED, targetPrizeId: prizeId } }), "search a real committed seed for this fixture");
  if (!/^[a-f0-9]{64}$/.test(prepared.nextServerSeedHash) || !Number.isSafeInteger(prepared.attempts) || prepared.attempts < 1) throw new Error("invalid bounded game seed fixture reply");
  await openGame(page, fixture, true);
  fixture.lastRequestedAt = Date.now();
  const { result, body } = await startGame(page);
  await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
  if (result.prize.id !== prizeId || body.clientSeed !== GAME_CLIENT_SEED) throw new Error("fixture did not execute the actual requested seed search");
  fixture.last = result; fixture.lastBody = body;
  if (!keepOpen) await closeInstantCard(page);
  return result;
}
export async function readyBingoFinal(page, request, fixture) {
  if (!fixture.last) await playBingoPrize(page, request, fixture, fixture.cellPrizes[0].id);
  const card = fixture.last.presentation.after;
  // Leave an unmarked common center/corner for a real multi-line final play.
  const lastIndex = [4,0,2,6,8].find(index => !(card.markedMask & (1 << index)) && card.cells[index].rarity === "common");
  if (lastIndex === undefined) throw new Error("fixture has no unmarked common crossing square");
  fixture.finalPrizeId = card.cells[lastIndex].id;
  // Keep the real pity state feasible before requesting common squares. This
  // is a genuine rare-prize play, whether that prize is on or outside the card.
  const rare = fixture.cellPrizes.find(prize => prize.rarity === "rare");
  if (!rare) throw new Error("bingo fixture lacks required unlimited rare fallback");
  await playBingoPrize(page, request, fixture, rare.id);
  for (let index = 0; index < 9; index++) {
    const current = fixture.last.presentation.after;
    if (index !== lastIndex && !(current.markedMask & (1 << index))) await playBingoPrize(page, request, fixture, current.cells[index].id);
  }
  return fixture.last.presentation.after;
}

/** Register only with0061, after the independently verified0060 scratch gate. */
export async function bingoJourney(browser, { step, assert }, sink, ctx) {
  const page = await ctx.newPage(); attachSink(page, sink);
  await knownGameClientSeed(page);
  let original; let fixture; let final;
  try {
    await step("bingo: first credited play creates a personal card and immutable result", async () => {
      original = await gameFeatureSettings(ctx.request);
      await setGameFeatures(ctx.request, { ...original, bingo: true });
      assert((await gameCapabilities(ctx.request)).bingo === true, "bingo capability is server-controlled");
      fixture = await gameFixture(ctx.request, "bingo", "Bingo", 32);
      await privateLineReward(ctx.request, fixture);
      const first = await playBingoPrize(page, ctx.request, fixture, fixture.cellPrizes[0].id);
      assert(first.gameKind === "bingo" && first.presentation.newCard && first.presentation.after.cells.length === 9 && first.spinsRemaining === 31, "one real primary play creates nine cells and spends one credit");
      assert(new Set(first.presentation.after.cells.map(cell => cell.id)).size === 9, "personal card has nine distinct eligible prizes");
      const replay = await json(await ctx.request.post(BASE + "/api/spin", { data: fixture.lastBody }), "replay first bingo receipt");
      assert(replay.shareId === first.shareId && replay.spinsRemaining === first.spinsRemaining && JSON.stringify(replay.presentation) === JSON.stringify(first.presentation), "same-ID retry cannot recreate the card or spend again");
    });
    await step("bingo: repeats and outside-card prizes award wins without inventing marks", async () => {
      let card = fixture.last.presentation.after;
      if (!card.markedMask) await playBingoPrize(page, ctx.request, fixture, card.cells[0].id);
      card = fixture.last.presentation.after;
      const marked = card.cells.find((_,index) => card.markedMask & (1 << index));
      const repeated = await playBingoPrize(page, ctx.request, fixture, marked.id);
      assert(repeated.presentation.after.markedMask === card.markedMask && repeated.bonusWins.length === 0, "repeat awards its primary win but no new mark or bonus");
      assert(/already marked/.test(await page.getByTestId("bingo-announcement").innerText()), "repeat has honest accessible status copy");
      const outside = fixture.cellPrizes.find(prize => !card.cells.some(cell => cell.id === prize.id));
      assert(outside, "ten eligible prizes leave one genuine outside-card draw");
      const outsideWin = await playBingoPrize(page, ctx.request, fixture, outside.id);
      assert(outsideWin.presentation.markedIndex === null && outsideWin.presentation.after.markedMask === card.markedMask && outsideWin.bonusWins.length === 0, "outside prize wins without a fabricated square");
      assert(/outside your card/.test(await page.getByTestId("bingo-announcement").innerText()), "outside win is explained without a near-miss prompt");
      for (const width of [1440,390,360]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        assert(await page.getByRole("table", { name: "Three by three personal bingo card" }).count() === 1, "card is a labelled semantic table");
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "bingo card fits the viewport");
        await gameScreenshot(page, "bingo-card", width);
      }
    });
    await step("bingo: crossing lines receive every private bonus in one credited play", async () => {
      await readyBingoFinal(page, ctx.request, fixture);
      const before = await grantGameFocus(ctx.request, fixture);
      final = await playBingoPrize(page, ctx.request, fixture, fixture.finalPrizeId, { keepOpen: true });
      assert(final.presentation.after.markedMask === 511 && final.presentation.newLines.length >= 3 && final.bonusWins.length === final.presentation.newLines.length, "last crossing square earns each newly completed line exactly once");
      assert(final.spinsRemaining === before.spinsRemaining - 1 && final.focus.spinsLeft === 4, "multiple bonuses spend one primary credit and consume one focused spin");
      const items = page.getByTestId("bingo-bonus");
      assert(await items.count() === final.bonusWins.length, "all line rewards appear in the one shared win card");
      assert(await page.getByRole("dialog").count() === 1, "bonus rewards do not create nested dialogs");
      for (let index = 0; index < final.bonusWins.length; index++) assert((await items.nth(index).innerText()).includes(fixture.privateBonusValue), "each committed private line note is available to its winner");
      await gameScreenshot(page, "bingo-multiline-private", 360);
      const state = await json(await ctx.request.post(BASE + "/api/spin/status", { data: fixture.lastBody }), "reconcile multi-line result");
      assert(state.status === "committed" && JSON.stringify(state.result.bonusWins) === JSON.stringify(final.bonusWins), "status preserves every linked bonus receipt");
      await closeInstantCard(page);
      assert(await page.getByTestId("bingo-full-card").isVisible(), "full card remains visible after its reveal");
    });
    await step("bingo: private bonuses reopen and public proofs contain no private reward", async () => {
      const bonus = final.bonusWins[0];
      const history = await json(await ctx.request.post(BASE + "/api/fan/reward/history", { data: { token: fixture.token } }), "read full private bonus history");
      assert(final.bonusWins.every(win => history.wins.some(row => row.shareId === win.shareId)), "all line bonuses are independently reopenable from saved history");
      const reopened = await json(await ctx.request.post(BASE + "/api/fan/reward", { data: { token: fixture.token, shareId: bonus.shareId } }), "reopen line reward");
      assert(reopened.reward.value === fixture.privateBonusValue, "winner receives the immutable private bonus value");
      const other = await createGameFan(ctx.request, fixture, fixture.title + " other fan");
      const refused = await ctx.request.post(BASE + "/api/fan/reward", { data: { token: other.token, shareId: bonus.shareId } });
      assert(refused.status() === 404, "another fan cannot open the line reward");
      await assertProof(page, final, "bingo", assert);
      assert(!(await page.content()).includes(fixture.privateBonusValue), "primary public proof excludes all private bonus text");
      await goto(page, `/verify/${bonus.shareId}`, 250);
      assert(await page.locator(`a[href='/verify/${final.shareId}']`).count() > 0, "bonus proof links the primary committed seed stream");
      assert(!(await page.content()).includes(fixture.privateBonusValue), "bonus public proof excludes its private reward text");
    });
    await step("bingo: next paid play starts a new card and breaks retain it without prompting play", async () => {
      // A full card is replaced only by the next genuine paid attempt.
      const next = await playBingoPrize(page, ctx.request, fixture, fixture.cellPrizes.find(prize => prize.rarity === "rare").id);
      assert(next.presentation.newCard && next.presentation.before.markedMask === 511 && next.presentation.after.version === 1, "next credited play creates the new card after the full one");
      await json(await ctx.request.post(BASE + "/api/fan/break", { data: { token: fixture.token, duration: "24h" } }), "take bingo break");
      await openGame(page, fixture, true);
      assert(await page.getByTestId("fan-spin").isDisabled(), "break disables paid bingo");
      const refusal = await ctx.request.post(BASE + "/api/spin", { data: { token: fixture.token, requestId: randomUUID(), clientSeed: GAME_CLIENT_SEED } });
      assert(refusal.status() === 403 && (await refusal.json()).error === "on_break", "server also refuses a paid game during break");
      const marks = await page.getByTestId("bingo-cell").evaluateAll(cells => cells.map(cell => cell.dataset.marked));
      assert(JSON.stringify(marks) === JSON.stringify(next.presentation.after.cells.map((_,index) => String(!!(next.presentation.after.markedMask & (1 << index))))), "saved card remains readable during the break");
      await clearOwnedGameIntent(page, fixture.token);
    });
  } finally {
    await page.unroute("**/api/spin").catch(() => {});
    await goto(page, "/dashboard", 100);
    await cleanupGame(ctx.request, fixture);
    if (original) await setGameFeatures(ctx.request, original);
    await page.close();
  }
}
