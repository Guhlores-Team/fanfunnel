import { chromium } from "playwright";
const B = "http://localhost:3216";
const OUT = "/tmp/shots3";
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const browser = await chromium.launch();
const log = (s) => console.log("·", s);
async function shot(name, fn) {
  const ctx = await browser.newContext(mobile);
  const page = await ctx.newPage();
  try { await fn(page); await page.screenshot({ path: `${OUT}/${name}.png` }); log(`${name}.png`); }
  catch (e) { log(`${name} FAIL: ${e.message}`); await page.screenshot({ path: `${OUT}/${name}-ERR.png` }).catch(()=>{}); }
  finally { await ctx.close(); }
}
const wait = (p, ms = 900) => p.waitForTimeout(ms);
async function gate(p) {
  const cbs = p.locator('input[type=checkbox]');
  if (await cbs.count()) {
    for (let i = 0; i < (await cbs.count()); i++) await cbs.nth(i).check().catch(()=>{});
    await p.getByRole("button", { name: /enter|spin|confirm|continue/i }).first().click().catch(()=>{});
    await wait(p, 500);
  }
}

// Dashboard "Today" autopilot tab (lands here by default now)
await shot("01-today-autopilot", async (p) => {
  await p.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
  await wait(p, 1400);
});

// Fan page top — creator note mini-hero
await shot("02-fan-creator-note", async (p) => {
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await wait(p, 800); await gate(p); await wait(p, 600);
});

// Fan prize book expanded — scroll down and open it
await shot("03-fan-prizebook", async (p) => {
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await wait(p, 700); await gate(p);
  await p.getByRole("button", { name: /Prize book/i }).first().click().catch(()=>{});
  await wait(p, 500);
  await p.getByRole("button", { name: /Prize book/i }).first().scrollIntoViewIfNeeded().catch(()=>{});
  await wait(p, 500);
});

// Agency console (demo: shows 'no agency' state — that's correct without org data)
await shot("04-agency", async (p) => {
  await p.goto(`${B}/agency`, { waitUntil: "networkidle" });
  await wait(p, 900);
});

await browser.close();
console.log("DONE");
