import { randomUUID } from "node:crypto";
// RM-6: the fan's spend-awareness guardrail. "Your play" counts, a soft daily
// reminder that asks before the next spin, and a break the server enforces;
// then the creator's fan drawer, which shows only that the fan is on a break.
//
// Runs on its own fresh fan (no demo data needed) and before the first-run
// step, which wipes the demo account.

import { goto, clickTab, BASE } from "./harness.mjs";
import { createRevealFan } from "./reveal.mjs";

const REMINDER = 20;
// POST /api/spin allows 10 per 10s per token + IP; stay under it.
const SPIN_BATCH = 9;
const SPIN_WINDOW_MS = 10_500;

/** Spin `n` times through the API (not the page), respecting the rate limit. */
export async function spinViaApi(request, token, n) {
  for (let done = 0; done < n; ) {
    const batch = Math.min(SPIN_BATCH, n - done);
    for (let i = 0; i < batch; i++) {
      const res = await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token, clientSeed: `play-${done + i}` } });
      if (!res.ok()) throw new Error(`api spin ${done + i + 1} failed (${res.status()})`);
    }
    done += batch;
    if (done < n) await new Promise((r) => setTimeout(r, SPIN_WINDOW_MS));
  }
}

async function closeCard(page) {
  const card = page.getByTestId("reward-reveal");
  await card.waitFor({ timeout: 12000 });
  await page.getByRole("button", { name: "Awesome!" }).click();
  await card.waitFor({ state: "hidden", timeout: 4000 });
}

const spinButton = (page) => page.getByRole("button", { name: /^(SPIN|On a break|Spinning…|Out of spins)$/ }).first();

export async function playJourney(page, { step, assert }, ctx) {
  // Unique per run: e2e may run more than once against one server.
  const name = `Play Guard Fan ${Date.now().toString(36)}`;
  let token = null;
  let breakEnd = null;
  const counts = page.getByTestId("your-play-counts");

  await step("play: the fan sees their own counts under the spins chip", async () => {
    token = await createRevealFan(ctx.request, name, 30);
    await goto(page, `/spin/${token}`, 1600);
    await page.getByTestId("your-play").waitFor({ timeout: 8000 });
    assert((await counts.innerText()).trim() === "0 spins today · 0 this week", `counts read ${await counts.innerText()}`);
    const toggle = page.getByRole("button", { name: /^Your play/ });
    assert((await toggle.getAttribute("aria-expanded")) === "false", "the card starts collapsed");
  });

  await step(`play: the fan sets a daily reminder of ${REMINDER}`, async () => {
    await page.getByRole("button", { name: /^Your play/ }).click();
    // The radios are visually hidden inside their pill labels: click the pill.
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/fan/reminder") && r.request().method() === "POST", { timeout: 6000 }),
      page.locator("label").filter({ has: page.getByRole("radio", { name: String(REMINDER) }) }).click(),
    ]);
    assert(res.ok(), `the reminder saves (${res.status()})`);
    assert((await res.json()).reminder === REMINDER, "the server echoes the reminder");
    await page.getByText(`after ${REMINDER} spins a day`).waitFor({ timeout: 3000 });
    assert(await page.getByRole("radio", { name: String(REMINDER) }).isChecked(), "the choice stays selected");
  });

  await step(`play: after ${REMINDER} spins today, the next SPIN asks first (equal-weight choices)`, async () => {
    await spinViaApi(ctx.request, token, REMINDER);
    await goto(page, `/spin/${token}`, 1600);
    assert((await counts.innerText()).startsWith(`${REMINDER} spins today`), `the server counted them (${await counts.innerText()})`);
    let spinRequests = 0;
    const onReq = (r) => {
      if (r.url().endsWith("/api/spin") && r.method() === "POST") spinRequests++;
    };
    page.on("request", onReq);
    await spinButton(page).click();
    const card = page.getByTestId("breather-card");
    await card.waitFor({ timeout: 4000 });
    await page.waitForTimeout(300);
    page.off("request", onReq);
    assert(spinRequests === 0, "the tap did not spin");
    assert((await card.getByRole("heading").innerText()).includes(`You've played ${REMINDER} spins today`), "the card names the count");
    assert(/prizes are saved/i.test(await card.innerText()), "and reassures that prizes are saved");
    const keep = card.getByRole("button", { name: "Keep playing" });
    const brk = card.getByRole("button", { name: "Take a break" });
    assert((await keep.getAttribute("class")) === (await brk.getAttribute("class")), "Keep playing and Take a break look the same");
    const focused = await page.evaluate(() => document.activeElement?.closest("[data-testid='breather-card']") !== null);
    assert(focused, "focus moved into the card");
  });

  await step("play: Keep playing spins at once, and the card doesn't return today", async () => {
    const resp = page.waitForResponse((r) => r.url().endsWith("/api/spin") && r.request().method() === "POST");
    await page.getByTestId("breather-card").getByRole("button", { name: "Keep playing" }).click();
    const body = await (await resp).json();
    assert(body.reminderDue === true && body.play?.today === REMINDER + 1, `the spin went through (${JSON.stringify(body.play)})`);
    await closeCard(page);
    assert((await counts.innerText()).startsWith(`${REMINDER + 1} spins today`), "the counts moved without a reload");
    const next = page.waitForResponse((r) => r.url().endsWith("/api/spin") && r.request().method() === "POST", { timeout: 4000 });
    await spinButton(page).click();
    assert((await next).ok(), "the next tap spins straight away");
    assert((await page.getByTestId("breather-card").count()) === 0, "no card the second time today");
    await closeCard(page);
  });

  await step("play: taking a 24-hour break turns SPIN off and says until when", async () => {
    await page.getByRole("button", { name: /^Your play/ }).click();
    await page.getByRole("button", { name: "24 hours" }).click();
    const confirm = page.getByTestId("break-confirm");
    await confirm.waitFor({ timeout: 3000 });
    assert(/can.t be ended early/i.test(await confirm.innerText()), "the confirm step says it can't be shortened");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/fan/break") && r.request().method() === "POST");
    await confirm.getByRole("button", { name: "Start my break" }).click();
    const res = await saved;
    assert(res.ok(), `the break starts (${res.status()})`);
    const { breakUntil } = await res.json();
    breakEnd = breakUntil;
    const hours = (Date.parse(breakUntil) - Date.now()) / 3_600_000;
    assert(hours > 23.5 && hours <= 24, `it ends in 24 hours (${hours.toFixed(2)}h)`);
    const btn = spinButton(page);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "On a break" && b.disabled), null, { timeout: 4000 });
    assert(await btn.isDisabled(), "SPIN is disabled");
    const status = await page.getByTestId("break-status").innerText();
    assert(/taking a break until .+\. Your spins and prizes are safe\./.test(status), `the status names the end (${status})`);
    assert((await page.getByTestId("install-nudge").count()) === 0, "no install nudge while on a break (F6)");
  });

  await step("play: the server refuses spins during the break (403 on_break), across reloads", async () => {
    const res = await ctx.request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token, clientSeed: "on-break" } });
    assert(res.status() === 403, `POST /api/spin is 403 (${res.status()})`);
    assert((await res.json()).error === "on_break", "with on_break");
    const again = await ctx.request.post(BASE + "/api/fan/break", { data: { token, duration: "24h" } });
    assert(again.ok(), "asking again is accepted");
    assert(Date.parse((await again.json()).breakUntil) >= Date.parse(breakEnd), "and never ends the break earlier");
    await goto(page, `/spin/${token}`, 1600);
    assert(await spinButton(page).isDisabled(), "SPIN is still off after a reload");
    await page.getByTestId("break-status").waitFor({ timeout: 4000 });
  });

  await step("play: the creator's drawer shows only 'On a break' and turns off top-up and Copy DM", async () => {
    await goto(page, "/dashboard", 1800);
    await clickTab(page, "Fans");
    await page.getByRole("button", { name: `View ${name}` }).first().click();
    const drawer = page.getByRole("dialog", { name: "Fan details" });
    await drawer.waitFor({ timeout: 6000 });
    const badge = drawer.getByTestId("fan-on-break");
    await badge.waitFor({ timeout: 6000 });
    assert(/^On a break until /.test(await badge.innerText()), `the badge reads ${await badge.innerText()}`);
    assert(await drawer.getByRole("button", { name: "Top up spins" }).isDisabled(), "Top up is off");
    assert(await drawer.getByRole("button", { name: /^Copy DM/ }).isDisabled(), "Copy DM is off");
    assert(/Paused by the fan/.test(await drawer.innerText()), "and says the fan paused it");
    const text = await drawer.innerText();
    assert(!new RegExp(`${REMINDER} spins a day|reminder`, "i").test(text), "the fan's reminder is never shown to the creator");
    await page.keyboard.press("Escape");
  });
}
