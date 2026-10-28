import { randomUUID } from "node:crypto";
// RM-5 win-back: the Analytics win-back card, "Start win-back" queue (Copy &
// next / Skip / Snooze), snoozed and contacted fans leaving the list, "Came
// back" after a spin, plus the Fans tab never copying a paused link.
//
// Setup makes its own paying fans through the creator API and moves their
// activity 20 days back with the demo-only /api/debug/age-fan route (a debug
// build without Supabase), so nothing depends on other journeys' data.

import { acknowledgeFixtureFan, goto, clickTab, BASE } from "./harness.mjs";

async function json(res, what) {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()})`);
  return res.json();
}

/** A paying fan who won once, then went quiet `days` ago. */
export async function quietSpender(request, name, dollars, days = 20) {
  const { token, fanId } = await json(
    await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 3, amountDollars: dollars } }),
    `create ${name}`,
  );
  await json(await acknowledgeFixtureFan(request, token), `ack ${name}`);
  await json(await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token, clientSeed: "winback" } }), `spin ${name}`);
  if (days > 0) {
    await json(await request.post(BASE + "/api/debug/age-fan", { data: { fanId, days } }), `age ${name}`);
  }
  return { name, token, fanId };
}

async function openWinbackCard(page) {
  await goto(page, "/dashboard", 1600);
  await clickTab(page, "Analytics");
  const card = page.getByTestId("winback-card");
  await card.waitFor({ timeout: 10000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

const rowNames = (card) => card.getByTestId("winback-row").locator("span.truncate").allInnerTexts();

export async function winbackJourney(page, { step, assert }, ctx) {
  const tag = Math.random().toString(36).slice(2, 6);
  let ava, bo, cy;
  const queue = page.getByRole("dialog", { name: "Win-back queue" });
  const progress = page.getByTestId("winback-progress");

  await step("win-back (setup): three paying fans who went quiet 20 days ago", async () => {
    ava = await quietSpender(ctx.request, `WB Ava ${tag}`, 30);
    bo = await quietSpender(ctx.request, `WB Bo ${tag}`, 25);
    cy = await quietSpender(ctx.request, `WB Cy ${tag}`, 20);
  });

  await step("win-back: the card lists quiet spenders, highest spend first, with Copy DM", async () => {
    const card = await openWinbackCard(page);
    await card.getByTestId("winback-row").first().waitFor({ timeout: 8000 });
    const names = await rowNames(card);
    const mine = names.filter((n) => n.endsWith(tag));
    assert(mine.join("|") === [ava.name, bo.name, cy.name].join("|"), `rows are highest spend first (got ${mine.join(", ")})`);
    assert((await card.getByRole("button", { name: `Copy DM for ${ava.name}` }).count()) === 1, "each row has Copy DM");
    assert((await card.getByRole("button", { name: `Copy link for ${ava.name}` }).count()) === 1, "…and keeps Copy link");
  });

  await step("win-back: Start opens the queue on the first fan with a filled message", async () => {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
    await page.getByRole("button", { name: "Start win-back" }).click();
    await queue.waitFor({ timeout: 5000 });
    assert(/^Fan 1 of \d+$/.test(await progress.innerText()), "the queue shows its position");
    assert((await page.getByTestId("winback-fan").innerText()) === ava.name, "the top spender comes first");
    const preview = await page.getByTestId("winback-preview").innerText();
    assert(preview.includes(ava.name), "the message is filled with the fan's name");
    assert(preview.includes(`/spin/${ava.token}`), "…and their active spin link");
    assert(/You paste it into your own DMs/.test(await queue.innerText()), "the sheet says FanFunnel sends nothing");
  });

  await step("win-back: Copy & next copies the message, marks the fan and moves on", async () => {
    const preview = await page.getByTestId("winback-preview").innerText();
    await page.getByRole("button", { name: "Copy & next" }).click();
    await page.waitForFunction(() => /^Fan 2 of/.test(document.querySelector("[data-testid='winback-progress']")?.textContent ?? ""));
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (copied !== null) assert(copied === preview, "the clipboard holds exactly the previewed message");
    assert((await page.getByTestId("winback-fan").innerText()) === bo.name, "the next fan is up");
  });

  await step("win-back: Skip moves on, Snooze hides the fan, the queue ends with a tally", async () => {
    await page.getByRole("button", { name: "Skip" }).click();
    await page.waitForFunction(() => /^Fan 3 of/.test(document.querySelector("[data-testid='winback-progress']")?.textContent ?? ""));
    assert((await page.getByTestId("winback-fan").innerText()) === cy.name, "skip moves to the next fan");
    const snoozed = page.waitForResponse((r) => r.url().endsWith("/api/crm/outreach") && r.request().method() === "POST");
    await page.getByRole("button", { name: /^Snooze \d+d$/ }).click();
    assert((await snoozed).ok(), "the snooze is saved");
    const done = page.getByTestId("winback-done");
    await done.waitFor({ timeout: 4000 });
    assert(/1 copied · 1 snoozed · 1 skipped/.test(await done.innerText()), "the tally counts each action");
    await done.getByRole("button", { name: "Close" }).click();
    await queue.waitFor({ state: "hidden", timeout: 4000 });
  });

  await step("win-back: contacted and snoozed fans leave the list; the skipped one stays", async () => {
    const card = page.getByTestId("winback-card");
    await page.waitForFunction(
      (n) => ![...document.querySelectorAll("[data-testid='winback-row']")].some((li) => li.textContent.includes(n)),
      ava.name,
      { timeout: 8000 },
    );
    const names = await rowNames(card);
    assert(!names.includes(ava.name), "the contacted fan is off the list");
    assert(!names.includes(cy.name), "the snoozed fan is off the list");
    assert(names.includes(bo.name), "the skipped fan is still there");
    assert(/1 contacted · 0 came back/.test(await card.getByTestId("winback-stats").innerText()), "the card counts the contact");
    const recent = card.getByTestId("winback-recent");
    assert(/Contacted today/.test(await recent.innerText()) && (await recent.innerText()).includes(ava.name), "recently contacted shows the fan");
  });

  await step("win-back: a contacted fan who spins again shows 'Came back'", async () => {
    await json(await ctx.request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: ava.token, clientSeed: "back" } }), "spin again");
    const card = await openWinbackCard(page);
    const recent = card.getByTestId("winback-recent");
    await recent.waitFor({ timeout: 8000 });
    const row = recent.locator("li", { hasText: ava.name });
    assert(/Came back ✓/.test(await row.innerText()), "the fan's row says Came back");
    assert(/1 contacted · 1 came back/.test(await card.getByTestId("winback-stats").innerText()), "the stat counts them");
  });

  await step("win-back: Escape closes the queue and focus returns; no overflow at 360px", async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    try {
      const start = page.getByRole("button", { name: "Start win-back" });
      await start.scrollIntoViewIfNeeded();
      await start.click();
      await queue.waitFor({ timeout: 5000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 0, `no horizontal overflow at 360px (got ${overflow}px)`);
      await page.keyboard.press("Escape");
      await queue.waitFor({ state: "hidden", timeout: 4000 });
      assert(await start.evaluate((el) => el === document.activeElement), "focus returns to Start win-back");
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  });

  await step("fans: Copy link never hands out a paused link", async () => {
    const paused = await quietSpender(ctx.request, `WB Paused ${tag}`, 10, 0);
    await json(await ctx.request.post(BASE + "/api/self-exclude", { data: { token: paused.token } }), "self-exclude");
    await goto(page, "/dashboard", 1600);
    await clickTab(page, "Fans");
    const copy = page.getByRole("button", { name: `Copy spin link for ${paused.name}` });
    await copy.waitFor({ timeout: 8000 });
    await copy.click();
    await page.getByText(/paused their link/).first().waitFor({ timeout: 4000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    assert(copied === null || !copied.includes(paused.token), "the paused link was not copied");
  });
}
