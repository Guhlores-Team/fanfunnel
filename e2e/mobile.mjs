// Phone-viewport journey (RD-6 / P9): the bottom tab bar + More sheet replace
// the sidebar below `lg`, every section stays reachable, the fan drawer is a
// bottom sheet, and nothing hides behind the bar or overflows at 360px.
// Read-only against the demo data, so it can run before the first-run wipe.

import { attachSink, goto, clickTab, NAV_ITEMS, MORE_BUTTON } from "./harness.mjs";

const PHONE = { width: 390, height: 844 };
const BAR = ["Today", "Inbox", "Wheels", "Fans"];
// Demo mode is an admin (server-derived), so Admin is listed.
const MORE = ["Fulfilment", "Campaigns", "Boosts", "Analytics", "Settings", "Admin"];

const h1 = (page) => page.locator("h1").first().innerText();
const overflowX = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

export async function mobileJourney(browser, { step, assert }, sink) {
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  attachSink(page, sink);
  const more = page.locator(MORE_BUTTON);
  const sheet = page.getByRole("dialog", { name: "More" });

  try {
    await step("mobile: bottom tab bar replaces the sidebar (390px)", async () => {
      await goto(page, "/dashboard?debug=1", 2200);
      const items = await page.locator(NAV_ITEMS).allInnerTexts();
      assert(
        items.map((t) => t.replace(/\d+|unread|waiting/g, "").trim()).join() === BAR.join(),
        `bar shows ${BAR.join("/")}, saw ${items.join("/")}`
      );
      assert((await more.count()) === 1 && (await more.innerText()).includes("More"), "bar ends with More");
      assert(
        (await page.locator("nav[aria-label='Dashboard sections']:visible").count()) === 1,
        "exactly one visible section nav (the sidebar is hidden)"
      );
      const bar = await page.locator("nav[aria-label='Dashboard sections']:visible").boundingBox();
      assert(bar && Math.abs(bar.y + bar.height - PHONE.height) < 1, "bar is pinned to the bottom edge");
      const today = page.locator(NAV_ITEMS).filter({ hasText: "Today" });
      assert((await today.getAttribute("aria-current")) === "page", "Today is current");
      assert((await more.getAttribute("aria-expanded")) === "false", "More starts collapsed");
    });

    await step("mobile: every section is reachable through the bar and More", async () => {
      for (const name of BAR) {
        assert(await clickTab(page, name), `bar item ${name}`);
        assert((await h1(page)) === name, `${name} opens (h1 = ${await h1(page)})`);
        const item = page.locator(NAV_ITEMS).filter({ hasText: name });
        assert((await item.getAttribute("aria-current")) === "page", `${name} carries aria-current`);
        assert((await overflowX(page)) <= 0, `${name}: no horizontal overflow at 390`);
      }
      await more.click();
      await sheet.waitFor({ timeout: 4000 });
      const listed = (await sheet.locator("nav button").allInnerTexts()).map((t) => t.replace(/\d+|waiting|unread/g, "").trim());
      assert(listed.join() === MORE.join(), `More lists ${MORE.join("/")}, saw ${listed.join("/")}`);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 4000 });
      for (const name of MORE) {
        assert(await clickTab(page, name), `More item ${name}`);
        assert((await sheet.count()) === 0, `More closes after picking ${name}`);
        assert((await h1(page)) === name, `${name} opens (h1 = ${await h1(page)})`);
        assert((await more.innerText()).includes(`current section: ${name}`), `More reads as holding ${name}`);
        assert((await overflowX(page)) <= 0, `${name}: no horizontal overflow at 390`);
      }
      await more.click();
      await sheet.waitFor({ timeout: 4000 });
      const current = sheet.locator("button[aria-current='page']");
      assert((await current.innerText()).includes("Admin"), "the current section is marked in More");
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 4000 });
    });

    await step("mobile: More is a focus-trapped dialog; Esc returns focus to More", async () => {
      await more.click();
      await sheet.waitFor({ timeout: 4000 });
      assert((await more.getAttribute("aria-expanded")) === "true", "More is expanded while open");
      const inSheet = () =>
        page.evaluate(() => !!document.activeElement?.closest("[role='dialog'][aria-modal='true']"));
      assert(await inSheet(), "focus moves into the sheet");
      for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
      assert(await inSheet(), "Tab cycles within the sheet");
      for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Tab");
      assert(await inSheet(), "Shift+Tab cycles within the sheet");
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 4000 });
      assert(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup") === "dialog"),
        "focus returns to the More button"
      );
      // The Close button and the backdrop dismiss it too.
      await more.click();
      await sheet.getByRole("button", { name: "Close" }).click();
      await sheet.waitFor({ state: "hidden", timeout: 4000 });
    });

    await step("mobile: badges stay visible (bar or More)", async () => {
      // Fulfilment's pending count lives in More; the More button totals it.
      await more.click();
      await sheet.waitFor({ timeout: 4000 });
      const ful = (await sheet.locator("nav button").filter({ hasText: "Fulfilment" }).innerText()).match(/\d+/)?.[0] ?? "0";
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 4000 });
      const moreN = (await more.innerText()).match(/\d+/)?.[0] ?? "0";
      assert(ful === moreN, `More's badge (${moreN}) totals Fulfilment's (${ful})`);
      const inboxText = await page.locator(NAV_ITEMS).filter({ hasText: "Inbox" }).innerText();
      const unread = inboxText.match(/\d+/)?.[0];
      assert(!unread || /unread/.test(inboxText), "an Inbox unread count is announced as unread");
    });

    await step("mobile: fan detail is a bottom sheet (Esc, Close and drag dismiss it)", async () => {
      await clickTab(page, "Fans");
      const row = page.getByRole("button", { name: "View Demo Fan" });
      await row.click();
      const drawer = page.getByRole("dialog", { name: "Fan details" });
      await drawer.waitFor({ timeout: 5000 });
      await page.waitForTimeout(450); // let the slide-up settle before measuring
      const box = await drawer.boundingBox();
      assert(box && Math.abs(box.y + box.height - PHONE.height) < 2, "sheet sits on the bottom edge");
      assert(box && box.y > 40 && Math.abs(box.width - PHONE.width) < 1, "sheet is full-width and leaves the list visible above");
      assert(await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']")), "focus moves into the sheet");
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden", timeout: 4000 });
      assert(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "View Demo Fan"),
        "Esc returns focus to the fan row"
      );

      await row.click();
      await drawer.waitFor({ timeout: 5000 });
      await drawer.getByRole("button", { name: "Close" }).click();
      await drawer.waitFor({ state: "hidden", timeout: 4000 });

      // Drag the grabber down past the threshold.
      await row.click();
      await drawer.waitFor({ timeout: 5000 });
      await page.waitForTimeout(450);
      const top = (await drawer.boundingBox()).y;
      await page.mouse.move(PHONE.width / 2, top + 10);
      await page.mouse.down();
      for (let dy = 20; dy <= 220; dy += 40) await page.mouse.move(PHONE.width / 2, top + 10 + dy);
      await page.mouse.up();
      await drawer.waitFor({ state: "hidden", timeout: 4000 });
    });

    await step("mobile: content and the wheel save bar clear the tab bar", async () => {
      const barTop = async () => (await page.locator("nav[aria-label='Dashboard sections']:visible").boundingBox()).y;
      for (const name of ["Today", "Fans"]) {
        await clickTab(page, name);
        // The section's data can render after the first scroll and grow the page,
        // so keep scrolling to the bottom until the height holds steady.
        await page.waitForFunction(
          () => {
            const h = document.documentElement.scrollHeight;
            window.scrollTo(0, h);
            const settled = window.__ffLastH === h;
            window.__ffLastH = h;
            return settled && Math.ceil(window.scrollY + window.innerHeight) >= h - 1;
          },
          null,
          { polling: 250, timeout: 8000 },
        ).catch(() => {});
        const region = await page.locator("[role='region']").first().boundingBox();
        assert(region && region.y + region.height <= (await barTop()) + 1, `${name}: the last content ends above the bar`);
      }
      await clickTab(page, "Wheels");
      const title = page.getByTestId("wheel-title-input");
      if (await title.count()) {
        await title.fill((await title.inputValue()) + " ");
        const save = page.getByRole("button", { name: /^Save wheel$/ });
        await save.waitFor({ timeout: 4000 });
        const sb = await save.boundingBox();
        assert(sb && sb.y + sb.height <= (await barTop()), "the sticky Save wheel sits above the bar");
        await title.fill((await title.inputValue()).trimEnd());
      }
    });

    await step("mobile: no horizontal overflow at 360px in any section", async () => {
      await page.setViewportSize({ width: 360, height: 760 });
      for (const name of [...BAR, ...MORE]) {
        await clickTab(page, name);
        await page.waitForTimeout(300);
        const over = await overflowX(page);
        assert(over <= 0, `${name}: overflows by ${over}px at 360`);
      }
      await more.click();
      await sheet.waitFor({ timeout: 4000 });
      assert((await overflowX(page)) <= 0, "More sheet: no overflow at 360");
      await page.keyboard.press("Escape");
    });

    await step("mobile: reduced motion collapses the sheet animation", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await more.click();
      await sheet.waitFor({ timeout: 4000 });
      const dur = await sheet.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
      assert(dur < 0.01, `sheet animation is collapsed (${dur}s)`);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 4000 });
      await page.emulateMedia({ reducedMotion: null });
    });

    await step("mobile: the sidebar returns from lg (1280px)", async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
      assert((await page.locator(MORE_BUTTON).count()) === 0, "no More button on desktop");
      assert((await page.locator(NAV_ITEMS).count()) >= 9, "the sidebar lists every section");
    });
  } finally {
    await ctx.close().catch(() => {});
  }
}
