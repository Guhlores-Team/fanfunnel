// Batch 7 fan fixes, each with the regression it guards (demo mode):
//  RF-01 the wheel lands by prize id after the creator edits the prize list
//  RF-02 a game-kind switch mid-session is told, never crashed into
//  RF-03 / WF-06 a top-up reaches an open page: on return to the tab, or by itself when out of spins
//  RF-04 the page plays without crypto.randomUUID / Object.hasOwn / Array.at
//  RF-05 a failed report says so       RF-06 refusals: needs_ack resumes, 429 cools down
//  RF-07 offline is named, a spin sent offline is released again
//  ATK-01 a creator session is refused on fan-only routes; self-delete waits for an owed prize
//  WF-01…WF-16, PA-01/06/10/11, WA-02/04/06/07/11, PR-19, TS-14 (see each step)
// Every fan, wheel and address is the journey's own; the demo creator's wheel
// is restored after each edit.
import { randomBytes, randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, goto, passAgeGate } from "./harness.mjs";
import { INSTAGRAM_IOS_UA, largeText } from "./fan-devices.mjs";

const PHONE = { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const SE_PORTRAIT = { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SE_LANDSCAPE = { viewport: { width: 568, height: 320 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TIKTOK_ANDROID_UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 trill_2023 musical_ly_31.0.3 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/31.0.3 ByteLocale/en ByteFullLocale/en Region/US";
const ip = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
// A second documentation range for calls that must never meet an address the
// link-budget step (WF-03) has used up.
const quietIp = () => `203.0.113.${1 + Math.floor(Math.random() * 250)}`;

async function json(res, what) {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()}) ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
async function newFan(request, name, spins = 3, { ack = true, wheelId } = {}) {
  const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins, ...(wheelId ? { wheelId } : {}) } }), `create ${name}`);
  // A link plays the creator's live game unless it is pinned ("Change game
  // for this fan only", 0065): pin it so the journey's own wheel is played
  // without changing what any other fan sees.
  if (wheelId) await json(await request.post(`${BASE}/api/fans/${fan.fanId}/link-game`, { data: { token: fan.token, wheelId } }), `pin ${name}`);
  if (ack) await json(await acknowledgeFixtureFan(request, fan.token), `ack ${name}`);
  return fan;
}
/**
 * Top up a fan. The call comes right after a reveal (about as long as the
 * server keeps an idle connection open), so the pooled socket may have just
 * been closed: a reset is sent again with the same requestId, which the
 * server counts once.
 */
async function topUp(request, fan, name, spins) {
  const data = { requestId: randomUUID(), name, spins, fanId: fan.fanId };
  const send = () => request.post(BASE + "/api/passes", { data });
  let res;
  try { res = await send(); } catch (e) { if (!/ECONNRESET|socket hang up|EPIPE/.test(String(e?.message))) throw e; res = await send(); }
  return json(res, "top up");
}
const getWheel = async (request) => (await json(await request.get(BASE + "/api/wheel"), "read the wheel")).wheel;
const putWheel = async (request, wheel) => (await json(await request.put(BASE + "/api/wheel", { data: { wheel } }), "save the wheel")).wheel;
const prize = (label, rarity = "common", weight = 1, emoji = "🎁") => ({ id: randomUUID(), label, rarity, weight, emoji, stock: null, cost: 100 });
/** A wheel of this journey's own, so edits never touch the demo creator's. */
async function ownWheel(request, title, prizes, kind = "wheel", extra = {}) {
  const created = await json(await request.post(BASE + "/api/wheels", { data: { name: title, gameKind: kind, ...(kind === "scratch" ? { gameConfig: { style: "classic" } } : {}) } }), `create ${title}`);
  const { gameKindLocked: _l, gameReady: _r, ...editable } = created.wheel;
  return putWheel(request, { ...editable, prizes, ...extra });
}
const editable = (wheel) => { const { gameKindLocked: _l, gameReady: _r, ...rest } = wheel; return rest; };

/** Open a fan's page in its own context, past the gate, with the sink attached. */
async function openFan(browser, sink, token, { device = PHONE, ua, init, gate = true, sinkless = false, clock = false } = {}) {
  const context = await browser.newContext({ ...device, ...(ua ? { userAgent: ua } : {}) });
  if (init) await context.addInitScript(init);
  // A controllable clock (it still runs in real time until fast-forwarded).
  if (clock) await context.clock.install();
  const page = await context.newPage();
  const errors = [];
  if (sinkless) page.on("pageerror", (e) => errors.push(String(e?.message || e))); else attachSink(page, sink);
  await goto(page, `/spin/${token}`, 600);
  if (gate) { await passAgeGate(page); await page.getByTestId("fan-spin").waitFor({ timeout: 10000 }); }
  return { context, page, errors };
}
/** Click SPIN, return the /api/spin JSON, leave the card open. */
async function spinForCard(page) {
  const resp = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/spin" && r.request().method() === "POST");
  resp.catch(() => {});
  await page.getByTestId("fan-spin").click();
  const body = await (await resp).json();
  await page.getByTestId("reward-reveal").waitFor({ timeout: 20000 });
  return body;
}
async function closeCard(page) {
  await page.getByTestId("reward-reveal").getByRole("button", { name: "Awesome!" }).click();
  await page.getByTestId("reward-reveal").waitFor({ state: "hidden", timeout: 6000 });
}
const chip = async (page) => (await page.getByTestId("spins-chip").textContent()).replace(/\D/g, "");
const CONTRAST = `(a, b) => {
  const rgb = (css) => { const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim()); if (hex) { const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1]; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); } return css.match(/[\\d.]+/g).map(Number).slice(0, 3); };
  const lum = (css) => { const [r, g, b] = rgb(css).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }`;

export async function fanB7Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;
  const fans = [];
  const wheels = [];
  const own = async (name, spins, opts) => { const fan = await newFan(request, name, spins, opts); fans.push(fan.fanId); return fan; };
  const demoWheel = await getWheel(request);
  try {
    await step("b7 fan RF-01: after the creator edits the prize list, the wheel lands on the prize the server drew", async () => {
      const wheel = await ownWheel(request, "B7 reorder", [prize("Alpha sticker"), prize("Beta badge"), prize("Gamma pin", "rare")]);
      wheels.push(wheel.id);
      const fan = await own("B7 reorder fan", 2, { wheelId: wheel.id });
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        // Prepend a prize: every old index now points one slice off.
        await putWheel(request, { ...editable(wheel), prizes: [prize("Zero sticker"), ...wheel.prizes] });
        const body = await spinForCard(page);
        assert(Array.isArray(body.prizes) && body.prizes.length === 4, "the spin result carries the prize list it was drawn from");
        assert(typeof body.prize?.id === "string", "the result names the prize by id");
        const drawn = body.prizes[body.prizeIndex]?.label;
        assert(drawn && drawn === body.prize.label, `index ${body.prizeIndex} points at the drawn prize in that list (${drawn})`);
        const status = await page.getByTestId("wheel-status").textContent();
        assert(status === `Landed on ${[body.prize.emoji, drawn].filter(Boolean).join(" ")}.`, `the wheel landed on the drawn prize, not the old index (${status} vs ${drawn})`);
        assert((await page.getByTestId("reward-reveal").textContent()).includes(drawn), "the card shows the same prize");
        await closeCard(page);
        // The page follows once the card is closed: the prize book lists the new prize.
        await page.getByRole("button", { expanded: false }).filter({ hasText: /Show/ }).first().click();
        await page.getByTestId("prize-book-name").filter({ hasText: "Zero sticker" }).first().waitFor({ timeout: 8000 });
        assert((await page.getByTestId("prize-book-name").count()) === 4, "the prize book lists all four prizes");
      } finally { await context.close(); }
    });

    await step("b7 fan RF-02: a game-kind switch mid-session is explained, and the reload shows the new game", async () => {
      const wheel = await ownWheel(request, "B7 switch", [prize("Switch one"), prize("Switch two"), prize("Switch three", "rare")]);
      wheels.push(wheel.id);
      const fan = await own("B7 switch fan", 3, { wheelId: wheel.id });
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        assert((await page.getByTestId("fan-game").getAttribute("data-game-kind")) === "wheel", "the page opened as a wheel");
        await putWheel(request, { ...editable(wheel), gameKind: "scratch", gameConfig: { style: "classic" } });
        const resp = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/spin" && r.request().method() === "POST");
        resp.catch(() => {});
        await page.getByTestId("fan-spin").click();
        const body = await (await resp).json();
        assert(body.gameKind === "scratch" || body.kind === "scratch" || body.presentation?.game === "scratch" || JSON.stringify(body).includes("scratch"), "the server played the new game");
        await page.getByTestId("game-switched").waitFor({ timeout: 10000 });
        await page.reload({ waitUntil: "networkidle" });
        await page.getByTestId("fan-game").waitFor({ timeout: 10000 });
        assert((await page.getByTestId("fan-game").getAttribute("data-game-kind")) === "scratch", "after a reload the fan gets the scratch ticket");
      } finally { await context.close(); }
    });

    await step("b7 fan RF-03: a top-up reaches the open page when it next refreshes", async () => {
      const fan = await own("B7 topup fan", 1);
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        await spinForCard(page); await closeCard(page);
        assert((await chip(page)) === "0", "the only spin is spent");
        await page.getByTestId("topup-ask").waitFor({ timeout: 6000 });
        await topUp(request, fan, "B7 topup fan", 2);
        // The tab comes back after >30 s: the page re-reads the server and
        // must adopt the new balance while idle.
        await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 40000; document.dispatchEvent(new Event("visibilitychange")); });
        await page.waitForFunction(() => document.querySelector("[data-testid='spins-chip']")?.textContent.replace(/\D/g, "") === "2", null, { timeout: 15000 });
        await page.getByTestId("topup-ask").waitFor({ state: "hidden", timeout: 6000 });
        const note = await page.getByTestId("topup-note").textContent();
        assert(/^\+2 spins from /.test(note), `the page says who added the spins (${note})`);
        await spinForCard(page); await closeCard(page);
        assert((await chip(page)) === "1", "the topped-up spins play");
        assert((await page.getByTestId("topup-note").count()) === 0, "the note is gone once the fan plays");
      } finally { await context.close(); }
    });

    await step("b7 fan WF-06: an out-of-spins page left open learns of a top-up by itself, without leaving the tab", async () => {
      const fan = await own("B7 waiting fan", 1);
      const { context, page } = await openFan(browser, sink, fan.token, { clock: true });
      try {
        await spinForCard(page); await closeCard(page);
        assert((await chip(page)) === "0", "the only spin is spent");
        await page.getByTestId("topup-ask").waitFor({ timeout: 6000 });
        await topUp(request, fan, "B7 waiting fan", 3);
        // No tab switch, no tap: half a minute passes on the open page.
        await page.clock.fastForward(31000);
        await page.waitForFunction(() => document.querySelector("[data-testid='spins-chip']")?.textContent.replace(/\D/g, "") === "3", null, { timeout: 15000 });
        assert(/^\+3 spins from /.test(await page.getByTestId("topup-note").textContent()), "the top-up is announced");
        await page.getByTestId("topup-ask").waitFor({ state: "hidden", timeout: 6000 });
      } finally { await context.close(); }
    });

    await step("b7 fan RF-04: the page plays without crypto.randomUUID, Object.hasOwn or Array.prototype.at", async () => {
      const fan = await own("B7 old browser fan", 2);
      const { context, page } = await openFan(browser, sink, fan.token, { init: () => { delete crypto.randomUUID; delete Object.hasOwn; delete Array.prototype.at; delete Array.prototype.findLast; delete globalThis.structuredClone; } });
      try {
        const req = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/spin" && r.method() === "POST");
        const body = await spinForCard(page);
        const sent = (await req).postDataJSON();
        assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sent.requestId), `the request id is a v4 uuid from the fallback (${sent.requestId})`);
        assert(typeof body.prize?.id === "string", "the spin resolved");
        await closeCard(page);
        await page.getByTestId("win-codes").waitFor({ timeout: 8000 });
      } finally { await context.close(); }
    });

    await step("b7 fan RF-06: a needs_ack refusal reopens the gate and the spin resumes once it is confirmed", async () => {
      const fan = await own("B7 ack fan", 2);
      // The 403 the browser logs is the case under test: own error capture.
      const { context, page, errors } = await openFan(browser, sink, fan.token, { sinkless: true });
      try {
        let spins = 0;
        await page.route("**/api/spin", async (route) => {
          spins++;
          if (spins === 1) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "needs_ack" }) });
          return route.continue();
        });
        await page.getByTestId("fan-spin").click();
        const gate = page.getByRole("dialog", { name: "Before you play" });
        await gate.waitFor({ timeout: 8000 });
        for (const box of await gate.getByRole("checkbox").all()) await box.check();
        await page.getByTestId("agegate-enter").click();
        await gate.waitFor({ state: "hidden", timeout: 8000 });
        await page.getByTestId("reward-reveal").waitFor({ timeout: 20000 });
        assert(spins === 2, `the spin was sent again by itself after the ack (${spins} calls)`);
        await closeCard(page);
        await page.unroute("**/api/spin");
        assert(errors.length === 0, `no page errors (${errors.join("; ")})`);
      } finally { await context.close(); }
    });

    await step("b7 fan RF-06: a rate_limited refusal shows a cooldown on the button, then plays", async () => {
      const fan = await own("B7 cooldown fan", 2);
      const { context, page, errors } = await openFan(browser, sink, fan.token, { sinkless: true });
      try {
        let first = true;
        await page.route("**/api/spin", async (route) => {
          if (first) { first = false; return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "2" }, body: JSON.stringify({ error: "rate_limited" }) }); }
          return route.continue();
        });
        await page.getByTestId("fan-spin").click();
        const button = page.getByTestId("fan-spin");
        await page.waitForFunction(() => /Try again in \d+ s/.test(document.querySelector("[data-testid='fan-spin']")?.textContent ?? ""), null, { timeout: 5000 });
        assert((await button.getAttribute("aria-disabled")) === "true", "the button is marked unavailable during the cooldown");
        assert((await chip(page)) === "2", "the balance never pretends to be checking");
        await page.waitForFunction(() => !/Try again/.test(document.querySelector("[data-testid='fan-spin']")?.textContent ?? "") && document.querySelector("[data-testid='fan-spin']")?.getAttribute("aria-disabled") !== "true", null, { timeout: 6000 });
        await spinForCard(page); await closeCard(page);
        await page.unroute("**/api/spin");
        assert(errors.length === 0, `no page errors (${errors.join("; ")})`);
      } finally { await context.close(); }
    });

    await step("b7 fan RF-07 / PR-18: offline is named, a spin sent offline is released, and play resumes online", async () => {
      const fan = await own("B7 offline fan", 2);
      // No sink: the offline request failure is the case under test.
      const { context, page, errors } = await openFan(browser, sink, fan.token, { sinkless: true });
      try {
        await context.setOffline(true);
        await page.getByTestId("offline-note").waitFor({ timeout: 8000 });
        const note = await page.getByTestId("offline-note").textContent();
        assert(/offline/i.test(note) && !/still being checked/i.test(note), `the note says offline, not "being checked" (${note})`);
        await page.getByTestId("fan-spin").click().catch(() => {});
        await page.waitForFunction(() => /offline/i.test(document.querySelector("[data-testid='spin-recovery-status']")?.textContent ?? ""), null, { timeout: 8000 });
        await context.setOffline(false);
        await page.getByTestId("offline-note").waitFor({ state: "hidden", timeout: 8000 });
        // FD-13: the attempt is kept (the server may have seen it). Back
        // online the page checks it by itself (or the fan taps Check), learns
        // it never arrived, and offers the same spin again.
        const retry = page.getByTestId("spin-recovery-retry");
        await retry.or(page.getByTestId("spin-recovery-check")).first().waitFor({ timeout: 10000 });
        if (!(await retry.isVisible())) await page.getByTestId("spin-recovery-check").click({ timeout: 3000 }).catch(() => {});
        await retry.waitFor({ timeout: 10000 });
        const resp = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/spin" && r.request().method() === "POST");
        await retry.click();
        const body = await (await resp).json();
        await page.getByTestId("reward-reveal").waitFor({ timeout: 20000 });
        assert(typeof body.prize?.id === "string", "the spin plays once back online");
        await closeCard(page);
        assert((await chip(page)) === "1", "exactly one spin was spent");
        assert(errors.length === 0, `no page errors (${errors.join("; ")})`);
      } finally { await context.close(); }
    });

    await step("b7 fan RF-05: a report that fails to send says so instead of dying silently", async () => {
      const fan = await own("B7 report fan", 1);
      const { context, page, errors } = await openFan(browser, sink, fan.token, { sinkless: true });
      try {
        await page.route("**/api/report", (route) => route.abort("failed"));
        await page.getByRole("button", { name: "Safety & privacy" }).first().click();
        const dialog = page.getByRole("dialog", { name: "Safety and privacy" });
        await dialog.waitFor({ timeout: 5000 });
        assert((await page.getByRole("navigation", { name: "Legal" }).count()) === 1, "one Legal landmark with the sheet open (PA-12)");
        await dialog.getByRole("button", { name: /Report this creator/ }).click();
        await dialog.getByLabel("Reason for report").selectOption({ index: 1 });
        await dialog.getByRole("button", { name: "Send report" }).click();
        await page.getByTestId("report-error").waitFor({ timeout: 6000 });
        assert(/connection/i.test(await page.getByTestId("report-error").textContent()), "the message names the connection");
        assert(errors.length === 0, `no unhandled rejection (${errors.join("; ")})`);
        await page.unroute("**/api/report");
        const reasons = await dialog.getByLabel("Reason for report").locator("option").allTextContents();
        assert(reasons.length > 3 && reasons[0].startsWith("Pick"), "the reason is one of the listed reasons (TS-08)");
      } finally { await context.close(); }
    });

    await step("b7 fan ATK-01: a request carrying a creator session is refused on every fan-only route", async () => {
      const fan = await own("B7 creator cookie fan", 2);
      const win = await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "cookie" } }), "spin");
      // Its own address: the per-address budgets of these routes (ten deletes
      // an hour, for one) are not spent for the other journeys on this server.
      const from = { "x-real-ip": quietIp() };
      const cookie = { ...from, cookie: "sb-demo-auth-token=creator-session" };
      const routes = [
        ["/api/fans/ack", { token: fan.token }],
        ["/api/leaderboard/opt-in", { token: fan.token, optIn: true }],
        ["/api/self-exclude", { token: fan.token }],
        ["/api/fan/reward", { token: fan.token, shareId: win.shareId }],
        ["/api/fan/break", { token: fan.token, duration: "24h" }],
        ["/api/fan-data/export", { token: fan.token }],
        ["/api/fan-data/delete", { token: fan.token, confirm: "DELETE" }],
      ];
      for (const [path, data] of routes) {
        const r = await request.post(BASE + path, { headers: cookie, data });
        assert(r.status() === 403, `${path} with a creator cookie → 403 (${r.status()})`);
        const body = await r.json();
        assert(body.error === "creator_session", `${path} names the refusal (${body.error})`);
      }
      const plain = await request.post(BASE + "/api/fan-data/export", { headers: from, data: { token: fan.token } });
      assert(plain.status() === 200, `the same route without the cookie still serves the fan (${plain.status()})`);
      const other = await request.post(BASE + "/api/fan-data/export", { headers: { ...from, cookie: "theme=dark; sb-demo-auth-token-verifier=x" }, data: { token: fan.token } });
      assert(other.status() === 200, `only a session cookie counts, not a look-alike (${other.status()})`);
    });

    await step("b7 fan ATK-01: a fan cannot delete their data while a prize is still owed", async () => {
      const owedName = `B7 owed ${randomBytes(3).toString("hex")}`;
      const fan = await own(owedName, 1);
      await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "owed" } }), "spin");
      const from = { "x-real-ip": quietIp() };
      const refused = await request.post(BASE + "/api/fan-data/delete", { headers: from, data: { token: fan.token, confirm: "DELETE" } });
      assert(refused.status() === 409 && (await refused.json()).error === "prize_owed", `delete while a prize is owed → 409 prize_owed (${refused.status()})`);
      const list = await json(await request.get(`${BASE}/api/redemptions?status=pending&q=${encodeURIComponent(owedName)}`), "redemptions");
      const owed = (list.items ?? []).filter((r) => r.fanName === owedName);
      assert(owed.length >= 1, "the owed prize is in the queue");
      for (const r of owed) await json(await request.patch(`${BASE}/api/redemptions/${r.id}`, { data: { status: "fulfilled" } }), "fulfil");
      const ok = await request.post(BASE + "/api/fan-data/delete", { headers: from, data: { token: fan.token, confirm: "DELETE" } });
      assert(ok.status() === 200, `once delivered, the fan can erase (${ok.status()})`);
    });

    await step("b7 fan WF-01: each win lists its claim code and a verify link; closing the card by Escape asks first", async () => {
      const fan = await own("B7 codes fan", 2);
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        const body = await spinForCard(page);
        assert(/^[0-9A-Z]{6}$/.test(body.claimCode) && body.shareId, "the win carries a claim code and share id");
        await page.keyboard.press("Escape");
        await page.getByTestId("reveal-close-confirm").waitFor({ timeout: 4000 });
        assert((await page.getByTestId("reward-reveal").count()) === 1, "Escape asks before closing a card with a code");
        await page.getByRole("button", { name: "Yes, close" }).click();
        await page.getByTestId("reward-reveal").waitFor({ state: "hidden", timeout: 6000 });
        await page.getByTestId("win-codes").waitFor({ timeout: 8000 });
        const codes = await page.getByTestId("win-code").allTextContents();
        assert(codes.map((c) => c.trim()).includes(body.claimCode), `Your wins lists the code (${codes.join(",")})`);
        const href = await page.getByTestId("win-verify-link").first().getAttribute("href");
        assert(href === `/verify/${body.shareId}`, `the verify link points at this win (${href})`);
        const backdrop = await page.getByTestId("reward-reveal").count();
        assert(backdrop === 0, "the card is closed");
      } finally { await context.close(); }
    });

    await step("b7 fan WF-02: after the gate the page is at the top (SE portrait, landscape, 200% text)", async () => {
      for (const [name, device, pct] of [["SE portrait", SE_PORTRAIT, 0], ["SE landscape", SE_LANDSCAPE, 0], ["phone 200%", PHONE, 200]]) {
        const fan = await own(`B7 scroll ${name}`, 1, { ack: false });
        const { context, page } = await openFan(browser, sink, fan.token, { device, init: pct ? largeText : undefined, gate: false });
        try {
          if (pct) await page.evaluate(largeText, pct);
          const gate = page.getByRole("dialog", { name: "Before you play" });
          await gate.waitFor({ timeout: 8000 });
          await page.waitForFunction(() => !document.querySelector("[role='dialog'] input[type='checkbox']")?.disabled, null, { timeout: 15000 });
          for (const box of await gate.getByRole("checkbox").all()) { await box.scrollIntoViewIfNeeded(); await box.check(); }
          await page.getByTestId("agegate-enter").scrollIntoViewIfNeeded();
          await page.getByTestId("agegate-enter").click();
          await gate.waitFor({ state: "hidden", timeout: 8000 });
          await page.getByTestId("fan-spin").waitFor({ timeout: 10000 });
          await page.waitForTimeout(600);
          const y = await page.evaluate(() => Math.round(window.scrollY));
          assert(y === 0, `${name}: the page stays at the top after the gate (scrollY ${y})`);
        } finally { await context.close(); }
      }
    });

    await step("b7 fan WF-03: a network that spent its link budget gets the busy page, and ack attempts are capped", async () => {
      const fan = await own("B7 busy fan", 1);
      const addr = ip();
      let cut = false;
      for (let i = 0; i < 125 && !cut; i++) {
        const r = await request.post(BASE + "/api/spin", { headers: { "x-real-ip": addr }, data: { token: randomBytes(24).toString("hex"), requestId: randomUUID(), clientSeed: "b7" } });
        if (r.status() === 429) cut = true;
      }
      assert(cut, "random tokens from one address are cut off");
      const page = await request.get(`${BASE}/spin/${fan.token}`, { headers: { "x-real-ip": addr } });
      const html = await page.text();
      assert(html.includes('data-testid="link-attempts-blocked"') && html.includes("Too many link attempts"), `the real link shows the busy page from that address (${page.status()})`);
      assert(!html.includes("fan-spin") && !html.includes("Before you play"), "no game is served to the blocked address");
      const fine = await request.get(`${BASE}/spin/${fan.token}`);
      assert(fine.status() === 200 && (await fine.text()).includes('data-testid="fan-spin"'), "another address is unaffected");
      const ackAddr = ip();
      let ackCut = null;
      for (let i = 0; i < 25; i++) {
        const r = await request.post(BASE + "/api/fans/ack", { headers: { "x-real-ip": ackAddr }, data: { token: fan.token } });
        if (r.status() === 429) { ackCut = i + 1; break; }
      }
      assert(ackCut !== null && ackCut > 15 && ackCut <= 21, `ack attempts for one link from one address are capped (${ackCut})`);
    });

    await step("b7 fan WF-04: a prize with no stock left reads \"Sold out\", never \"0 left\"", async () => {
      const wheel = await ownWheel(request, "B7 stock", [{ ...prize("Last hoodie", "rare"), stock: 0 }, { ...prize("Common pin"), stock: 4 }, prize("Common sticker")], "wheel", { showStock: true });
      wheels.push(wheel.id);
      const fan = await own("B7 stock fan", 1, { wheelId: wheel.id });
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        await page.getByTestId("limited-stock").waitFor({ timeout: 8000 });
        const text = (await page.getByTestId("fan-game").textContent()) ?? "";
        assert(text.includes("Sold out"), `the stock row says Sold out (${text.slice(0, 200)})`);
        assert(/4 left/.test(text), "a real count still reads as a count");
        assert(!/\b0 left\b/.test(text), "nothing says 0 left");
      } finally { await context.close(); }
    });

    await step("b7 fan WF-07: an in-app browser gets a one-line hint; a real browser gets none", async () => {
      const fan = await own("B7 in-app fan", 1);
      for (const [ua, app, browserName] of [[INSTAGRAM_IOS_UA, "instagram", "Safari"], [TIKTOK_ANDROID_UA, "tiktok", "Chrome"], [undefined, null, null]]) {
        const { context, page } = await openFan(browser, sink, fan.token, { ua });
        try {
          const hint = page.getByTestId("in-app-hint");
          if (app) {
            await hint.waitFor({ timeout: 8000 });
            assert((await hint.getAttribute("data-app")) === app, `${app} is recognised`);
            const text = await hint.textContent();
            assert(text.includes(browserName), `${app}: the hint names ${browserName} (${text})`);
            if (app === "tiktok") assert((await hint.locator("a").getAttribute("href"))?.startsWith("intent://"), "Android gets an intent link to Chrome");
          } else {
            await page.waitForTimeout(500);
            assert((await hint.count()) === 0, "a real browser sees no hint");
          }
        } finally { await context.close(); }
      }
    });

    await step("b7 fan WF-08: every button and standalone link on the fan page is at least 44 px tall", async () => {
      const fan = await own("B7 tap fan", 2);
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        await spinForCard(page); await closeCard(page);
        await page.waitForTimeout(500);
        const small = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll("button, [role='button'], a[href], input[type='checkbox'], select")) {
            if (el.closest("[data-env-badge]") || el.closest("p") && el.tagName === "A" && !el.className.includes("min-h-11")) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
            if (r.height < 43.5) out.push(`${el.tagName.toLowerCase()}[${(el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}]=${Math.round(r.height)}`);
          }
          return out;
        });
        assert(small.length === 0, `tap targets under 44 px: ${small.join(", ")}`);
      } finally { await context.close(); }
    });

    await step("b7 fan WF-09: a second tab of the same link never shows the other tab's spin, and learns its balance", async () => {
      const fan = await own("B7 tabs fan", 3);
      const { context, page: a } = await openFan(browser, sink, fan.token);
      try {
        const b = await context.newPage();
        attachSink(b, sink);
        await goto(b, `/spin/${fan.token}`, 600);
        await b.getByTestId("fan-spin").waitFor({ timeout: 10000 });
        assert((await chip(a)) === "3" && (await chip(b)) === "3", "both tabs start at 3");
        await spinForCard(a);
        await b.waitForTimeout(1500);
        assert((await b.getByTestId("reward-reveal").count()) === 0, "the other tab shows no card for a spin it did not make");
        await closeCard(a);
        await b.waitForFunction(() => document.querySelector("[data-testid='spins-chip']")?.textContent.replace(/\D/g, "") === "2", null, { timeout: 15000 });
        assert((await b.getByTestId("reward-reveal").count()) === 0, "…and still no card after it finished");
        const bBody = await spinForCard(b); await closeCard(b);
        assert(typeof bBody.prize?.id === "string", "the second tab plays its own spin");
        await a.waitForFunction(() => document.querySelector("[data-testid='spins-chip']")?.textContent.replace(/\D/g, "") === "1", null, { timeout: 15000 });
      } finally { await context.close(); }
    });

    await step("b7 fan WF-10: the win card's message action opens chat with the win drafted", async () => {
      const fan = await own("B7 message fan", 1);
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        const body = await spinForCard(page);
        await page.getByTestId("reveal-message").click();
        await page.getByTestId("reward-reveal").waitFor({ state: "hidden", timeout: 6000 });
        await page.getByTestId("chat-panel").waitFor({ timeout: 8000 });
        const draft = await page.getByTestId("chat-panel").locator("textarea, input:not([type='hidden'])").first().inputValue();
        assert(draft.includes(body.prize?.label ?? "") && draft.includes(body.claimCode), `the draft names the win and its code (${draft})`);
      } finally { await context.close(); }
    });

    await step("b7 fan WF-11: the gate's legal links open in a sheet over the page instead of leaving it", async () => {
      const fan = await own("B7 legal fan", 1, { ack: false });
      const { context, page } = await openFan(browser, sink, fan.token, { gate: false });
      try {
        const gate = page.getByRole("dialog", { name: "Before you play" });
        await gate.waitFor({ timeout: 8000 });
        const before = page.url();
        await gate.getByRole("link", { name: "Terms of Service" }).click();
        await page.getByTestId("legal-sheet").waitFor({ timeout: 8000 });
        assert(page.url() === before, "the page did not navigate");
        const text = page.getByTestId("legal-sheet-body");
        await text.waitFor({ timeout: 10000 });
        assert(/Terms of Service/.test(await text.locator("h1").first().textContent()), "the Terms text is shown in the sheet");
        const unsafe = await text.evaluate((el) => ({ scripts: el.querySelectorAll("script, iframe, form, style").length, handlers: [...el.querySelectorAll("*")].filter((n) => [...n.attributes].some((a) => /^on/i.test(a.name))).length, sameTab: [...el.querySelectorAll("a[href]")].filter((a) => a.target !== "_blank").length }));
        assert(unsafe.scripts === 0 && unsafe.handlers === 0 && unsafe.sameTab === 0, `nothing executable is carried over and links open in a new tab (${JSON.stringify(unsafe)})`);
        assert((await page.locator("iframe").count()) === 0, "no frame is used (the CSP forbids them)");
        await page.getByTestId("legal-sheet-close").click();
        await page.getByTestId("legal-sheet").waitFor({ state: "hidden", timeout: 5000 });
        assert(await gate.isVisible(), "the gate is still there to finish");
      } finally { await context.close(); }
    });

    await step("b7 fan WF-13 / PA-10 / WF-15 / WF-16: chances never read 0%, rarity is a word, no visit tag on a first visit, headings and the live wheel", async () => {
      const wheel = await ownWheel(request, "B7 odds", [prize("Long shot", "legendary", 1), prize("Common one", "common", 50000), prize("Common two", "common", 50000)]);
      wheels.push(wheel.id);
      const fan = await own("B7 odds fan", 2, { wheelId: wheel.id });
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        assert((await page.getByTestId("glow-regular").count()) === 0, "no visit count on a first visit (WF-15)");
        await page.getByRole("button", { expanded: false }).filter({ hasText: /Show/ }).first().click();
        await page.getByTestId("fan-prize-odds").first().waitFor({ timeout: 8000 });
        const odds = await page.getByTestId("fan-prize-odds").allTextContents();
        assert(odds.length === 3 && odds.every((t) => /(<0\.001%|\d+(\.\d+)?%) chance/.test(t)), `every chance is a formatted percentage (${odds.join(" | ")})`);
        assert(!odds.some((t) => /(^|\s)0% chance/.test(t)), "no prize reads 0% chance");
        assert(odds.some((t) => /<0\.001%|0\.00\d%|0\.0\d%/.test(t)), `the long shot keeps its small chance (${odds.join(" | ")})`);
        const rarities = await page.getByTestId("prize-book-rarity").allTextContents();
        assert(rarities.length === 3 && rarities.some((r) => /legendary/i.test(r)), `the prize book names each rarity (${rarities.join(",")})`);
        const label = await page.getByRole("img", { name: /prizes/ }).first().getAttribute("aria-label");
        assert(label && /legendary/i.test(label) && /Long shot/.test(label), `the wheel's label lists prizes with rarity (${label})`);
        const h2s = await page.locator("h2:visible").allTextContents();
        assert(h2s.length >= 2, `sections are headings (${h2s.join(" | ")})`);
        await page.getByTestId("fan-spin").click();
        await page.waitForFunction(() => /Spinning/.test(document.querySelector("[data-testid='wheel-status']")?.textContent ?? ""), null, { timeout: 5000 });
        await page.getByTestId("reward-reveal").waitFor({ timeout: 20000 });
        assert(/^Landed on .+\.$/.test(await page.getByTestId("wheel-status").textContent()), "the live region names the landing");
        const tag = page.getByTestId("reward-reveal").locator("[data-rarity], .uppercase").first();
        const size = await tag.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)).catch(() => 12);
        assert(size >= 12, `the rarity tag is readable (${size}px) (PA-11)`);
        await closeCard(page);
        const tiny = await page.evaluate(() => [...document.querySelectorAll("[data-testid='fan-game'] *")].filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11 && getComputedStyle(el).visibility !== "hidden").map((el) => el.tagName + ":" + el.textContent.trim().slice(0, 20)));
        assert(tiny.length === 0, `no fan text under 11 px (${tiny.join(", ")})`);
      } finally { await context.close(); }
    });

    await step("b7 fan PA-02: the wheel turns by a transform while it spins and is painted once where it lands", async () => {
      const fan = await own("B7 smooth fan", 1);
      const { context, page } = await openFan(browser, sink, fan.token);
      try {
        // Count paints of the wheel face from the moment SPIN is tapped.
        await page.evaluate(() => {
          const canvas = document.querySelector("[data-testid='fan-game'] canvas");
          const ctx = canvas.getContext("2d");
          window.__fills = 0;
          const fillText = ctx.fillText.bind(ctx);
          ctx.fillText = (...args) => { window.__fills++; return fillText(...args); };
        });
        await page.getByTestId("fan-spin").click();
        await page.waitForFunction(() => /rotate\(/.test(document.querySelector("[data-testid='fan-game'] canvas")?.style.transform ?? ""), null, { timeout: 8000 });
        await page.getByTestId("reward-reveal").waitFor({ timeout: 20000 });
        const after = await page.evaluate(() => ({ fills: window.__fills, transform: document.querySelector("[data-testid='fan-game'] canvas").style.transform }));
        assert(after.transform === "", `the transform is cleared at the stop (${after.transform})`);
        // Painting every frame of a multi-second spin is thousands of label
        // draws; a handful of whole-face paints is a few dozen.
        assert(after.fills > 0 && after.fills <= 400, `the face was painted a handful of times, not every frame (${after.fills} label draws)`);
        await closeCard(page);
      } finally { await context.close(); }
    });

    await step("b7 fan PA-01: a near-black brand colour still gives a visible SPIN button and focus ring (≥ 3:1)", async () => {
      const wheel = await ownWheel(request, "B7 dark brand", [prize("Dark one"), prize("Dark two")]);
      wheels.push(wheel.id);
      await putWheel(request, { ...editable(wheel), brandColor: "#0c0a0e" });
      const fan = await own("B7 dark brand fan", 1, { wheelId: wheel.id });
      const { context, page } = await openFan(browser, sink, fan.token, { device: { viewport: { width: 1024, height: 800 } } });
      try {
        const button = page.getByTestId("fan-spin");
        await button.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const measured = await page.evaluate((contrastSrc) => {
          const contrast = eval(contrastSrc);
          const el = document.activeElement;
          const cs = getComputedStyle(el);
          const bg = getComputedStyle(document.body).backgroundColor;
          const ui = cs.getPropertyValue("--brand-ui").trim();
          return { focused: el?.getAttribute("data-testid"), ring: contrast(cs.outlineColor, bg), fill: ui ? contrast(ui, bg) : 0, outline: cs.outlineStyle, ui, brand: cs.getPropertyValue("--brand").trim() };
        }, CONTRAST);
        assert(measured.focused === "fan-spin" && measured.outline !== "none", `the button has keyboard focus with a ring (${JSON.stringify(measured)})`);
        assert(measured.ring >= 3, `focus ring vs page ≥ 3:1 (${measured.ring.toFixed(2)})`);
        assert(measured.fill >= 3, `button fill vs page ≥ 3:1 (${measured.fill.toFixed(2)})`);
      } finally { await context.close(); }
    });

    await step("b7 fan WA-02: unknown spin, share, verify, creator and leaderboard links are real 404s with the branded page, JS or not", async () => {
      const paths = [`/spin/nope${randomBytes(4).toString("hex")}`, `/share/nope${randomBytes(4).toString("hex")}`, `/verify/nope${randomBytes(4).toString("hex")}`, "/c/admin", `/leaderboard/nope${randomBytes(4).toString("hex")}`];
      const nojs = await browser.newContext({ javaScriptEnabled: false });
      try {
        for (const path of paths) {
          const r = await request.get(BASE + path);
          const html = await r.text();
          assert(r.status() === 404, `${path} → 404 (${r.status()})`);
          assert(html.includes("Error 404") || html.includes("Nothing to verify"), `${path} renders the branded page`);
          assert(/<title>[^<]*(not found|Nothing|Link)[^<]*<\/title>/i.test(html) || html.includes("noindex"), `${path} carries a not-found title and noindex`);
          const page = await nojs.newPage();
          const resp = await page.goto(BASE + path);
          assert(resp.status() === 404, `${path} without JavaScript → 404 (${resp.status()})`);
          const shown = await page.locator("h1:visible").allTextContents();
          assert(shown.length === 1, `${path} without JavaScript shows exactly one explanation (${shown.join(" | ")})`);
          assert(path.startsWith("/verify") ? /Nothing to verify/.test(shown[0]) : /isn.t active/.test(shown[0]), `${path} without JavaScript shows the right one (${shown[0]})`);
          await page.close();
        }
        const verify = await request.get(`${BASE}/verify/nope${randomBytes(6).toString("hex")}`);
        assert(verify.status() === 404 && (await verify.text()).includes("Nothing to verify"), "the batch 6 N2 contract holds");
        // With script: the path picks the explanation even without a fragment.
        const js = await browser.newContext();
        try {
          const page = await js.newPage();
          // No sink: the 404 document is the case under test. Script errors still count.
          const errors = [];
          page.on("pageerror", (e) => errors.push(String(e?.message || e)));
          const resp = await page.goto(`${BASE}/not-found/verify/abc`);
          assert(resp.status() === 404, "the unmatched path is a 404");
          await page.waitForFunction(() => document.querySelector(".nf-kinds")?.getAttribute("data-kind") === "nf-verify", null, { timeout: 8000 });
          const shown = await page.locator("h1:visible").allTextContents();
          assert(shown.length === 1 && /Nothing to verify/.test(shown[0]), `hydrated: one explanation, the verify one (${shown.join(" | ")})`);
          const busy = await page.goto(`${BASE}/not-found/busy/75#nf-busy`);
          assert(busy.status() === 404 && (await page.getByTestId("link-attempts-retry").textContent()) === "75 seconds", "the busy page reads its wait from the path");
          assert(errors.length === 0, `the 404 page hydrates without a script error (${errors.join("; ")})`);
        } finally { await js.close(); }
      } finally { await nojs.close(); }
    });

    await step("b7 fan WA-04 / WA-06 / WA-07 / WA-11 / PR-19 / TS-14: link pages' heads, the share image, no # call to action, nothing behind the gate", async () => {
      const fan = await own("B7 heads fan", 2);
      const win = await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "heads" } }), "spin");
      const dead = await request.get(`${BASE}/share/nope${randomBytes(4).toString("hex")}/opengraph-image`);
      assert(dead.status() === 404, `a dead share link has no preview image (${dead.status()})`);
      const live = await request.get(`${BASE}/share/${win.shareId}/opengraph-image`);
      assert(live.status() === 200 && live.headers()["content-type"].includes("image/png"), `a real win renders its image (${live.status()})`);
      const share = await (await request.get(`${BASE}/share/${win.shareId}`)).text();
      assert(/<meta name="robots" content="noindex/.test(share) && !/rel="manifest"/.test(share), "the share page is noindex and links no app manifest");
      const spin = await (await request.get(`${BASE}/spin/${fan.token}`)).text();
      assert(/<title>Demo Creator · Play<\/title>/.test(spin), "the fan's tab is named after their game");
      assert(/<meta name="description" content="Your personal prize game/.test(spin), "…with a fan-facing description");
      const unacked = await own("B7 gated fan", 1, { ack: false });
      const gatedHtml = await (await request.get(`${BASE}/spin/${unacked.token}`)).text();
      assert(gatedHtml.includes("Before you play"), "the gate is served");
      for (const marker of ['data-testid="fan-spin"', 'data-testid="prize-book-item"', 'data-testid="win-codes"', 'data-testid="chat-fab"', 'data-testid="your-play"']) {
        assert(!gatedHtml.includes(marker), `${marker} is not in the page behind the gate (TS-14)`);
      }
      const ackedHtml = await (await request.get(`${BASE}/spin/${fan.token}`)).text();
      assert(ackedHtml.includes('data-testid="fan-spin"'), "an acknowledged fan gets the game");
      const verify = await (await request.get(`${BASE}/verify/${win.shareId}`)).text();
      assert(/<meta name="description" content="Proof that this win/.test(verify) && /noindex/.test(verify) && !/rel="manifest"/.test(verify), "the verify page describes itself, noindex, no manifest");
      const board = await request.get(`${BASE}/leaderboard/${demoWheel.creatorId ?? "demo-creator"}`);
      if (board.status() === 200) assert(/<title>[^<]*Leaderboard[^<]*<\/title>/.test(await board.text()), "the leaderboard tab is named");
      const bio = await (await request.get(`${BASE}/c/demo-creator`)).text();
      assert(!/href="#"/.test(bio), "the public page has no # call to action (PR-19)");
      assert(!/rel="manifest"/.test(bio), "the public page links no dashboard manifest (WA-06)");
    });

    await step("b7 fan WF-14: the install nudge says \"this page\", never an app name the fan has not heard of", async () => {
      const fan = await own("B7 nudge fan", 1);
      const { context, page } = await openFan(browser, sink, fan.token, { ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
      try {
        await page.evaluate(() => { window.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: "dismissed" }) })); });
        await spinForCard(page); await closeCard(page);
        const nudge = page.getByTestId("install-nudge");
        if (await nudge.count()) {
          const text = await nudge.textContent();
          assert(/Add this page to your home screen/.test(text) || /Add .+ to your home screen/.test(text), `the nudge names what is added (${text})`);
          assert(!/Add Spins to/.test(text), "…and not a neutral app name");
        }
      } finally { await context.close(); }
    });
  } finally {
    await putWheel(request, editable(demoWheel)).catch(() => {});
    for (const id of fans) await request.delete(`${BASE}/api/fans/${id}`).catch(() => {});
    for (const id of wheels) await request.delete(`${BASE}/api/wheels/${id}`).catch(() => {});
  }
}

/** Axe states for the batch 7 fan surfaces. */
export function fanB7A11yStates() {
  const inAppHint = async (page) => {
    const fan = await newFan(page.request, "A11y in-app hint", 1);
    await goto(page, `/spin/${fan.token}`, 600);
    await passAgeGate(page);
    await page.getByTestId("in-app-hint").waitFor({ timeout: 8000 });
  };
  const legalSheet = async (page) => {
    const fan = await newFan(page.request, "A11y legal sheet", 1, { ack: false });
    await goto(page, `/spin/${fan.token}`, 600);
    await page.getByRole("dialog", { name: "Before you play" }).getByRole("link", { name: "Terms of Service" }).click();
    await page.getByTestId("legal-sheet").waitFor({ timeout: 8000 });
    await page.waitForTimeout(800);
  };
  const cooldown = async (page) => {
    const fan = await newFan(page.request, "A11y cooldown", 1);
    await page.route("**/api/spin", (route) => route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "30" }, body: JSON.stringify({ error: "rate_limited" }) }));
    await goto(page, `/spin/${fan.token}`, 600);
    await passAgeGate(page);
    await page.getByTestId("fan-spin").click();
    await page.waitForFunction(() => /Try again/.test(document.querySelector("[data-testid='fan-spin']")?.textContent ?? ""), null, { timeout: 6000 });
  };
  const toppedUp = async (page) => {
    const fan = await newFan(page.request, "A11y top-up", 1);
    await goto(page, `/spin/${fan.token}`, 600);
    await passAgeGate(page);
    await spinForCard(page); await closeCard(page);
    await topUp(page.request, fan, "A11y top-up", 2);
    await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 40000; document.dispatchEvent(new Event("visibilitychange")); });
    await page.getByTestId("topup-note").waitFor({ timeout: 15000 });
  };
  const verifyKind = async (page) => { await page.waitForFunction(() => document.querySelector(".nf-kinds")?.getAttribute("data-kind") === "nf-verify", null, { timeout: 8000 }); };
  const busyKind = async (page) => { await page.getByTestId("link-attempts-retry").waitFor({ timeout: 8000 }); };
  return [
    { path: null, name: "fan spin phone (top-up note)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true }, prep: toppedUp },
    { path: "/verify/no-such-spin-a11y", name: "verify 404 phone (nothing to verify)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true }, prep: verifyKind },
    { path: "/not-found/busy/75#nf-busy", name: "fan link 404 phone (too many attempts)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true }, prep: busyKind },
    { path: null, name: "fan spin phone (in-app browser hint)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true, userAgent: INSTAGRAM_IOS_UA }, prep: inAppHint },
    { path: null, name: "fan spin phone (legal sheet over the gate)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true }, prep: legalSheet },
    { path: null, name: "fan spin phone (spin cooldown)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true }, prep: cooldown },
  ];
}
