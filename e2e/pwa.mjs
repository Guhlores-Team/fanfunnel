import { randomUUID } from "node:crypto";
// Home-screen install journey (RM-4). Runs on its own freshly minted fan link,
// so it neither depends on nor disturbs the demo link the other journeys use,
// and it runs before the first-run wipe.
//
// Covers: the fan page links ITS OWN manifest; the manifest and every icon
// return 200 with the right content type and no shared-cache headers; the
// landing page keeps the site-wide manifest; /c/<slug> exposes no fan link; the
// install nudge appears only after a win (Android prompt / iPhone guide), hides
// for 14 days on "Not now" and never shows when installed; the app service
// worker is registered for /dashboard only.

import { attachSink, goto, passAgeGate, BASE } from "./harness.mjs";

export const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const PHONE = { width: 390, height: 844 };
const NUDGE = "[data-testid='install-nudge']";

/** Mint a fresh fan link with `spins` spins (demo mode needs no session). */
export async function mintFanLink(request, spins = 6) {
  const res = await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "PWA Fan", spins } });
  if (!res.ok()) throw new Error(`could not mint a fan link (${res.status()})`);
  const { token } = await res.json();
  if (typeof token !== "string" || !token) throw new Error("no token in /api/passes response");
  return token;
}

/** Stand in for Chrome's beforeinstallprompt (headless never fires it). */
export async function fakeInstallPrompt(page) {
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = async () => {
      window.__ffPrompted = (window.__ffPrompted || 0) + 1;
    };
    e.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
    window.dispatchEvent(e);
  });
}

/** Spin once, wait for the win card (RM-1's RewardReveal), close it. */
export async function spinAndCloseWin(page) {
  const spun = page.waitForResponse((r) => r.url().includes("/api/spin") && r.request().method() === "POST");
  await page.getByRole("button", { name: /^SPIN/ }).first().click();
  await spun;
  const card = page.getByTestId("reward-reveal");
  await card.waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Awesome!" }).click();
  await card.waitFor({ state: "hidden", timeout: 4000 });
}

function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((v, i) => buf[i] === v)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const privateOnly = (headers) => {
  const cc = headers["cache-control"] ?? "";
  return /^private\b/.test(cc) && !/s-maxage|public|immutable/i.test(cc);
};

export async function pwaJourney(browser, { step, assert }, sink, ctx) {
  let token = null;

  await step("pwa: the fan page links its own manifest, never the site-wide one", async () => {
    token = await mintFanLink(ctx.request);
    const html = await (await ctx.request.get(`${BASE}/spin/${token}`)).text();
    const links = [...html.matchAll(/<link rel="manifest" href="([^"]+)"/g)].map((m) => m[1]);
    assert(links.length === 1, `exactly one manifest link (saw ${links.length})`);
    assert(links[0] === `/spin/${token}/manifest`, `it is this link's manifest (saw ${links[0]})`);
    assert(/<meta name="robots" content="noindex, nofollow"\/>/.test(html), "the fan page is noindex");
    assert(/<link rel="apple-touch-icon" href="\/spin\/[^"]+\/icon\/180\?v=/.test(html), "apple-touch-icon is this link's icon");
    assert(/<meta name="apple-mobile-web-app-title" content="Spins"\/>/.test(html), "home-screen title is neutral by default");
  });

  await step("pwa: the per-link manifest and icons are 200, typed, private and noindex", async () => {
    const res = await ctx.request.get(`${BASE}/spin/${token}/manifest`);
    assert(res.status() === 200, `manifest 200 (got ${res.status()})`);
    const h = res.headers();
    assert(h["content-type"] === "application/manifest+json", `manifest content type (${h["content-type"]})`);
    assert(privateOnly(h), `manifest is private, no shared cache (${h["cache-control"]})`);
    assert(/noindex/.test(h["x-robots-tag"] ?? ""), "manifest is noindex");
    const m = JSON.parse(await res.text());
    assert(m.start_url === `/spin/${token}?src=pwa` && m.scope === `/spin/${token}`, "start_url/scope are this fan's link");
    assert(m.display === "standalone" && m.name === "Spins", "standalone, neutral name");
    const icons = [...m.icons.map((i) => ({ src: i.src, size: Number(i.sizes.split("x")[0]) })), { src: `/spin/${token}/icon/180`, size: 180 }];
    for (const icon of icons) {
      const r = await ctx.request.get(BASE + icon.src);
      assert(r.status() === 200, `${icon.src} → 200 (got ${r.status()})`);
      assert(r.headers()["content-type"] === "image/png", `${icon.src} is image/png`);
      assert(privateOnly(r.headers()), `${icon.src} is private (${r.headers()["cache-control"]})`);
      const dim = pngSize(await r.body());
      assert(dim?.w === icon.size && dim?.h === icon.size, `${icon.src} is ${icon.size}px (got ${JSON.stringify(dim)})`);
    }
  });

  await step("pwa: unknown links get a bare, uncacheable 404 and no install surface", async () => {
    const res = await ctx.request.get(`${BASE}/spin/no-such-link-x/manifest`);
    assert(res.status() === 404, `unknown manifest → 404 (got ${res.status()})`);
    assert(/no-store/.test(res.headers()["cache-control"] ?? ""), "the 404 is not cacheable");
    assert((await res.text()) === '{"error":"not_found"}', "the 404 says nothing about the link");
    const icon = await ctx.request.get(`${BASE}/spin/no-such-link-x/icon/192`);
    assert(icon.status() === 404, `unknown icon → 404 (got ${icon.status()})`);
  });

  await step("pwa: the landing page keeps the site-wide (dashboard) manifest", async () => {
    const html = await (await ctx.request.get(BASE + "/")).text();
    assert(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(html), "landing links /manifest.webmanifest");
    const res = await ctx.request.get(BASE + "/manifest.webmanifest");
    assert(res.status() === 200, "site manifest 200");
    const m = JSON.parse(await res.text());
    assert(m.start_url === "/dashboard" && !JSON.stringify(m).includes("/spin/"), "dashboard app, no fan link");
    for (const i of m.icons) {
      const r = await ctx.request.get(BASE + i.src);
      assert(r.status() === 200 && r.headers()["content-type"] === "image/png", `${i.src} → 200 image/png`);
    }
  });

  await step("pwa: the public link-in-bio page exposes no fan link or token", async () => {
    const html = await (await ctx.request.get(BASE + "/c/demo")).text();
    assert(!html.includes("/spin/"), "/c/demo has no /spin/ path");
    assert(!html.includes(token), "/c/demo does not contain the fan's token");
    assert(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(html), "/c/demo links only the site-wide manifest");
  });

  // --- the nudge, in fresh phone contexts (own storage) -------------------------
  const phone = async (opts = {}) => {
    const c = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, ...opts });
    const p = await c.newPage();
    attachSink(p, sink);
    return { c, p };
  };

  await step("pwa: Android — no nudge before a win; after it, Install opens the native prompt", async () => {
    const { c, p } = await phone();
    try {
      await goto(p, `/spin/${token}`, 1800);
      await passAgeGate(p);
      await fakeInstallPrompt(p);
      assert((await p.locator(NUDGE).count()) === 0, "no nudge before the first win");
      await spinAndCloseWin(p);
      const nudge = p.locator(NUDGE);
      await nudge.waitFor({ timeout: 5000 });
      assert(/Add Spins to your home screen/.test(await nudge.innerText()), "uses the neutral app name");
      const install = nudge.getByRole("button", { name: "Install" });
      assert((await install.count()) === 1, "Android gets an Install button");
      await install.click();
      await nudge.waitFor({ state: "detached", timeout: 4000 });
      assert((await p.evaluate(() => window.__ffPrompted)) === 1, "the native prompt opened once");
    } finally {
      await c.close();
    }
  });

  await step("pwa: iPhone — How shows the two-step guide; Not now hides it for 14 days", async () => {
    const { c, p } = await phone({ userAgent: IPHONE_UA });
    try {
      await goto(p, `/spin/${token}`, 1800);
      await passAgeGate(p);
      assert((await p.locator(NUDGE).count()) === 0, "no nudge before the first win");
      await spinAndCloseWin(p);
      const nudge = p.locator(NUDGE);
      await nudge.waitFor({ timeout: 5000 });
      const how = nudge.getByRole("button", { name: "How" });
      assert((await how.getAttribute("aria-expanded")) === "false", "guide starts collapsed");
      await how.click();
      assert((await how.getAttribute("aria-expanded")) === "true", "How expands the guide");
      const guide = p.locator(`[id="${await how.getAttribute("aria-controls")}"]`);
      assert(/Share[\s\S]*Add to Home Screen/.test(await guide.innerText()), "two steps: Share, then Add to Home Screen");
      assert((await guide.locator("li").count()) === 2, "exactly two steps");
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `no horizontal overflow with the guide open (+${overflow}px)`);
      await nudge.getByRole("button", { name: "Not now" }).click();
      await nudge.waitFor({ state: "detached", timeout: 4000 });
      assert(await p.evaluate(() => Number(localStorage.getItem("ff.installNudge.dismissedAt")) > 0), "dismissal remembered");
      await goto(p, `/spin/${token}`, 1800);
      await spinAndCloseWin(p);
      await p.waitForTimeout(600);
      assert((await p.locator(NUDGE).count()) === 0, "stays hidden after the next win (14-day snooze)");
    } finally {
      await c.close();
    }
  });

  await step("pwa: never offered inside the installed app (display-mode: standalone)", async () => {
    const { c, p } = await phone({ userAgent: IPHONE_UA });
    try {
      await p.addInitScript(() => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = (q) =>
          q.includes("display-mode: standalone")
            ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }
            : real(q);
      });
      await goto(p, `/spin/${token}?src=pwa`, 1800);
      await passAgeGate(p);
      await spinAndCloseWin(p);
      await p.waitForTimeout(600);
      assert((await p.locator(NUDGE).count()) === 0, "no nudge when already installed");
    } finally {
      await c.close();
    }
  });

  await step("pwa: the app service worker controls /dashboard only, never a fan page", async () => {
    const { c, p } = await phone();
    try {
      await goto(p, "/dashboard", 2200);
      const scope = await p.evaluate(async () => {
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((r) => setTimeout(() => r(null), 8000)),
        ]);
        return reg ? reg.scope : null;
      });
      assert(scope === `${BASE}/dashboard`, `registered with the /dashboard scope (got ${scope})`);
      await goto(p, `/spin/${token}`, 1500);
      const fan = await p.evaluate(async () => ({
        controller: !!navigator.serviceWorker.controller,
        reg: !!(await navigator.serviceWorker.getRegistration(location.href)),
      }));
      assert(!fan.controller && !fan.reg, `no worker on the fan page (${JSON.stringify(fan)})`);
    } finally {
      await c.close();
    }
  });
}
