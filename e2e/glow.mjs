// RM-3 visit glow. Runs on its own freshly minted fan link (so it neither
// depends on nor disturbs the demo link) and before the first-run wipe.
//
// Covers: a link preview (no JavaScript, or a plain HTTP fetch) records no
// visit; opening the link records today's visit once (a reload is no new day)
// and lights a faint ring on the spins chip and the creator avatar; dates are
// clamped to UTC ± 1 day, three days warm the glow; spins never move; the
// creator's drawer shows "N of 7" and the Regulars filter leaves this fan out;
// the full glow's "Regular ✨" tag and the milestone toast render and dismiss;
// a blocked fan gets no glow and no visit; a paused link's check-in is refused.

import { goto, clickTab, BASE } from "./harness.mjs";
import { createRevealFan } from "./reveal.mjs";

const CHIP = "[data-testid='spins-chip']";
const AVATAR = "[data-testid='creator-avatar']";
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function fanRow(request, name) {
  const res = await request.get(BASE + "/api/fans");
  if (!res.ok()) throw new Error(`fans did not load (${res.status()})`);
  const fan = ((await res.json()).fans ?? []).find((f) => f.name === name);
  if (!fan) throw new Error(`fan ${name} not listed`);
  return fan;
}
const checkin = (request, data) => request.post(BASE + "/api/fan/checkin", { data });
const waitCheckin = (page) =>
  page.waitForResponse((r) => r.url().endsWith("/api/fan/checkin") && r.request().method() === "POST", { timeout: 10000 });

export async function glowJourney(browser, { step, assert }, page, ctx) {
  const name = `Glow Fan ${Date.now().toString(36)}`;
  let token = null;
  let fanId = null;

  await step("glow: a link preview (no JavaScript) records no visit", async () => {
    token = await createRevealFan(ctx.request, name, 3);
    fanId = (await fanRow(ctx.request, name)).fanId;
    const bot = await browser.newContext({ javaScriptEnabled: false });
    try {
      const preview = await bot.newPage();
      const res = await preview.goto(`${BASE}/spin/${token}`, { waitUntil: "load" });
      assert(res?.status() === 200, `the page renders without JS (${res?.status()})`);
      await preview.waitForTimeout(1500);
    } finally {
      await bot.close();
    }
    const unfurl = await ctx.request.get(`${BASE}/spin/${token}`);
    assert(unfurl.ok(), "a plain HTTP fetch (DM unfurl) gets the page");
    const fan = await fanRow(ctx.request, name);
    assert(fan.visits7 === 0, `no visit recorded by previews (got ${fan.visits7})`);
  });

  await step("glow: opening the link records today once and lights a faint ring", async () => {
    const first = waitCheckin(page);
    await goto(page, `/spin/${token}`, 200);
    const res = await first;
    const body = await res.json();
    assert(res.status() === 200, `check-in 200 (got ${res.status()})`);
    assert(body.glow?.visits === 1 && body.glow?.level === 1, `faint glow, 1 day (got ${JSON.stringify(body.glow)})`);
    assert(body.milestone === null, "no milestone on a first visit");
    assert(!("spinsRemaining" in body) && !("spins" in body), "the response carries no spins");
    await page.locator(`${CHIP}[data-glow-level='1']`).waitFor({ timeout: 5000 });
    assert((await page.locator(`${AVATAR}[data-glow-level='1']`).count()) === 1, "the creator avatar glows too");
    assert((await page.getByTestId("glow-regular").count()) === 0, "no Regular tag at 1 day");
    assert(/Spins left\s*3/.test(await page.locator(CHIP).innerText()), "spins unchanged (3)");

    const again = waitCheckin(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    const repeat = await (await again).json();
    assert(repeat.glow?.visits === 1 && repeat.milestone === null, `a reload is not a new day (${JSON.stringify(repeat)})`);
    assert((await fanRow(ctx.request, name)).visits7 === 1, "the creator sees 1 day");
  });

  await step("glow: fan dates are clamped to UTC ± 1 day; three days warm the glow", async () => {
    const tomorrow = await (await checkin(ctx.request, { token, localDate: day(1) })).json();
    const yesterday = await (await checkin(ctx.request, { token, localDate: day(-1) })).json();
    assert(tomorrow.glow?.visits >= 2 && yesterday.glow, "yesterday and tomorrow are accepted");
    const backfill = await checkin(ctx.request, { token, localDate: day(-10) });
    assert(backfill.ok(), "an old date is accepted but clamped");
    const future = await checkin(ctx.request, { token, localDate: day(30) });
    assert(future.ok(), "a far-future date is accepted but clamped");
    const fan = await fanRow(ctx.request, name);
    assert(fan.visits7 === 3, `exactly 3 days, no backfill or pre-fill (got ${fan.visits7})`);
    assert(fan.spinsRemaining === 3 && fan.grantedTotal === 3, "visits never grant spins");

    const warm = waitCheckin(page);
    await goto(page, `/spin/${token}`, 200);
    await warm;
    await page.locator(`${CHIP}[data-glow-level='2']`).waitFor({ timeout: 5000 });
    assert((await page.getByTestId("glow-regular").count()) === 0, "no Regular tag at 3 days");
    assert(/Spins left\s*3/.test(await page.locator(CHIP).innerText()), "spins still 3");
  });

  await step("glow: the creator sees 'Days visited' and the Regulars filter", async () => {
    await goto(page, "/dashboard", 1800);
    await clickTab(page, "Fans");
    await page.getByRole("button", { name: `View ${name}` }).click();
    const drawer = page.getByRole("dialog", { name: "Fan details" });
    await drawer.waitFor({ timeout: 5000 });
    await drawer.getByText("3 of 7").waitFor({ timeout: 5000 });
    assert((await drawer.getByText("Days visited (last 7)").count()) === 1, "labelled stat in the drawer");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 4000 });
    const visits = page.getByRole("combobox", { name: "Visits" });
    await visits.selectOption("regulars");
    await page.waitForTimeout(300);
    assert((await page.getByRole("button", { name: `View ${name}` }).count()) === 0, "3 of 7 is not a Regular");
    await visits.selectOption("");
    await page.getByRole("button", { name: `View ${name}` }).waitFor({ timeout: 4000 });
  });

  await step("glow: full glow shows 'Regular ✨' and the milestone toast once", async () => {
    // Presentation only: the server's answer for a fan on day 7 of 7 (the
    // counting and once-only rules are unit-tested in src/lib/glow).
    await page.route("**/api/fan/checkin", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ glow: { visits: 7, level: 3 }, milestone: "week" }) })
    );
    try {
      await goto(page, `/spin/${token}`, 200);
      const toast = page.getByTestId("glow-milestone");
      await toast.waitFor({ timeout: 5000 });
      assert((await toast.getAttribute("role")) === "status", "the toast is announced politely");
      assert(/every day this week — Demo Creator sees you/.test(await toast.innerText()), "warm, no-reward copy");
      assert(!/spin|free|bonus|lose|don't/i.test((await toast.innerText()).replace("sees you", "")), "no reward or loss framing");
      await page.locator(`${CHIP}[data-glow-level='3']`).waitFor({ timeout: 3000 });
      await page.getByTestId("glow-regular").waitFor({ timeout: 3000 });
      await toast.getByRole("button", { name: "Dismiss" }).click();
      await toast.waitFor({ state: "hidden", timeout: 3000 });
      assert(/Spins left\s*3/.test(await page.locator(CHIP).innerText()), "spins still 3 at full glow");
    } finally {
      await page.unroute("**/api/fan/checkin");
    }
  });

  await step("glow: a blocked fan gets no glow and no visit", async () => {
    const block = await ctx.request.post(`${BASE}/api/fans/${fanId}/block`, { data: { blocked: true } });
    assert(block.ok(), "the creator blocks the fan");
    try {
      const res = await checkin(ctx.request, { token, localDate: day(0) });
      const body = await res.json();
      assert(res.status() === 200 && body.glow === null, `no glow while blocked (${res.status()} ${JSON.stringify(body)})`);
      const unsolicited = [];
      const record = (req) => {
        const path = new URL(req.url()).pathname;
        if (req.method() === "POST" && ["/api/fan/checkin", "/api/fan/focus"].includes(path)) unsolicited.push(path);
      };
      page.on("request", record);
      try {
        await goto(page, `/spin/${token}`, 200);
        // Recovery initialization unlocks this fresh, credited fixture only
        // after hydration; SSR alone leaves its spin control disabled.
        await page.waitForFunction(() => {
          const button = document.querySelector("[data-testid='fan-spin']");
          return button instanceof HTMLButtonElement && !button.disabled;
        });
        await page.waitForTimeout(300);
        assert(unsolicited.length === 0, `blocked fan sends no check-in or focus request (${unsolicited.join(", ")})`);
      } finally { page.off("request", record); }
      assert((await page.locator(`${CHIP}[data-glow-level='0']`).count()) === 1, "the chip has no ring");
      assert((await fanRow(ctx.request, name)).visits7 === 3, "no visit recorded while blocked");
    } finally {
      await ctx.request.post(`${BASE}/api/fans/${fanId}/block`, { data: { blocked: false } });
    }
  });

  await step("glow: a paused link's check-in is refused", async () => {
    const pause = await ctx.request.post(BASE + "/api/self-exclude", { data: { token } });
    assert(pause.ok(), "the fan pauses their link");
    const res = await checkin(ctx.request, { token, localDate: day(0) });
    assert(res.status() === 404, `paused link → 404 (got ${res.status()})`);
    assert((await checkin(ctx.request, { token: "no-such-link" })).status() === 404, "unknown link → 404");
  });
}
