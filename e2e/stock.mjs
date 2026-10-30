// RM-2: stock shown to fans ("3 left") and the creator's "Show stock to fans"
// switch, plus the near-miss / win-card layout on phones.
//
// Setup puts the demo wheel in a known state through the creator API (one
// limited epic that every spin wins, a sold-out legendary) and the `finally`
// puts the creator's wheel back, so later journeys see what they expect.

import { goto, clickTab, BASE } from "./harness.mjs";
import { createRevealFan, spinAndTime, clearForcedRarity } from "./reveal.mjs";

const SOLD_OUT = "Claimed ✨";
/** A JSON key "stock" with a number, raw or escaped inside the page's serialized props. */
const STOCK_COUNT = /\\?"stock\\?"\s*:\s*-?\d/;

async function getWheel(request) {
  const res = await request.get(BASE + "/api/wheel");
  if (!res.ok()) throw new Error(`creator wheel did not load (${res.status()})`);
  return (await res.json()).wheel;
}
async function putWheel(request, wheel) {
  const res = await request.put(BASE + "/api/wheel", { data: { wheel } });
  if (!res.ok()) throw new Error(`wheel did not save (${res.status()})`);
  return (await res.json()).wheel;
}

/** Spin once, wait for the card, return the /api/spin JSON the page received. */
async function spinForCard(page) {
  const resp = page.waitForResponse((r) => r.url().includes("/api/spin") && r.request().method() === "POST");
  await spinAndTime(page);
  const body = await (await resp).json();
  await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
  return body;
}
async function closeCard(page) {
  const card = page.getByTestId("reward-reveal");
  await page.getByRole("button", { name: "Awesome!" }).click();
  await card.waitFor({ state: "hidden", timeout: 4000 });
}

async function setSwitchInEditor(page, on, { assert }) {
  await goto(page, "/dashboard", 1800);
  await clickTab(page, "Wheel");
  const sw = page.getByRole("switch", { name: "Show stock to fans" });
  await sw.waitFor({ timeout: 8000 });
  if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click();
  assert((await sw.getAttribute("aria-checked")) === String(on), `the switch reads ${on ? "on" : "off"}`);
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/wheel") && r.request().method() === "PUT");
  await page.getByRole("button", { name: /^Save game$/ }).click();
  assert((await saved).ok(), "the wheel saves");
  await page.waitForFunction(() => !/unsaved changes|saving…/i.test(document.body.innerText)).catch(() => {});
}

export async function stockJourney(page, { step, assert }, ctx) {
  let original = null;
  let epic = null; // the limited prize every spin wins
  let legendary = null; // sold out
  let token = null;
  const chip = (label) => page.getByTestId("stock-chip").filter({ hasText: label });

  try {
    await step("stock (setup): a limited epic (9 left) and a sold-out legendary", async () => {
      original = await getWheel(ctx.request);
      const prizes = original.prizes.map((p) => ({ ...p }));
      const e = prizes.find((p) => p.rarity === "epic");
      const l = prizes.find((p) => p.rarity === "legendary");
      assert(e && l, "the demo wheel has an epic and a legendary prize");
      for (const p of prizes) {
        p.stock = null;
        p.weight = 0;
      }
      Object.assign(e, { stock: 9, weight: 100 });
      Object.assign(l, { stock: 0, weight: 1 });
      const saved = await putWheel(ctx.request, { ...original, prizes, showStock: true });
      epic = saved.prizes.find((p) => p.rarity === "epic");
      legendary = saved.prizes.find((p) => p.rarity === "legendary");
      assert(epic.stock === 9 && legendary.stock === 0, "the creator's wheel holds the real counts");
    });

    await step("stock: the creator sees 'Show stock to fans', on by default", async () => {
      await goto(page, "/dashboard", 1800);
      await clickTab(page, "Wheel");
      const sw = page.getByRole("switch", { name: "Show stock to fans" });
      await sw.waitFor({ timeout: 8000 });
      assert((await sw.getAttribute("aria-checked")) === "true", "the switch is on");
      const hint = await sw.getAttribute("aria-describedby");
      assert(hint && /claimed/i.test(await page.locator(`[id="${hint}"]`).innerText()), "the switch explains what fans see");
    });

    await step("stock: the fan page shows the real count and 'Claimed' when gone", async () => {
      token = await createRevealFan(ctx.request, "Stock Fan", 8);
      await goto(page, `/spin/${token}`, 1600);
      const row = page.getByTestId("limited-stock");
      await row.waitFor({ timeout: 8000 });
      assert(/9 left/.test(await chip(epic.label).innerText()), `the epic reads "9 left"`);
      assert((await chip(legendary.label).innerText()).includes(SOLD_OUT), "the sold-out legendary reads Claimed");
      assert((await chip(legendary.label).getAttribute("data-sold-out")) === "true", "and is marked sold out");
      await page.getByRole("button", { name: /Prize book/ }).click();
      const book = await page.getByTestId("prize-book-item").allInnerTexts();
      assert(book.some((t) => /9 left/.test(t)) && book.some((t) => t.includes(SOLD_OUT)), "the prize book agrees");
      await page.getByRole("button", { name: /Prize book/ }).click();
    });

    await step("stock: winning it drops the count without a reload, never before the wheel stops", async () => {
      const resp = page.waitForResponse((r) => r.url().includes("/api/spin") && r.request().method() === "POST");
      // If the spin click throws, `resp` must not reject unhandled and kill the run.
      resp.catch(() => {});
      await spinAndTime(page);
      const body = await (await resp).json();
      assert(body.prize?.id === epic.id, "the server awarded the limited epic");
      assert(body.stock?.[epic.id]?.stock === 8, `the spin response carries the live count (${JSON.stringify(body.stock)})`);
      assert(/9 left/.test(await chip(epic.label).innerText()), "the count holds while the wheel turns (no spoiler)");
      await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
      await page.waitForFunction((l) => [...document.querySelectorAll("[data-testid='stock-chip']")].some((c) => c.textContent.includes(l) && /8 left/.test(c.textContent)), epic.label, { timeout: 4000 }).catch(() => {});
      assert(/8 left/.test(await chip(epic.label).innerText()), "the chip now reads 8 left");
      await closeCard(page);
    });

    // Near miss: land (in the browser only) on a slice next to the in-stock
    // epic. The server still decides and records the spin.
    const forceNearMiss = async (pity = false) => {
      const api = await (await ctx.request.get(BASE + "/api/public/wheel/demo-creator")).json();
      const prizes = api.wheel.prizes;
      const at = prizes.findIndex((p) => p.id === epic.id);
      const n = prizes.length;
      const landed = [(at - 1 + n) % n, (at + 1) % n].find((i) => prizes[i].rarity !== "legendary");
      await page.unroute("**/api/spin").catch(() => {});
      await page.route("**/api/spin", async (route) => {
        const res = await route.fetch();
        const json = await res.json().catch(() => null);
        if (json && json.prize) {
          json.prizeIndex = landed;
          json.prize = prizes[landed];
          json.pityAwarded = pity;
        }
        await route.fulfill({ response: res, json: json ?? {} });
      });
    };
    const noOverlap = async (label, testId) => {
      const beat = page.getByTestId(testId);
      await beat.waitFor({ timeout: 4000 });
      await page.waitForTimeout(350);
      const b = await beat.locator(":scope > *").first().boundingBox();
      const c = await page.getByRole("dialog", { name: /^You won / }).boundingBox();
      assert(b && c, `${label}: both are on screen`);
      assert(b.y + b.height <= c.y + 0.5, `${label}: the popup ends (${Math.round(b.y + b.height)}) above the card (${Math.round(c.y)})`);
      assert(b.y >= 0, `${label}: the popup is not cut off at the top (${Math.round(b.y)})`);
    };

    await step("near miss: 'So close!' never overlaps the win card at 360 and 390", async () => {
      const viewport = page.viewportSize();
      try {
        await forceNearMiss(false);
        for (const vp of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
          await page.setViewportSize(vp);
          await spinForCard(page);
          await noOverlap(`${vp.width}x${vp.height}`, "near-miss-beat");
          assert((await page.getByTestId("pity-beat").count()) === 0, "no pity beat on a normal spin");
          await closeCard(page);
        }
      } finally {
        await clearForcedRarity(page);
        await page.setViewportSize(viewport);
      }
    });

    await step("near miss: a pity win shows 'Guaranteed rare!' instead (precedence kept), also clear of the card", async () => {
      const viewport = page.viewportSize();
      try {
        await forceNearMiss(true);
        await page.setViewportSize({ width: 360, height: 800 });
        await spinForCard(page);
        await noOverlap("pity 360x800", "pity-beat");
        assert((await page.getByTestId("near-miss-beat").count()) === 0, "pity takes precedence over the near miss");
        await closeCard(page);
      } finally {
        await clearForcedRarity(page);
        await page.setViewportSize(viewport);
      }
    });

    await step("stock: the creator turns 'Show stock to fans' off", async () => {
      await setSwitchInEditor(page, false, { assert });
      const w = await getWheel(ctx.request);
      assert(w.showStock === false, "the switch is saved off");
    });

    await step("stock: with the switch off no count reaches the fan (page, spin, public API)", async () => {
      await goto(page, `/spin/${token}`, 1600);
      assert((await page.getByTestId("limited-stock").count()) === 0, "no Limited row");
      await page.getByRole("button", { name: /Prize book/ }).click();
      const book = (await page.getByTestId("prize-book-item").allInnerTexts()).join(" | ");
      assert(!/\d+ left/.test(book), `the prize book shows no count (${book})`);
      assert(book.includes(SOLD_OUT), "a sold-out prize still reads Claimed (0% odds)");
      await page.getByRole("button", { name: /Prize book/ }).click();

      const html = await (await ctx.request.get(BASE + `/spin/${token}`)).text();
      assert(/\\?"prizes\\?"\s*:/.test(html), "the fan page payload carries the prizes");
      assert(!STOCK_COUNT.test(html), "fan page payload: no stock count");
      const api = await (await ctx.request.get(BASE + "/api/public/wheel/demo-creator")).text();
      assert(/"prizes"\s*:\s*\[\s*\{/.test(api), "the public wheel API lists prizes");
      assert(!STOCK_COUNT.test(api), "public wheel API: no stock count");
      assert(/"soldOut"\s*:\s*true/.test(api), "public wheel API: the sold-out prize is still flagged");
      const body = await spinForCard(page);
      assert(!STOCK_COUNT.test(JSON.stringify(body)), `spin response: no stock count (${JSON.stringify(body.stock)})`);
      assert(body.prize && !("stock" in body.prize), "spin response: the won prize has no stock key");
      await closeCard(page);
      assert((await page.getByTestId("limited-stock").count()) === 0, "still no count after the spin");
    });

    await step("stock: switching it back on shows the live count again", async () => {
      await setSwitchInEditor(page, true, { assert });
      await goto(page, `/spin/${token}`, 1600);
      await page.getByTestId("limited-stock").waitFor({ timeout: 8000 });
      const live = (await getWheel(ctx.request)).prizes.find((p) => p.id === epic.id).stock;
      assert(new RegExp(`\\b${live} left`).test(await chip(epic.label).innerText()), `the chip reads the live "${live} left"`);
    });
  } finally {
    await clearForcedRarity(page);
    if (original) await putWheel(ctx.request, { ...original, showStock: true }).catch(() => {});
  }
}
