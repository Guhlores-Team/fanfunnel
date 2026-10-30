// Real focus/chase economics plus browser transport faults. No outcome replacement.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { acknowledgeFixtureFan, BASE, goto, ensureArtifacts } from "./harness.mjs";
import { instantFixture, seedInstantCodes, closeInstantCard } from "./instant.mjs";

export const json = async (response, name) => {
  if (!response.ok()) throw new Error(`${name} failed (${response.status()})`);
  return response.json();
};
export const focusIntent = (token, seed = "focus-browser") => ({ token, requestId: randomUUID(), clientSeed: seed });
export const fanFocus = (request, token) => request.post(BASE + "/api/fan/focus", { data: { token } }).then(response => json(response, "read fan focus"));
export const savedIntents = page => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("ff-spin-intent-v1:")));
export async function enableFixtureChase(request, enabled) {
  await json(await request.post(BASE + "/api/debug/focus-fixture", { data: { chaseEnabled: enabled } }), "set demo chase rollout");
}
export async function focusFixture(request, name = "Focus", kind = "focus") {
  const fixture = await instantFixture(request, name, 2);
  fixture.packIds = [];
  fixture.kind = kind;
  try {
  const current = await json(await request.get(`${BASE}/api/wheels/${fixture.wheel.id}`), "load focus wheel");
  fixture.wheel = { ...current.wheel, prizes: current.wheel.prizes.map((prize, index) => ({ ...prize,
    boostable: index === 0, rarity: index === 2 ? "rare" : "common", weight: index === 0 ? 1 : 9, stock: null })) };
  fixture.wheel = (await json(await request.put(BASE + "/api/wheel", { data: { wheel: fixture.wheel } }), "save focus wheel")).wheel;
  fixture.target = fixture.wheel.prizes[0];
  if (kind === "chase") {
    await enableFixtureChase(request, true);
    await seedInstantCodes(request, fixture);
  }
  const pack = await json(await request.post(BASE + "/api/campaign-packs", { data: {
    label: `${fixture.title} ${kind}`, spins: 5, amountCents: 2000, bonusSpins: 0,
    packKind: kind, focusMultiplier: 3, focusSpins: 5, chaseWithin: 5,
  } }), "create focused pack");
  fixture.packIds.push(pack.pack.id);
  const creator = await json(await request.get(`${BASE}/api/fans/${fixture.fanId}/focus`), "load grant context");
  const pass = creator.passes.find(pass => pass.wheelId === fixture.wheel.id);
  if (!pass) throw new Error("fixture pass unavailable");
  fixture.passId = pass.id;
  fixture.granted = await json(await request.post(`${BASE}/api/fans/${fixture.fanId}/focus`, { data: {
    requestId: randomUUID(), packId: pack.pack.id, prizeId: fixture.target.id, passId: pass.id,
  } }), "grant focused pack");
  return fixture;
  } catch (error) {
    try { await cleanupFocus(request, fixture); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Focus fixture and cleanup failed"); }
    throw error;
  }
}
export async function editFocusTarget(request, fixture, patch) {
  const current = await json(await request.get(`${BASE}/api/wheels/${fixture.wheel.id}`), "read fixture target");
  const wheel = { ...current.wheel, prizes: current.wheel.prizes.map(prize => prize.id === fixture.target.id ? { ...prize, ...patch } : prize) };
  fixture.wheel = (await json(await request.put(BASE + "/api/wheel", { data: { wheel } }), "update fixture target")).wheel;
}
export async function cleanupFocus(request, fixture) {
  if (!fixture) return;
  await json(await request.delete(`${BASE}/api/fans/${fixture.fanId}`), "delete focus fan");
  for (const fanId of fixture.otherFans ?? []) await json(await request.delete(`${BASE}/api/fans/${fanId}`), "delete other fixture fan");
  for (const id of fixture.packIds ?? []) await json(await request.delete(`${BASE}/api/campaign-packs/${id}`), "delete focus pack");
  await json(await request.delete(`${BASE}/api/wheels/${fixture.wheel.id}`), "archive focus wheel");
  if (fixture.kind === "chase") await enableFixtureChase(request, false);
}
export async function openFocusFan(page, fixture) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await goto(page, `/spin/${fixture.token}`, 250);
  await page.getByTestId("fan-focus").waitFor({ timeout: 10000 });
  await page.getByTestId("fan-spin").waitFor({ timeout: 10000 });
}
export async function playFocus(page) {
  const wait = page.waitForResponse(response => response.url().endsWith("/api/spin") && response.request().method() === "POST");
  wait.catch(() => {});
  await page.getByTestId("fan-spin").click();
  const response = await wait;
  const result = await json(response, "play from fan page");
  await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
  return { result, body: response.request().postDataJSON() };
}
export async function readyChaseFinal(request, fixture) {
  // Eligibility was validated at grant; subsequent zero tickets cannot revoke a held guarantee.
  const current = await json(await request.get(`${BASE}/api/wheels/${fixture.wheel.id}`), "read guaranteed target");
  fixture.wheel = (await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...current.wheel,
    prizes: current.wheel.prizes.map(prize => ({ ...prize, weight: prize.id === fixture.target.id ? 0 : 9 })) } } }), "set neutral chase weights")).wheel;
  for (let count = 0; count < 4; count++) {
    const result = await json(await request.post(BASE + "/api/spin", { data: focusIntent(fixture.token, `chase-${count}`) }), "advance chase");
    if (result.chaseCompleted || result.prize.id === fixture.target.id) throw new Error("zero-ticket target won before its guarantee");
  }
  return fanFocus(request, fixture.token);
}

export async function focusJourney(page, { step, assert }, ctx) {
  let fixture;
  let chase;
  let breakFixture;
  let lostBody;
  let lostResult;
  let actualPosts = 0;
  try {
    await step("focus: server state and actual odds agree with the phone prize book", async () => {
      fixture = await focusFixture(ctx.request);
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await openFocusFan(page, fixture);
        const state = await fanFocus(ctx.request, fixture.token);
        assert(state.focus.spinsLeft === 5, "grant starts with five eligible focused spins");
        await page.getByRole("button", { name: /Prize book/ }).click();
        const target = page.locator(`[data-testid='prize-book-item'][data-prize-id='${fixture.target.id}']`);
        assert(await target.getAttribute("data-focus-target") === "true", "selected prize is labelled as a target");
        const chance = state.odds.rows.find(row => row.prizeId === fixture.target.id).chance;
        assert((await target.getByTestId("fan-prize-odds").innerText()).includes((chance * 100).toLocaleString("en-US", { maximumFractionDigits: 3 })), "displayed percentage is server-authoritative");
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}`);
        const dir = ensureArtifacts() + "focus/"; mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: `${dir}focus-${width}.png`, fullPage: true });
      }
    });
    await step("focus: sold-out target pauses without consuming purchased focused spins", async () => {
      await editFocusTarget(ctx.request, fixture, { stock: 0 });
      await openFocusFan(page, fixture);
      assert(/sold out/i.test(await page.getByTestId("fan-focus-paused").innerText()), "pause reason is explicit");
      const { result } = await playFocus(page);
      assert(result.focusConsumed === false && result.focus?.spinsLeft === 5, "ordinary prize does not consume paused focus");
      await closeInstantCard(page);
      await editFocusTarget(ctx.request, fixture, { stock: null });
      await openFocusFan(page, fixture);
      assert(await page.getByTestId("fan-focus").getAttribute("data-paused") === "false", "available target resumes");
    });
    await step("focus recovery: lost committed response preserves its exact request before POST", async () => {
      await page.route("**/api/spin", async route => {
        actualPosts++;
        lostBody = route.request().postDataJSON();
        const response = await route.fetch();
        lostResult = await json(response, "underlying committed play");
        await route.abort("aborted");
      });
      await page.getByTestId("fan-spin").click();
      await page.getByTestId("spin-recovery-controls").waitFor({ timeout: 10000 });
      const records = await savedIntents(page);
      assert(records.some(([key, value]) => !key.includes(fixture.token) && JSON.parse(value).requestId === lostBody.requestId), "request identity survives a lost response");
      assert(records.every(([key, value]) => !key.includes(fixture.token) && !value.includes(fixture.token) && !value.includes('"reward"')), "no bearer link or reward is in storage");
      assert(await page.getByTestId("fan-spin").isDisabled(), "unknown result prevents a fresh play");
      await page.unroute("**/api/spin");
    });
    await step("focus recovery: failed status plus reload never creates another request", async () => {
      await page.route("**/api/spin/status", route => route.abort("aborted"));
      await page.getByTestId("spin-recovery-check").click();
      await page.reload();
      await page.getByTestId("spin-recovery-controls").waitFor({ timeout: 10000 });
      assert(await page.getByTestId("fan-spin").isDisabled(), "reload retains unresolved request");
      assert(actualPosts === 1, "only one economic POST was sent");
      await page.unroute("**/api/spin/status");
      // A separate explicit API play changes live state before recovery of the older receipt.
      const later = await json(await ctx.request.post(BASE + "/api/spin", { data: focusIntent(fixture.token, "later-live-state") }), "later independent play");
      await page.getByTestId("spin-recovery-check").click();
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      const status = await json(await ctx.request.post(BASE + "/api/spin/status", { data: lostBody }), "read recovered play");
      assert(status.result.shareId === lostResult.shareId && status.result.prize.id === lostResult.prize.id, "recovery returns the original immutable win");
      assert(status.result.spinsRemaining === later.spinsRemaining && status.result.focus.spinsLeft === later.focus.spinsLeft, "current balance and focus replace stale receipt state");
      assert((await page.getByTestId("spins-chip").innerText()).includes(String(later.spinsRemaining)), "UI uses current balance");
      assert(await page.getByTestId("chase-complete").count() === 0, "replayed result creates no fresh chase celebration");
      await closeInstantCard(page);
      const replay = await json(await ctx.request.post(BASE + "/api/spin", { data: lostBody }), "same-id replay");
      assert(replay.shareId === lostResult.shareId && replay.spinsRemaining === later.spinsRemaining, "same-id replay neither rerolls nor debits");
    });
    await step("focus recovery: absent status only retries the same saved intent", async () => {
      let body;
      await page.route("**/api/spin", async route => { body = route.request().postDataJSON(); await route.abort("aborted"); });
      await page.getByTestId("fan-spin").click();
      await page.getByTestId("spin-recovery-controls").waitFor({ timeout: 8000 });
      await page.unroute("**/api/spin");
      await page.getByTestId("spin-recovery-check").click();
      await page.getByTestId("spin-recovery-status").filter({ hasText: /not been confirmed/ }).waitFor({ timeout: 8000 });
      assert(await page.getByTestId("fan-spin").isDisabled(), "absent does not unlock a new request");
      const wait = page.waitForResponse(response => response.url().endsWith("/api/spin") && response.request().method() === "POST");
      await page.getByTestId("spin-recovery-retry").focus(); await page.keyboard.press("Enter");
      const response = await wait;
      assert(JSON.stringify(response.request().postDataJSON()) === JSON.stringify(body), "retry keeps request ID, client seed and published hash exactly");
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      await closeInstantCard(page);
    });
    await step("focus recovery: unavailable storage refuses before sending any play", async () => {
      await page.evaluate(() => {
        window.__ffOriginalWrite = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("ff-spin-intent-v1:")) throw new DOMException("Storage unavailable", "QuotaExceededError");
          return window.__ffOriginalWrite.call(this, key, value);
        };
      });
      let sent = 0;
      const count = request => { if (request.url().endsWith("/api/spin")) sent++; };
      page.on("request", count);
      await page.getByTestId("fan-spin").click();
      await page.getByTestId("spin-storage-check").waitFor({ timeout: 8000 });
      assert(sent === 0 && await page.getByTestId("fan-spin").isDisabled(), "failed persistence spends nothing");
      page.off("request", count);
      await page.evaluate(() => { Storage.prototype.setItem = window.__ffOriginalWrite; delete window.__ffOriginalWrite; });
      await page.getByTestId("spin-storage-check").click();
    });
    await step("chase: reserved code is unavailable to others and guarantee completes at N", async () => {
      chase = await focusFixture(ctx.request, "Reserved chase", "chase");
      const other = await json(await ctx.request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: chase.name + " other", spins: 2, wheelId: chase.wheel.id } }), "create other code fan");
      chase.otherFans = [other.fanId];
      await json(await acknowledgeFixtureFan(ctx.request, other.token), "ack other code fan");
      const current = await json(await ctx.request.get(`${BASE}/api/wheels/${chase.wheel.id}`), "read shared code pool");
      await json(await ctx.request.put(BASE + "/api/wheel", { data: { wheel: { ...current.wheel,
        prizes: current.wheel.prizes.map(prize => ({ ...prize, weight: prize.id === chase.target.id ? 100 : 0 })) } } }), "choose shared code for competitor");
      const otherWin = await json(await ctx.request.post(BASE + "/api/spin", { data: focusIntent(other.token) }), "other fan takes free code");
      assert(otherWin.prize.id === chase.target.id && !!otherWin.reward?.value, "free code remains winnable");
      const emptyFree = await json(await ctx.request.post(BASE + "/api/spin", { data: focusIntent(other.token) }), "other fan cannot take held code");
      assert(emptyFree.prize.id !== chase.target.id, "held final code stays unavailable to other fan");
      chase.otherReward = otherWin.reward.value;
      await readyChaseFinal(ctx.request, chase);
      await openFocusFan(page, chase);
      assert(/within 1 eligible spin/.test(await page.getByTestId("fan-focus-progress").innerText()), "progress reaches the real final eligible spin");
      const { result } = await playFocus(page);
      assert(result.chaseCompleted === true && result.chaseAwarded === true && result.prize.id === chase.target.id, "guaranteed target wins exactly at N");
      assert(chase.codes.includes(result.reward?.value) && result.reward.value !== chase.otherReward, "winner receives its distinct concrete reserved code");
      await page.getByTestId("chase-complete").waitFor({ timeout: 5000 });
      assert(await page.getByTestId("reward-value").innerText() === result.reward.value, "instant reward remains available inside the shared reveal");
      assert((await savedIntents(page)).every(([, value]) => !value.includes(result.reward.value)), "delivered value never enters browser storage");
      await closeInstantCard(page);
      assert(await page.getByTestId("fan-focus").count() === 0, "completed chase stops promoting another play");
    });
    await step("focus recovery: a break stops same-intent retry and preserves progress", async () => {
      breakFixture = await focusFixture(ctx.request, "Break recovery");
      await openFocusFan(page, breakFixture);
      await page.route("**/api/spin", route => route.abort("aborted"));
      await page.getByTestId("fan-spin").click();
      await page.getByTestId("spin-recovery-controls").waitFor({ timeout: 8000 });
      await page.unroute("**/api/spin");
      await json(await ctx.request.post(BASE + "/api/fan/break", { data: { token: breakFixture.token, duration: "24h" } }), "take break on pending request");
      await page.reload();
      await page.getByTestId("spin-recovery-controls").waitFor({ timeout: 8000 });
      assert(await page.getByTestId("spin-recovery-retry").isDisabled(), "same-intent resubmission is disabled during break");
      assert(await page.getByTestId("fan-spin").isDisabled(), "fresh spin is disabled during break");
      assert(/progress is kept/.test(await page.getByTestId("fan-focus-paused").innerText()), "pack progress is kept without play prompt");
    });
  } finally {
    await page.unroute("**/api/spin").catch(() => {});
    await page.unroute("**/api/spin/status").catch(() => {});
    await page.evaluate(() => { if (window.__ffOriginalWrite) { Storage.prototype.setItem = window.__ffOriginalWrite; delete window.__ffOriginalWrite; } }).catch(() => {});
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: null });
    await goto(page, "/dashboard", 100);
    await cleanupFocus(ctx.request, breakFixture);
    await cleanupFocus(ctx.request, chase);
    await cleanupFocus(ctx.request, fixture);
    for (const owned of [fixture, chase, breakFixture].filter(Boolean)) await page.evaluate(async token => {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const key = "ff-spin-intent-v1:" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
      localStorage.removeItem(key);
    }, owned.token);
  }
}
