import { chromium } from "playwright";
const B = "http://localhost:3214";
const OUT = "/tmp/shots2";
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
async function dismissGate(p) {
  const cbs = p.locator('input[type=checkbox]');
  if (await cbs.count()) {
    for (let i = 0; i < (await cbs.count()); i++) await cbs.nth(i).check().catch(()=>{});
    await p.getByRole("button", { name: /enter|spin|confirm|continue/i }).first().click().catch(()=>{});
    await wait(p, 500);
  }
}

await shot("01-topup-moment", async (p) => {
  for (let i = 0; i < 40; i++) {
    const r = await p.request.post(`${B}/api/spin`, { data: { token: "demo" } });
    const j = await r.json().catch(() => ({}));
    if (j.error) break;
  }
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await wait(p, 900); await dismissGate(p); await wait(p, 600);
});

await shot("02-safety-menu", async (p) => {
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await wait(p, 700); await dismissGate(p);
  await p.getByText(/Safety & privacy/i).first().click().catch(()=>{});
  await wait(p, 700);
});

await shot("03-sfw-linkinbio", async (p) => {
  await p.goto(`${B}/c/demo-creator`, { waitUntil: "networkidle" });
  await wait(p, 900);
});

await shot("04-crm-analytics", async (p) => {
  await p.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
  await wait(p, 800);
  await p.getByRole("button", { name: /^Analytics/ }).first().click().catch(()=>{});
  await wait(p, 1400);
});

await shot("05-boosts-linkinbio-editor", async (p) => {
  await p.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
  await wait(p, 700);
  await p.getByRole("button", { name: /^Boosts/ }).first().click().catch(()=>{});
  await wait(p, 1200);
});

await browser.close();
console.log("DONE");
