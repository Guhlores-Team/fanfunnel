// Fan devices (b6): the fan page on the phones and browsers real fans use.
// Large text and landscape (the age gate and Safety sheet scroll inside the
// screen), a suspended creator's link, browsers without Web Locks, in-app
// browsers (Instagram, TikTok…), a slow connection before hydration, long
// names, the verify page's time zone and the claim card. Every fan is the
// journey's own; the demo creator is always restored.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, goto, passAgeGate, spinIntentKey, waitForSpinAcknowledged } from "./harness.mjs";
import { spinAndCloseWin } from "./pwa.mjs";

export const INSTAGRAM_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 307.0.0.34.111 (iPhone14,5; iOS 17_1; en_US; en; scale=3.00; 1170x2532; 532277068)";
const PHONE = { viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const SE_LANDSCAPE = { viewport: { width: 568, height: 320 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SE_PORTRAIT = { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Root text scale as the OS "Larger text" / browser zoom setting applies it. */
export function largeText(pct) {
  const apply = () => { document.documentElement.style.fontSize = pct + "%"; };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
}

async function newFan(request, name, spins = 3, { ack = true } = {}) {
  const res = await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins } });
  if (!res.ok()) throw new Error(`could not create ${name} (${res.status()})`);
  const fan = await res.json();
  if (ack) {
    const acked = await acknowledgeFixtureFan(request, fan.token);
    if (!acked.ok()) throw new Error(`could not acknowledge ${name} (${acked.status()})`);
  }
  return fan;
}
const eraseFan = async (request, fanId) => { if (fanId) await request.delete(`${BASE}/api/fans/${fanId}`).catch(() => {}); };
const setCreatorActive = async (request, active) => {
  const res = await request.post(BASE + "/api/debug/creator-status", { data: { active } });
  if (!res.ok()) throw new Error(`could not set the demo creator active=${active} (${res.status()}; needs NEXT_PUBLIC_ENABLE_DEBUG=1 in demo mode)`);
};

/**
 * Scroll `locator` into view inside whatever scrolls it, then prove it sits
 * fully inside the viewport and is the element a tap at its centre lands on.
 * Returns a short description for messages; throws when it is unreachable.
 */
export async function assertReachable(page, locator, what) {
  await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  if (!box || !vp) throw new Error(`${what}: no box`);
  const inside = box.y >= -0.5 && box.x >= -0.5 && box.y + box.height <= vp.height + 0.5 && box.x + box.width <= vp.width + 0.5;
  if (!inside) throw new Error(`${what} is outside the ${vp.width}×${vp.height} screen (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)})`);
  const hit = await locator.evaluate((el, [x, y]) => {
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  if (!hit) throw new Error(`${what} is covered at its centre`);
  return `${Math.round(box.y)}+${Math.round(box.height)} of ${vp.height}`;
}

/** Open a fan's age gate in a context with the given device and text scale. */
async function openGate(browser, sink, device, token, textPercent) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  attachSink(page, sink);
  if (textPercent) await page.addInitScript(largeText, textPercent);
  await goto(page, `/spin/${token}`, 600);
  const gate = page.getByRole("dialog", { name: "Before you spin" });
  await gate.waitFor({ timeout: 8000 });
  await page.getByTestId("agegate-enter").waitFor({ timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector("[role='dialog'] input[type='checkbox']")?.disabled, null, { timeout: 15000 });
  return { context, page, gate };
}

/** FD-1: tick, scroll and pass the gate; every control must be reachable. */
async function passGateAt(page, gate, assert) {
  const boxes = await gate.getByRole("checkbox").all();
  assert(boxes.length === 2, "the gate has its two checkboxes");
  for (const [i, box] of boxes.entries()) {
    await assertReachable(page, box, `checkbox ${i + 1}`);
    await box.check();
  }
  const where = await assertReachable(page, page.getByTestId("agegate-enter"), "the gate's enter button");
  await page.getByTestId("agegate-enter").click();
  await gate.waitFor({ state: "hidden", timeout: 6000 });
  return where;
}

/** FD-2: the Safety sheet's first and last actions are reachable. */
async function openSafetyAt(page) {
  await page.getByRole("button", { name: "Safety & privacy" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Safety and privacy" });
  await dialog.waitFor({ timeout: 5000 });
  return dialog;
}

export async function fanDevicesJourney(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;
  const fans = [];
  const own = async (name, spins, opts) => { const fan = await newFan(request, name, spins, opts); fans.push(fan.fanId); return fan; };
  try {
    await step("fan devices FD-1: the age gate scrolls and passes at 200% text on a phone", async () => {
      const fan = await own("FD gate 200", 2, { ack: false });
      const { context, page, gate } = await openGate(browser, sink, PHONE, fan.token, 200);
      try {
        const overflow = await gate.evaluate((el) => el.scrollHeight > el.clientHeight);
        assert(overflow, "at 200% the gate is taller than the screen (the case being tested)");
        await passGateAt(page, gate, assert);
      } finally { await context.close(); }
    });

    await step("fan devices FD-1: the age gate scrolls and passes in landscape (iPhone SE)", async () => {
      const fan = await own("FD gate landscape", 2, { ack: false });
      const { context, page, gate } = await openGate(browser, sink, SE_LANDSCAPE, fan.token, 0);
      try { await passGateAt(page, gate, assert); } finally { await context.close(); }
    });

    await step("fan devices FD-2: the Safety sheet reaches Report and Cancel at 200% text and in landscape", async () => {
      const fan = await own("FD safety", 2);
      for (const [device, pct] of [[SE_PORTRAIT, 200], [SE_LANDSCAPE, 0]]) {
        const context = await browser.newContext(device);
        const page = await context.newPage();
        attachSink(page, sink);
        if (pct) await page.addInitScript(largeText, pct);
        try {
          await goto(page, `/spin/${fan.token}`, 900);
          const dialog = await openSafetyAt(page);
          await assertReachable(page, dialog.getByRole("button", { name: /Report this creator/ }), "Report this creator");
          await assertReachable(page, dialog.getByRole("button", { name: "Cancel" }), "Cancel");
          await dialog.getByRole("button", { name: /Report this creator/ }).click();
          const field = dialog.getByLabel("Additional details (optional)");
          await assertReachable(page, field, "the report details field");
          // FD-9: no field under 16px on a phone (iOS zooms into it and stays zoomed).
          const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          assert(size >= 16, `the report field is at least 16px on a phone (saw ${size})`);
        } finally { await context.close(); }
      }
    });

    await step("fan devices FD-3: a suspended creator's link is not playable and shows no tip link", async () => {
      const fan = await own("FD suspended", 3);
      const context = await browser.newContext(PHONE);
      // No sink: the refused spin (403) is the behaviour under test, and the
      // browser logs every refused fetch as a console error.
      const page = await context.newPage();
      try {
        // Open while the creator is active, then the creator is suspended.
        await goto(page, `/spin/${fan.token}`, 1200);
        await page.getByTestId("fan-spin").waitFor({ timeout: 8000 });
        await setCreatorActive(request, false);
        const refused = page.waitForResponse((r) => r.url().endsWith("/api/spin") && r.request().method() === "POST");
        await page.getByTestId("fan-spin").click();
        const res = await refused;
        assert(res.status() === 403 && (await res.json()).error === "blocked", "the spin is refused as blocked, not left pending");
        await page.waitForFunction((key) => localStorage.getItem(key) === null, spinIntentKey(fan.token), { timeout: 5000 });
        assert(await page.getByTestId("spin-recovery-controls").count() === 0, "no 'check this spin' loop");
        // A fresh load is the "link not active" page: no wheel, balance or tip link.
        const direct = await request.get(`${BASE}/spin/${fan.token}`);
        assert(direct.status() === 404, `the link answers 404 like a paused link (saw ${direct.status()})`);
        const html = await direct.text();
        assert(!html.includes('data-testid="fan-game"') && !html.includes('data-testid="fan-spin"') && !html.includes('data-testid="spins-chip"'),
          "no game, balance or tip link on the page");
        assert((await request.get(`${BASE}/spin/${fan.token}/manifest`)).status() === 404, "no install manifest either");
        const status = await request.post(BASE + "/api/spin", { data: { token: fan.token, requestId: randomUUID(), clientSeed: "fd3" } });
        assert(status.status() === 403 && (await status.json()).error === "blocked", "the API refuses with blocked");
      } finally {
        await setCreatorActive(request, true);
        await context.close();
      }
      const back = await request.get(`${BASE}/spin/${fan.token}`);
      assert(back.status() === 200, "restoring the creator reopens the link");
    });

    await step("fan devices FD-4: without the Web Locks API the fan can still spin", async () => {
      const fan = await own("FD no locks", 2);
      const context = await browser.newContext(PHONE);
      const page = await context.newPage();
      attachSink(page, sink);
      await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined }); });
      try {
        await goto(page, `/spin/${fan.token}`, 1200);
        assert(await page.evaluate(() => navigator.locks === undefined), "the page really has no navigator.locks");
        await spinAndCloseWin(page);
        await waitForSpinAcknowledged(page);
        assert(await page.getByTestId("spin-storage-check").count() === 0, "no storage advice for a Locks problem");
        assert((await page.getByTestId("spins-chip").innerText()).includes("1"), "the spin was spent once");
      } finally { await context.close(); }
    });

    await step("fan devices FD-5: blocked storage in Instagram's browser says to open Safari or Chrome", async () => {
      const fan = await own("FD in-app storage", 2);
      const context = await browser.newContext({ ...PHONE, userAgent: INSTAGRAM_IOS_UA });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
      const page = await context.newPage();
      attachSink(page, sink);
      await page.addInitScript(() => {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (String(key).startsWith("ff-spin-intent-v1:")) throw new DOMException("blocked", "SecurityError");
          return write.call(this, key, value);
        };
      });
      try {
        await goto(page, `/spin/${fan.token}`, 1200);
        await page.getByTestId("fan-spin").click();
        await page.getByTestId("open-in-browser").waitFor({ timeout: 8000 });
        const message = await page.getByTestId("spin-recovery-status").innerText();
        assert(/Safari or Chrome/.test(message) && !/settings/i.test(message), `in-app copy points at the phone's browser (${message})`);
        await page.getByTestId("open-in-browser-copy").click();
        await page.waitForFunction(() => /Link copied|Copy this link/.test(document.querySelector("[data-testid='open-in-browser']")?.textContent ?? ""), null, { timeout: 4000 });
        assert(await page.getByTestId("fan-spin").isDisabled(), "nothing was spent");
      } finally { await context.close(); }
    });

    await step("fan devices FD-6/FD-7: Instagram on iPhone gets Safari-first install steps and the data on the page", async () => {
      const fan = await own("FD in-app", 2);
      const context = await browser.newContext({ ...PHONE, userAgent: INSTAGRAM_IOS_UA });
      const page = await context.newPage();
      attachSink(page, sink);
      try {
        await goto(page, `/spin/${fan.token}`, 1200);
        await spinAndCloseWin(page);
        const nudge = page.getByTestId("install-nudge");
        await nudge.waitFor({ timeout: 5000 });
        await nudge.getByRole("button", { name: "How" }).click();
        const guide = page.getByTestId("install-guide-in-app");
        await guide.waitFor({ timeout: 3000 });
        assert(/Safari/.test(await guide.innerText()) && /first/.test(await guide.innerText()), "step 1 is to open Safari first");
        assert(!(await nudge.innerText()).includes("in Safari’s toolbar"), "no Safari-toolbar step inside Instagram");
        const dialog = await openSafetyAt(page);
        await dialog.getByRole("button", { name: /Download|Export/ }).click();
        const inline = page.getByTestId("fan-data-inline");
        await inline.waitFor({ timeout: 8000 });
        const json = JSON.parse(await inline.locator("textarea").inputValue());
        assert(json && typeof json === "object", "the export is shown as JSON on the page");
        assert(!/downloading/i.test(await dialog.innerText()), "nothing claims a download");
        await assertReachable(page, page.getByTestId("fan-data-open"), "Open in a new tab");
      } finally { await context.close(); }
    });

    await step("fan devices FD-8: on Slow 3G the gate waits for the page, then keeps the fan's ticks", async () => {
      const fan = await own("FD slow gate", 2, { ack: false });
      const context = await browser.newContext(PHONE);
      const page = await context.newPage();
      attachSink(page, sink);
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 2000, downloadThroughput: (500e3 / 8) * 0.8, uploadThroughput: (500e3 / 8) * 0.8 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(`${BASE}/spin/${fan.token}`, { waitUntil: "commit", timeout: 60000 });
        const gate = page.getByRole("dialog", { name: "Before you spin" });
        await gate.waitFor({ timeout: 30000 });
        const first = gate.getByRole("checkbox").first();
        const early = await page.evaluate(() => {
          const box = document.querySelector("[role='dialog'] input[type='checkbox']");
          return { hydrated: !!box && Object.keys(box).some((k) => k.startsWith("__reactProps")), disabled: !!box?.disabled,
            loading: !!document.querySelector("[data-testid='agegate-loading']") };
        });
        assert(!early.hydrated, "the gate is on screen before the page is interactive (the case being tested)");
        assert(early.disabled && early.loading, "before hydration the boxes are disabled with a loading note");
        await first.click({ force: true }).catch(() => {});
        assert(!(await first.isChecked()), "a tick before hydration is not silently accepted");
        await page.waitForFunction(() => !document.querySelector("[role='dialog'] input[type='checkbox']")?.disabled, null, { timeout: 90000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        assert(await page.getByTestId("agegate-loading").count() === 0, "the loading note goes once the page responds");
        for (const box of await gate.getByRole("checkbox").all()) await box.check();
        await page.waitForTimeout(500);
        for (const box of await gate.getByRole("checkbox").all()) assert(await box.isChecked(), "ticks made after hydration stay ticked");
        await page.getByTestId("agegate-enter").click();
        await gate.waitFor({ state: "hidden", timeout: 8000 });
      } finally { await context.close(); }
    });

    await step("fan devices FD-10/FD-12: a long unbroken name wraps, and the win card carries name, time and code", async () => {
      const name = "x".repeat(24) + "_fan_" + "y".repeat(24);
      const fan = await own(name, 2);
      const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      attachSink(page, sink);
      try {
        await goto(page, `/spin/${fan.token}`, 1200);
        const width = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert(width[0] <= width[1], `no sideways scroll with a ${name.length}-character name (${width.join(" > ")})`);
        const spun = page.waitForResponse((r) => r.url().endsWith("/api/spin") && r.request().method() === "POST");
        await page.getByTestId("fan-spin").click();
        const result = await (await spun).json();
        const proof = page.getByTestId("win-proof");
        await proof.waitFor({ timeout: 15000 });
        const text = await proof.innerText();
        // C4 (batch 6): the code is the server's HMAC of the share id, sent only to the winner.
        const code = String(result.claimCode);
        assert(/^[0-9A-Z]{6}$/.test(code) && !String(result.shareId).toUpperCase().endsWith(code), `the spin response carries a server claim code (${code})`);
        assert(text.includes(name) && text.includes(code), `the card shows the fan's name and claim code ${code} (${text})`);
        assert(/\d{1,2}:\d{2}/.test(text), "and the time of the win");
        await page.getByRole("button", { name: "Awesome!" }).click();
        await waitForSpinAcknowledged(page);
      } finally { await context.close(); }
    });

    await step("fan devices FD-13: an unconfirmed spin shows one action at a time", async () => {
      const fan = await own("FD one action", 3);
      const context = await browser.newContext(PHONE);
      const page = await context.newPage();
      attachSink(page, sink);
      try {
        await goto(page, `/spin/${fan.token}`, 1200);
        await page.route("**/api/spin", (route) => route.abort("aborted"));
        await page.getByTestId("fan-spin").click();
        const controls = page.getByTestId("spin-recovery-controls");
        await controls.waitFor({ timeout: 8000 });
        await page.unroute("**/api/spin");
        assert(await controls.getByRole("button").count() === 1 && await page.getByTestId("spin-recovery-check").isVisible(), "one action: check this spin");
        assert(!(await page.getByTestId("fan-spin").isVisible()), "the disabled play button is not a second, similar button");
        assert(await page.getByTestId("spin-recovery-status").isVisible(), "with a status line");
        await page.getByTestId("spin-recovery-check").click();
        await page.getByTestId("spin-recovery-retry").waitFor({ timeout: 8000 });
        assert(await controls.getByRole("button").count() === 1, "after 'not confirmed', one action: try again");
        await page.getByTestId("spin-recovery-retry").click();
        await page.getByTestId("reward-reveal").waitFor({ timeout: 15000 });
        await page.getByRole("button", { name: "Awesome!" }).click();
        await waitForSpinAcknowledged(page);
        assert(await page.getByTestId("fan-spin").isVisible(), "the play button is back");
      } finally {
        await page.unroute("**/api/spin").catch(() => {});
        await context.close();
      }
    });

    await step("fan devices FD-11/FD-14: the verify page shows the fan's time zone and fits 320px", async () => {
      const fan = await own("FD verify", 1);
      const res = await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fan.token, clientSeed: "fd11" } });
      const spin = await res.json();
      assert(typeof spin.shareId === "string", "a spin to verify");
      const html = await (await request.get(`${BASE}/verify/${spin.shareId}`)).text();
      assert(/data-testid="verify-time"[^>]*>[^<]*UTC</.test(html), "the server renders the time in labelled UTC");
      const context = await browser.newContext({ ...SE_PORTRAIT, locale: "en-AU", timezoneId: "Australia/Sydney" });
      const page = await context.newPage();
      attachSink(page, sink);
      try {
        await goto(page, `/verify/${spin.shareId}`, 900);
        const shown = await page.getByTestId("verify-time").innerText();
        assert(/AEDT|AEST|GMT\+1[01]/.test(shown), `a Sydney fan sees Sydney time (${shown})`);
        const width = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert(width[0] <= width[1], `no sideways scroll at 320px (${width.join(" > ")})`);
      } finally { await context.close(); }
    });
  } finally {
    await setCreatorActive(request, true).catch(() => {});
    for (const id of fans) await eraseFan(request, id);
  }
}

// ---- a11y states (e2e/a11y.mjs) ---------------------------------------------

const a11yFan = async (page, name, ack) => {
  const fan = await newFan(page.request, name, 2, { ack });
  return fan.token;
};
/** The gate at a text scale/orientation, with its primary action proven reachable. */
const gateState = (pct) => async (page) => {
  if (pct) await page.addInitScript(largeText, pct);
  const token = await a11yFan(page, "A11y gate " + (pct || "landscape"), false);
  await goto(page, `/spin/${token}`, 1400);
  await page.getByRole("dialog", { name: "Before you spin" }).waitFor({ timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector("[role='dialog'] input[type='checkbox']")?.disabled, null, { timeout: 15000 });
  await assertReachable(page, page.getByRole("dialog", { name: "Before you spin" }).getByRole("checkbox").first(), "the gate's first checkbox");
  await assertReachable(page, page.getByTestId("agegate-enter"), "the gate's enter button");
};
const safetyState = (pct) => async (page) => {
  if (pct) await page.addInitScript(largeText, pct);
  const token = await a11yFan(page, "A11y safety " + (pct || "landscape"), true);
  await goto(page, `/spin/${token}`, 1400);
  await passAgeGate(page);
  const dialog = await openSafetyAt(page);
  await assertReachable(page, dialog.getByRole("button", { name: /Report this creator/ }), "Report this creator");
  await assertReachable(page, dialog.getByRole("button", { name: "Cancel" }), "Cancel");
  await dialog.getByRole("button", { name: /Report this creator/ }).scrollIntoViewIfNeeded();
};

const inAppStorageState = async (page) => {
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith("ff-spin-intent-v1:")) throw new DOMException("blocked", "SecurityError");
      return write.call(this, key, value);
    };
  });
  const token = await a11yFan(page, "A11y in-app storage", true);
  await goto(page, `/spin/${token}`, 1400);
  await page.getByTestId("fan-spin").click();
  await page.getByTestId("open-in-browser").waitFor({ timeout: 8000 });
};
const inAppExportState = async (page) => {
  const token = await a11yFan(page, "A11y in-app export", true);
  await goto(page, `/spin/${token}`, 1400);
  const dialog = await openSafetyAt(page);
  await dialog.getByRole("button", { name: /Download|Export/ }).click();
  await page.getByTestId("fan-data-inline").waitFor({ timeout: 8000 });
};

export function fanDevicesA11yStates() {
  return [
    { path: null, name: "fan spin phone 200% text (age gate)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true }, prep: gateState(200) },
    { path: null, name: "fan spin landscape (age gate)", viewport: SE_LANDSCAPE.viewport, context: { isMobile: true, hasTouch: true }, prep: gateState(0) },
    { path: null, name: "fan Safety menu phone 200% text", viewport: SE_PORTRAIT.viewport, context: { isMobile: true, hasTouch: true }, prep: safetyState(200) },
    { path: null, name: "fan Safety menu landscape", viewport: SE_LANDSCAPE.viewport, context: { isMobile: true, hasTouch: true }, prep: safetyState(0) },
    { path: null, name: "fan spin phone (in-app browser: open in Safari or Chrome)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true, userAgent: INSTAGRAM_IOS_UA }, prep: inAppStorageState },
    { path: null, name: "fan Safety menu phone (in-app browser: data on the page)", viewport: PHONE.viewport, context: { isMobile: true, hasTouch: true, userAgent: INSTAGRAM_IOS_UA }, prep: inAppExportState },
  ];
}
