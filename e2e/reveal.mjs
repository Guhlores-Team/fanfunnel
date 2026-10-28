// RM-1 reveal theater: the rarity-tiered win reveal on the fan page.
//
// The rarity under test is forced by rewriting only the `prize.rarity` of the
// REAL /api/spin response in the browser: the server still decides and records
// the spin, the request is untouched, and the wheel still lands on the slice
// the server picked. The theater reads nothing else, so this exercises exactly
// what a fan who won that rarity would see.

import { acknowledgeFixtureFan, goto, BASE } from "./harness.mjs";

const SPIN_MS = 4400;
const MAX_THEATER_EXTRA_MS = 1500;
// Proposal budget: the card is up within 4.4s + 1.5s + 0.5s of the result.
const REVEAL_BUDGET_MS = SPIN_MS + MAX_THEATER_EXTRA_MS + 500;

export async function forceRarity(page, rarity) {
  await page.unroute("**/api/spin").catch(() => {});
  await page.route("**/api/spin", async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (body && body.prize) body.prize = { ...body.prize, rarity };
    await route.fulfill({ response: res, json: body ?? {} });
  });
}

export async function clearForcedRarity(page) {
  await page.unroute("**/api/spin").catch(() => {});
}

/** A fresh fan (own spins, gate already acknowledged) so no other journey's data is needed. */
export async function createRevealFan(request, name = "Reveal Fan", spins = 4) {
  const created = await request.post(BASE + "/api/passes", { data: { name, spins } });
  if (!created.ok()) throw new Error(`could not create a fan (${created.status()})`);
  const { token } = await created.json();
  const ack = await acknowledgeFixtureFan(request, token);
  if (!ack.ok()) throw new Error(`could not acknowledge the age gate (${ack.status()})`);
  return token;
}

/** Click SPIN and resolve with the time the server's result reached the page. */
export async function spinAndTime(page) {
  const resp = page.waitForResponse((r) => r.url().includes("/api/spin") && r.request().method() === "POST");
  // If the click throws, `resp` later rejects un-awaited and the unhandled
  // rejection kills the whole e2e run instead of failing this one step.
  resp.catch(() => {});
  await page.getByRole("button", { name: /^SPIN/ }).first().click();
  await resp;
  return Date.now();
}

async function closeReveal(page) {
  const card = page.getByTestId("reward-reveal");
  await page.getByRole("button", { name: "Awesome!" }).click();
  await card.waitFor({ state: "hidden", timeout: 4000 });
}

export async function revealJourney(page, { step, assert }, ctx) {
  const card = page.getByTestId("reward-reveal");
  const theater = page.getByTestId("reveal-theater");
  const skip = page.getByTestId("reveal-skip");
  let token = null;

  try {
    await step("reveal: a legendary win builds up, then opens the legendary reveal", async () => {
      token = await createRevealFan(ctx.request);
      await goto(page, `/spin/${token}`, 1600);
      // A fresh browser session: the first spin plays in full (no Skip yet).
      await page.evaluate(() => sessionStorage.removeItem("ff:reveal:spins"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /^SPIN/ }).first().waitFor({ timeout: 10000 });
      await forceRarity(page, "legendary");

      const t0 = await spinAndTime(page);
      await theater.waitFor({ state: "visible", timeout: SPIN_MS + 1500 });
      assert((await theater.getAttribute("data-tier")) === "legendary", "the build-up is the legendary one");
      assert((await skip.count()) === 0, "no Skip on the first spin of a session");
      const built = Date.now() - t0;
      assert(built >= SPIN_MS - 1500, `the build-up starts near the stop, not at once (${built}ms)`);

      await card.waitFor({ state: "visible", timeout: REVEAL_BUDGET_MS + 2000 });
      const took = Date.now() - t0;
      assert(took <= REVEAL_BUDGET_MS, `the reveal is up within ${REVEAL_BUDGET_MS}ms of the result (took ${took}ms)`);
      assert(took >= SPIN_MS, `the legendary reveal waits for the wheel to stop (took ${took}ms)`);
      assert((await card.getAttribute("data-tier")) === "legendary", "the card is the legendary tier");
      assert((await card.getAttribute("data-entrance")) === "animated", "a normal win gets the animated entrance");
      assert((await theater.count()) === 0, "the dim lifts once the card is open");
      const dialog = page.getByRole("dialog", { name: /^You won / });
      assert(await dialog.isVisible(), "the card is an accessible dialog");
      const share = dialog.getByRole("button", { name: /Share your win/ });
      assert(await share.count(), "the card offers Share");
      assert(
        await share.evaluate((el) => el === document.activeElement && el.classList.contains("btn-brand")),
        "Share is the primary, focused button on a legendary"
      );
      await closeReveal(page);
    });

    await step("reveal: tap-to-skip lands on the final state", async () => {
      await forceRarity(page, "epic");
      const t0 = await spinAndTime(page);
      await skip.waitFor({ state: "visible", timeout: 3000 });
      assert(Date.now() - t0 < SPIN_MS, "Skip is offered while the wheel is still turning");
      const clicked = Date.now();
      await skip.click();
      await card.waitFor({ state: "visible", timeout: 2000 });
      const took = Date.now() - clicked;
      assert(took < 1500, `skip opens the card at once (took ${took}ms)`);
      assert((await card.getAttribute("data-tier")) === "epic", "the skipped card still shows the real rarity");
      assert((await card.getAttribute("data-entrance")) === "static", "a skip lands on the final, static card");
      assert((await page.getByTestId("reveal-confetti").count()) === 0, "no confetti after a skip");
      assert((await skip.count()) === 0 && (await theater.count()) === 0, "Skip and the dim are gone");
      assert(
        (await page.locator("[aria-label^='Prize wheel with']").getAttribute("aria-busy")) === "false",
        "the wheel has stopped on the result"
      );
      await closeReveal(page);
    });

    await step("reveal: reduced motion shows the static reveal, with the rarity", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await forceRarity(page, "legendary");
      let sawTheater = false;
      const t0 = await spinAndTime(page);
      const deadline = t0 + 2500;
      while (Date.now() < deadline && !(await card.isVisible())) {
        if (await theater.count()) sawTheater = true;
        await page.waitForTimeout(50);
      }
      await card.waitFor({ state: "visible", timeout: 1000 });
      const took = Date.now() - t0;
      assert(!sawTheater, "no build-up or dim under reduced motion");
      assert((await skip.count()) === 0, "nothing to skip under reduced motion");
      assert(took < 2500, `the reveal is short under reduced motion (took ${took}ms)`);
      assert((await card.getAttribute("data-entrance")) === "static", "the card is static");
      assert((await page.getByTestId("reveal-confetti").count()) === 0, "no confetti");
      const dialog = page.getByRole("dialog", { name: /^You won / });
      const anim = await dialog.evaluate((el) => getComputedStyle(el).animationName);
      assert(anim === "none", `the card does not animate (animation-name: ${anim})`);
      assert(/legendary/i.test(await dialog.innerText()), "the rarity is spelled out on the card");
      assert((await page.getByTestId("reveal-pips").locator("span").count()) === 5, "rank pips show the tier at rest");
    });

    await step("reveal: the rarity is announced to screen readers", async () => {
      const live = page.getByTestId("reveal-announcement");
      assert((await live.getAttribute("role")) === "status", "the announcement is a status region");
      assert(/assertive|polite/.test((await live.getAttribute("aria-live")) || ""), "the region is live");
      await page
        .waitForFunction(() => /You won .+, a Legendary prize\./.test(document.querySelector("[data-testid='reveal-announcement']")?.textContent || ""), null, { timeout: 3000 })
        .catch(() => {});
      const said = (await live.textContent()) || "";
      assert(/^You won .+, a Legendary prize\.$/.test(said.trim()), `announces the prize and its rarity (said "${said}")`);
      const dialog = page.getByRole("dialog", { name: /^You won / });
      const described = await dialog.evaluate((el) => {
        const id = el.getAttribute("aria-describedby");
        return id ? document.getElementById(id)?.textContent?.trim() : "";
      });
      assert(/^Legendary/.test(described || ""), `the dialog is described by its rarity (${described})`);
      await closeReveal(page);
    });
  } finally {
    // Never leak the forced rarity or reduced motion into later journeys.
    await page.emulateMedia({ reducedMotion: null }).catch(() => {});
    await clearForcedRarity(page);
  }
}
