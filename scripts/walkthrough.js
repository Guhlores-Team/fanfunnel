// End-to-end visual walkthrough of FanFunnel.
// Drives the app like a real user and screenshots each step.
const { chromium } = require("playwright");
const fs = require("fs");

const OUT = "/tmp/ff-shots";
const BASE = "http://localhost:3000";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const log = (m) => console.log("  " + m);
  let step = 0;
  const shot = async (name) => {
    step++;
    const file = `${OUT}/${String(step).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    log(`📸 ${file}`);
  };

  // 1. Landing page
  console.log("\n=== 1. LANDING PAGE ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  log("title: " + (await page.title()));
  await shot("landing");

  // 2. Fan demo wheel — spin it
  console.log("\n=== 2. FAN WHEEL (/spin/demo) ===");
  await page.goto(`${BASE}/spin/demo`, { waitUntil: "networkidle" });
  const spinsBefore = await page.locator("text=/Spins left/").first().textContent();
  log("before: " + spinsBefore.trim());
  await shot("fan-wheel-initial");
  // Click SPIN
  const spinBtn = page.getByRole("button", { name: /SPIN/i }).first();
  await spinBtn.click();
  log("clicked SPIN, waiting for animation…");
  await page.waitForTimeout(5200); // wheel spin is ~4.4s + reveal
  await shot("fan-wheel-prize-reveal");
  // Close the prize modal if present
  const awesome = page.getByRole("button", { name: /Awesome/i });
  if (await awesome.count()) {
    await awesome.click();
    log("closed prize modal");
  }
  await page.waitForTimeout(500);
  const spinsAfter = await page.locator("text=/Spins left/").first().textContent();
  log("after: " + spinsAfter.trim());
  await shot("fan-wheel-after-spin");

  // 3. Creator dashboard — wheel editor
  console.log("\n=== 3. DASHBOARD — WHEEL EDITOR ===");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await shot("dashboard-editor");
  // Edit the title
  const titleInput = page.locator('input').first();
  await titleInput.fill("Bella's VIP Wheel");
  log("changed title → Bella's VIP Wheel");
  await page.waitForTimeout(300);
  await shot("dashboard-editor-edited");
  // Save
  const saveBtn = page.getByRole("button", { name: /Save wheel/i });
  await saveBtn.click();
  await page.waitForTimeout(800);
  log("clicked Save wheel");
  await shot("dashboard-editor-saved");

  // 4. Fans & links tab
  console.log("\n=== 4. DASHBOARD — FANS & LINKS ===");
  await page.getByRole("button", { name: /Fans & links/i }).click();
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="@bigfan"]').fill("BigSpender");
  log("entered fan name BigSpender");
  await page.getByRole("button", { name: /Create account/i }).click();
  await page.waitForTimeout(800);
  log("created fan account + link");
  await shot("dashboard-fans");

  // 5. Prizes inbox
  console.log("\n=== 5. DASHBOARD — PRIZES INBOX ===");
  await page.getByRole("button", { name: /Prizes/i }).click();
  await page.waitForTimeout(800);
  await shot("dashboard-prizes-inbox");
  // Try to fulfil the first pending prize
  const fulfil = page.getByRole("button", { name: /Fulfilled/i }).first();
  if (await fulfil.count()) {
    await fulfil.click();
    await page.waitForTimeout(600);
    log("marked first prize fulfilled");
    await shot("dashboard-prizes-fulfilled");
  } else {
    log("(no pending prizes shown)");
  }

  // 6. Metrics
  console.log("\n=== 6. DASHBOARD — METRICS ===");
  await page.getByRole("button", { name: /Metrics/i }).click();
  await page.waitForTimeout(800);
  await shot("dashboard-metrics");

  // 7. Admin panel
  console.log("\n=== 7. ADMIN PANEL ===");
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot("admin-panel");
  // Suspend the first creator (Bella)
  const suspend = page.getByRole("button", { name: /^Suspend$/i }).first();
  if (await suspend.count()) {
    await suspend.click();
    await page.waitForTimeout(600);
    log("suspended a creator account");
    await shot("admin-suspended");
  }
  // Open the New creator modal
  await page.getByRole("button", { name: /New creator/i }).click();
  await page.waitForTimeout(400);
  await shot("admin-new-creator-modal");

  console.log("\n✅ WALKTHROUGH COMPLETE — " + step + " screenshots in " + OUT);
  await browser.close();
})().catch((e) => {
  console.error("WALKTHROUGH ERROR:", e.message);
  process.exit(1);
});
