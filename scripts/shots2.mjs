import { chromium } from "playwright";
const B = "http://localhost:3212";
const OUT = "/tmp/shots";
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const browser = await chromium.launch();

// Age gate — fresh fan via a brand-new token won't exist; use demo but force the
// gate by checking for the dialog. The demo fan may already be acked from prior
// runs, so we assert + report rather than assume.
{
  const ctx = await browser.newContext(mobile);
  const p = await ctx.newPage();
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await p.waitForTimeout(700);
  const gate = p.getByRole("dialog");
  const hasGate = await gate.count();
  console.log("AGEGATE_VISIBLE:", hasGate > 0);
  await p.screenshot({ path: `${OUT}/02-fan-agegate.png` });
  await ctx.close();
}

// Win modal — dismiss gate, spin, WAIT for the modal heading explicitly.
{
  const ctx = await browser.newContext(mobile);
  const p = await ctx.newPage();
  await p.goto(`${B}/spin/demo`, { waitUntil: "networkidle" });
  await p.waitForTimeout(500);
  // dismiss age gate if present
  const cbs = p.locator('input[type=checkbox]');
  if (await cbs.count()) {
    for (let i = 0; i < (await cbs.count()); i++) await cbs.nth(i).check().catch(() => {});
    await p.getByRole("button", { name: /confirm|enter|continue|i('| a)m|let/i }).first().click().catch(() => {});
    await p.waitForTimeout(600);
  }
  await p.getByRole("button", { name: /^SPIN$/ }).click();
  // The modal shows "Awesome!" button + rarity badge after the wheel settles.
  await p.getByRole("button", { name: /awesome/i }).waitFor({ timeout: 12000 }).catch(() => {});
  await p.waitForTimeout(400);
  const modalUp = await p.getByRole("button", { name: /awesome/i }).count();
  console.log("WIN_MODAL_VISIBLE:", modalUp > 0);
  await p.screenshot({ path: `${OUT}/03-fan-win-modal.png` });
  await ctx.close();
}

await browser.close();
console.log("DONE2");
