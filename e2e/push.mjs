// Web push journey (closed-tab notifications for creators). Runs before the
// first-run wipe, each part in its own browser context so the stubs below
// never leak into the other journeys.
//
// Headless Chromium can't receive a real push (no push service), so the
// browser side of PushManager is stubbed with a fake subscription on an
// allowed push-service host, and the demo server's simulated push service
// (GET /api/push/outbox, demo only) shows what WOULD have been delivered. The
// real routes, data layer, F8 builder and sender all run.
//
// Always covered: the Settings card, the iPhone "Add to Home Screen first"
// guidance, the push-off state, the bell footer and Inbox deep links.
// With VAPID keys on the server (CI sets throwaway ones): turn on, the
// lock-screen switch, Send a test, F8 parity (push text === bell text, generic
// by default), a 410 device pruned, Remove.

import { attachSink, goto, BASE } from "./harness.mjs";
import { IPHONE_UA } from "./pwa.mjs";

const PHONE = { width: 390, height: 844 };
const CARD = "[data-testid='push-card']";

/** Fake PushManager + granted Notification permission (headless has no push service). */
export const PUSH_STUB = `(() => {
  const KEY = "ff.e2e.pushEndpoint";
  const make = (endpoint) => ({
    endpoint,
    expirationTime: null,
    options: {},
    getKey: () => null,
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } }),
    unsubscribe: async () => { sessionStorage.removeItem(KEY); return true; },
  });
  if (window.PushManager) {
    PushManager.prototype.subscribe = async function () {
      const endpoint = "https://fcm.googleapis.com/fcm/send/e2e-" + Math.random().toString(36).slice(2);
      sessionStorage.setItem(KEY, endpoint);
      return make(endpoint);
    };
    PushManager.prototype.getSubscription = async function () {
      const endpoint = sessionStorage.getItem(KEY);
      return endpoint ? make(endpoint) : null;
    };
  }
  if (window.Notification) {
    Object.defineProperty(Notification, "permission", { get: () => "granted", configurable: true });
    Notification.requestPermission = async () => "granted";
  }
})();`;

export async function pushConfig(request) {
  const res = await request.get(BASE + "/api/push/config");
  return res.ok() ? res.json() : { available: false };
}

const outbox = async (request) => (await (await request.get(BASE + "/api/push/outbox")).json()).deliveries ?? [];

/** Open Settings and bring the push card into view. */
export async function openPushCard(page) {
  await goto(page, "/dashboard?section=settings", 1600);
  const card = page.locator(CARD);
  await card.waitFor({ timeout: 10000 });
  await card.scrollIntoViewIfNeeded();
  await page.getByTestId("push-status").filter({ hasNotText: "Checking" }).waitFor({ timeout: 10000 });
  return card;
}

/** Turn push on for this (stubbed) browser; returns the card. */
export async function turnPushOn(page) {
  const card = await openPushCard(page);
  const toggle = page.getByTestId("push-toggle");
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    const posted = page.waitForResponse((r) => r.url().endsWith("/api/push/subscribe") && r.request().method() === "POST");
    await toggle.click();
    const res = await posted;
    if (res.status() !== 201) throw new Error(`subscribe answered ${res.status()}`);
    await page.locator(`${CARD} [role='switch'][data-testid='push-toggle'][aria-checked='true']`).waitFor({ timeout: 8000 });
  }
  return card;
}

/** Remove every demo device (keeps reruns and the a11y pass independent). */
export async function clearPushDevices(request) {
  const res = await request.get(BASE + "/api/push/subscribe");
  if (!res.ok()) return;
  for (const d of (await res.json()).devices ?? []) {
    await request.delete(BASE + "/api/push/subscribe", { data: { id: d.id } });
  }
}

export async function pushJourney(browser, { step, assert }, sink, ctx) {
  const cfg = await pushConfig(ctx.request);
  const fresh = async (opts = {}) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
    const p = await c.newPage();
    attachSink(p, sink);
    return { c, p };
  };

  await step("push: Settings › Notifications has the per-device push card", async () => {
    const { c, p } = await fresh();
    try {
      const card = await openPushCard(p);
      const text = await card.innerText();
      assert(/Push to this device/.test(text), "the 'Push to this device' switch");
      assert(/Show names and prizes on lock screen/.test(text), "the lock-screen switch");
      assert(/Send a test/.test(text), "Send a test");
      const details = p.getByTestId("push-details-toggle");
      assert((await details.getAttribute("role")) === "switch" && (await details.getAttribute("aria-checked")) === "false", "lock screen is generic by default (D9)");
      const toggle = p.getByTestId("push-toggle");
      assert((await toggle.getAttribute("aria-checked")) === "false", "push starts off for a new browser");
      if (!cfg.available) {
        assert(/aren.t available/.test(await p.getByTestId("push-status").innerText()), "keys unset: the card says push is unavailable");
        assert(await toggle.isDisabled(), "keys unset: the switch is disabled");
      }
    } finally {
      await c.close();
    }
  });

  await step("push: keys unset (forced) → the card says unavailable and nothing can be turned on", async () => {
    const { c, p } = await fresh();
    try {
      await p.route("**/api/push/config", (r) => r.fulfill({ json: { available: false, publicKey: null } }));
      await openPushCard(p);
      assert(/aren.t available/.test(await p.getByTestId("push-status").innerText()), "unavailable message");
      assert(await p.getByTestId("push-toggle").isDisabled(), "switch disabled");
      assert(await p.getByTestId("push-test").isDisabled(), "test disabled");
    } finally {
      await c.close();
    }
  });

  await step("push: iPhone in Safari → 'Add FanFunnel to your Home Screen first' with steps", async () => {
    const { c, p } = await fresh({ viewport: PHONE, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
    try {
      await openPushCard(p);
      assert(/Add FanFunnel to your Home Screen first/.test(await p.getByTestId("push-status").innerText()), "the iPhone rule is shown");
      const steps = p.getByTestId("push-ios-steps");
      assert(await steps.isVisible(), "install steps are listed");
      assert(/Add to Home Screen/.test(await steps.innerText()), "steps name Add to Home Screen");
      assert(await p.getByTestId("push-toggle").isDisabled(), "push can't be turned on in a Safari tab");
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `no horizontal overflow on a phone (${overflow}px)`);
    } finally {
      await c.close();
    }
  });

  await step("push: the bell footer and the Inbox open the push card", async () => {
    const { c, p } = await fresh();
    try {
      await goto(p, "/dashboard", 1600);
      await p.getByTestId("notification-bell").click();
      const panel = p.getByRole("dialog", { name: "Notifications" });
      await panel.waitFor({ timeout: 5000 });
      await p.getByTestId("bell-push-link").click();
      await panel.waitFor({ state: "hidden", timeout: 4000 });
      await p.locator(CARD).waitFor({ timeout: 10000 });
      await p.waitForFunction(() => document.activeElement?.closest("[data-testid='push-card']") !== null, null, { timeout: 5000 });
      assert(true, "focus moved into the push card");
      await goto(p, "/dashboard?section=inbox", 1600);
      const optin = p.getByTestId("inbox-push-optin");
      await optin.waitFor({ timeout: 8000 });
      assert(/Get alerts on this device/.test(await optin.innerText()), "the Inbox opt-in is the push card's");
      await optin.click();
      await p.locator(CARD).waitFor({ timeout: 10000 });
    } finally {
      await c.close();
    }
  });

  if (!cfg.available) {
    await step("push: server has no VAPID keys → subscribe/test refused cleanly (403 not_configured)", async () => {
      const sub = await ctx.request.post(BASE + "/api/push/subscribe", {
        data: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/e2e-off", keys: { p256dh: "BKey", auth: "auth" } } },
      });
      assert(sub.status() === 403 && (await sub.json()).error === "not_configured", `subscribe → 403 not_configured (${sub.status()})`);
      const t = await ctx.request.post(BASE + "/api/push/test", { data: {} });
      assert(t.status() === 403, `test → 403 (${t.status()})`);
    });
    return;
  }

  await clearPushDevices(ctx.request);
  const { c, p } = await fresh();
  await c.addInitScript(PUSH_STUB);
  try {
    await step("push: turn on for this device → listed as this device, generic", async () => {
      await turnPushOn(p);
      assert(/On for this device/.test(await p.getByTestId("push-status").innerText()), "status says on");
      const row = p.getByTestId("push-device").filter({ hasText: "(this device)" });
      await row.waitFor({ timeout: 5000 });
      assert(/Generic/.test(await row.innerText()), "the new device is generic (D9)");
      assert(!(await p.getByTestId("push-test").isDisabled()), "Send a test is enabled");
    });

    await step("push: Send a test → delivered to this device only", async () => {
      const before = (await outbox(ctx.request)).length;
      const sent = p.waitForResponse((r) => r.url().endsWith("/api/push/test"));
      await p.getByTestId("push-test").click();
      const res = await sent;
      assert(res.ok() && (await res.json()).sent === 1, "one test delivered");
      const after = await outbox(ctx.request);
      assert(after.length === before + 1 && after[0].payload.tag === "test", "the simulated push service got the test");
      assert(after[0].payload.url === "/dashboard?section=settings", "the test opens Settings");
    });

    // F8 parity: a real fan spin → the push says exactly what the bell says.
    const spinOnce = async () => {
      const { token } = await (await ctx.request.post(BASE + "/api/passes", { data: { name: "Push Parity Fan", spins: 2 } })).json();
      await ctx.request.post(BASE + "/api/fans/ack", { data: { token } });
      const r = await ctx.request.post(BASE + "/api/spin", { data: { token, clientSeed: "e2e-push" } });
      if (!r.ok()) throw new Error(`spin failed (${r.status()})`);
    };
    const waitForWinPush = async (since) => {
      for (let i = 0; i < 30; i++) {
        const fresh = (await outbox(ctx.request)).filter((d) => Date.parse(d.at) >= since && d.payload.tag.startsWith("win:"));
        if (fresh.length) return fresh[0];
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("no win push arrived");
    };

    await step("push: a fan's win → generic push by default, no fan or prize name (D9)", async () => {
      const since = Date.now() - 50;
      await spinOnce();
      const d = await waitForWinPush(since);
      assert(d.payload.title === "New activity on FanFunnel", `generic title (${d.payload.title})`);
      assert(!/Push Parity Fan/.test(JSON.stringify(d.payload)), "no fan name in the payload");
      assert(d.payload.url === "/dashboard?section=prizes", "opens Fulfilment");
      assert(!/\/spin\/|token/i.test(JSON.stringify(d.payload)), "no fan link or token in the payload");
    });

    await step("push: 'Show names and prizes' on → the push text equals the bell item (F8)", async () => {
      const sw = p.getByTestId("push-details-toggle");
      const patched = p.waitForResponse((r) => r.url().endsWith("/api/push/subscribe") && r.request().method() === "PATCH");
      await sw.click();
      assert((await patched).ok(), "lock-screen switch saved");
      await p.locator("[data-testid='push-details-toggle'][aria-checked='true']").waitFor({ timeout: 5000 });
      assert(/Names shown/.test(await p.getByTestId("push-device").filter({ hasText: "(this device)" }).innerText()), "device row says names shown");
      const since = Date.now() - 50;
      await spinOnce();
      const d = await waitForWinPush(since);
      const feed = await (await ctx.request.get(BASE + "/api/notifications")).json();
      const item = feed.items.find((i) => i.id === d.payload.tag);
      assert(!!item, `the bell has the pushed item (${d.payload.tag})`);
      assert(d.payload.title === item.title && d.payload.body === item.body, `push "${d.payload.title}" === bell "${item.title}"`);
      assert(/Push Parity Fan won /.test(d.payload.title), "detailed mode names the fan and prize");
    });

    await step("push: a device the push service says is gone (410) is pruned", async () => {
      const res = await ctx.request.post(BASE + "/api/push/subscribe", {
        data: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/e2e-gone-x", keys: { p256dh: "BKey", auth: "auth" } } },
      });
      assert(res.status() === 201, `registered a doomed device (${res.status()})`);
      const { device } = await res.json();
      const t = await ctx.request.post(BASE + "/api/push/test", { data: { id: device.id } });
      const body = await t.json();
      assert(t.ok() && body.removed === 1 && body.sent === 0, `410 → removed (${JSON.stringify(body)})`);
      const list = await (await ctx.request.get(BASE + "/api/push/subscribe")).json();
      assert(!list.devices.some((x) => x.id === device.id), "the gone device is no longer listed");
    });

    await step("push: refused inputs (SSRF endpoint, bad id) → 400, nothing stored", async () => {
      const before = (await (await ctx.request.get(BASE + "/api/push/subscribe")).json()).devices.length;
      const bad = await ctx.request.post(BASE + "/api/push/subscribe", {
        data: { subscription: { endpoint: "http://169.254.169.254/latest/meta-data", keys: { p256dh: "BKey", auth: "auth" } } },
      });
      assert(bad.status() === 400, `non-push-service endpoint → 400 (${bad.status()})`);
      const after = (await (await ctx.request.get(BASE + "/api/push/subscribe")).json()).devices.length;
      assert(after === before, "nothing stored");
    });

    await step("push: Inbox hides its opt-in on a device that already has push", async () => {
      await goto(p, "/dashboard?section=inbox", 1800);
      assert((await p.getByTestId("inbox-push-optin").count()) === 0, "no second opt-in when push is on");
    });

    await step("push: turn off → this device is removed", async () => {
      await openPushCard(p);
      const del = p.waitForResponse((r) => r.url().endsWith("/api/push/subscribe") && r.request().method() === "DELETE");
      await p.getByTestId("push-toggle").click();
      assert((await del).ok(), "DELETE ok");
      await p.locator("[data-testid='push-toggle'][aria-checked='false']").waitFor({ timeout: 5000 });
      assert((await p.getByTestId("push-device").count()) === 0, "no devices left");
    });
  } finally {
    await c.close();
    await clearPushDevices(ctx.request);
  }
}
