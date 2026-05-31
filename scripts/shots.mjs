import { chromium } from "playwright";

const B = "http://localhost:3212";
const OUT = "/tmp/shots";
const log = (s) => console.log("·", s);

const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 };

const browser = await chromium.launch();

async function shot(ctxOpts, name, fn) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  try {
    await fn(page);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    log(`${name}.png`);
  } catch (e) {
    log(`${name} FAILED: ${e.message}`);
    await page.screenshot({ path: `${OUT}/${name}-ERROR.png` }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

const settle = (p, ms = 900) => p.waitForTimeout(ms);

// ---- FAN SURFACE (mobile) ----
await shot(mobile, "01-fan-spin", async (p) => {
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await settle(p, 1200);
});

await shot(mobile, "02-fan-agegate", async (p) => {
  // fresh context => age gate should show on first load for a needs-ack fan
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await settle(p, 800);
});

await shot(mobile, "03-fan-win-modal", async (p) => {
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await settle(p, 600);
  // dismiss age gate if present
  const adult = p.getByText(/18 years of age or older/i);
  if (await adult.count()) {
    await p.locator('input[type=checkbox]').nth(0).check().catch(() => {});
    await p.locator('input[type=checkbox]').nth(1).check().catch(() => {});
    await p.getByRole("button", { name: /confirm|continue|enter|spin/i }).first().click().catch(() => {});
    await settle(p, 500);
  }
  await p.getByRole("button", { name: /^SPIN$/ }).click().catch(() => {});
  await settle(p, 4500); // wheel animates then modal
});

await shot(mobile, "04-fan-chat", async (p) => {
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await settle(p, 600);
  await p.getByRole("button", { name: /message/i }).first().click().catch(() => {});
  await settle(p, 1500);
});

// ---- PUBLIC PAGES (mobile) ----
await shot(mobile, "05-share-card", async (p) => {
  // create a fresh win to get a shareId
  const r = await p.request.post(`${B}/api/spin`, { data: { token: "demo" } });
  const j = await r.json();
  await p.goto(`${B}/share/${j.shareId}`, { waitUntil: "networkidle" });
  await settle(p, 800);
});

await shot(mobile, "06-verify", async (p) => {
  const r = await p.request.post(`${B}/api/spin`, { data: { token: "demo" } });
  const j = await r.json();
  await p.goto(`${B}/verify/${j.shareId}`, { waitUntil: "networkidle" });
  await settle(p, 800);
});

await shot(mobile, "07-leaderboard", async (p) => {
  await p.request.post(`${B}/api/spin`, { data: { token: "demo" } });
  await p.request.post(`${B}/api/leaderboard/enable`, { data: { enabled: true } });
  // creatorId in demo: try the seeded one
  await p.goto(`${B}/leaderboard/demo-creator`, { waitUntil: "networkidle" });
  await settle(p, 600);
});

// ---- DASHBOARD (desktop, tabs) ----
const tabs = ["editor", "fans", "prizes", "campaigns", "boosts", "inbox", "analytics", "metrics"];
await shot(desktop, "08-dashboard", async (p) => {
  await p.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
  await settle(p, 1200);
});

for (const [i, t] of tabs.entries()) {
  await shot(desktop, `09-dash-${String(i + 1).padStart(2, "0")}-${t}`, async (p) => {
    await p.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
    await settle(p, 500);
    // click the tab by its visible label
    const labels = { editor: "Wheel", fans: "Fans", prizes: "Prizes", campaigns: "Campaigns", boosts: "Boosts", inbox: "Inbox", analytics: "Analytics", metrics: "Metrics" };
    await p.getByRole("button", { name: new RegExp(`^${labels[t]}`) }).first().click().catch(() => {});
    await settle(p, 1400);
  });
}

// ---- DASHBOARD mobile (tab scroll + a couple panels) ----
await shot(mobile, "10-dash-mobile", async (p) => {
  await p.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
  await settle(p, 1000);
});

await browser.close();
console.log("DONE");
