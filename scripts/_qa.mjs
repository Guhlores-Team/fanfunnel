import { chromium } from "playwright";
const B = "http://localhost:3221", OUT = "/tmp/qa";
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const browser = await chromium.launch();
const ctx = await browser.newContext(mobile);
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const tab = async (name) => { await page.getByRole("button", { name, exact: true }).click().catch(()=>{}); await wait(900); };
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log("  ✓", n); };

await page.goto(`${B}/dashboard`, { waitUntil: "networkidle" });
await wait(1300);
await shot("01-today");

// Wheel editor: auto-odds (tickets + live %), then scroll to library
await tab("Wheel");
await shot("02-wheel-editor");
// change a rarity to show auto-weight; pick the first rarity select
const sel = page.locator('select').first();
await sel.scrollIntoViewIfNeeded().catch(()=>{});
await wait(400);
await shot("03-wheel-odds");

// Fans: price field + create form alignment
await tab("Fans");
await shot("04-fans-create");
// scroll to an account card to show top-up campaign default + links
await page.getByText(/spins left/i).first().scrollIntoViewIfNeeded().catch(()=>{});
await wait(500);
await shot("05-fan-account-card");

// Campaigns: rename/delete + new metrics
await tab("Campaigns");
await wait(600);
await page.getByText(/Play-through/i).first().scrollIntoViewIfNeeded().catch(()=>{});
await wait(500);
await shot("06-campaign-metrics");

// Fulfilment: search + pagination
await tab("Prizes");
await wait(800);
await shot("07-fulfilment");
await page.locator('input[placeholder*="Search by fan"]').fill("costume").catch(()=>{});
await wait(700);
await shot("08-fulfilment-search");

// Analytics: profit summary + % of revenue
await tab("Analytics");
await wait(900);
await page.getByText(/Profit & prize costs/i).first().scrollIntoViewIfNeeded().catch(()=>{});
await wait(600);
await shot("09-profit");

// Boosts: public link (no overflow) + danger zone
await tab("Boosts");
await wait(700);
await shot("10-boosts-link");
await page.getByText(/Danger zone/i).first().scrollIntoViewIfNeeded().catch(()=>{});
await wait(500);
await shot("11-danger-zone");

// Metrics
await tab("Metrics");
await wait(700);
await shot("12-metrics");

// Fan spin page: wins gallery, creator note, no referrals
const fan = await ctx.newPage();
await fan.setViewportSize({ width: 390, height: 844 });
await fan.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
await fan.waitForTimeout(800);
const cbs = fan.locator('input[type=checkbox]'); for (let i=0;i<await cbs.count();i++) await cbs.nth(i).check().catch(()=>{});
await fan.getByRole("button", { name: "Enter & spin" }).click().catch(()=>{});
await fan.waitForTimeout(1200);
await fan.screenshot({ path: `${OUT}/13-fan-top.png` }); console.log("  ✓ 13-fan-top");
// scroll to wins/chat
await fan.evaluate(() => window.scrollBy(0, 700));
await fan.waitForTimeout(500);
await fan.screenshot({ path: `${OUT}/14-fan-wins.png` }); console.log("  ✓ 14-fan-wins");
await fan.close();

await browser.close();
console.log("QA capture done");
