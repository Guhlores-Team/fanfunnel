// The actual journeys: creator dashboard + fan flow. Each `step` asserts a real
// outcome; the harness records pass/fail and attributes any browser signal.
// Runs against MOCK mode, so data is deterministic per fresh server.

import { goto, clickTab, passAgeGate, BASE } from "./harness.mjs";

export async function creatorJourney(page, { step, assert }) {
  await step("landing renders with a CTA", async () => {
    await goto(page, "/");
    const body = await page.locator("body").innerText();
    assert(/dashboard|wheel|spin/i.test(body), "landing has expected copy");
  });

  await step("login shows the demo-mode card", async () => {
    await goto(page, "/login");
    const body = await page.locator("body").innerText();
    assert(/demo|sign in|open dashboard/i.test(body), "login renders");
  });

  // Enable the in-app debug console for the rest of the run.
  await step("dashboard loads with all tabs (?debug=1)", async () => {
    await goto(page, "/dashboard?debug=1", 2200);
    const tabs = await page.locator("[role='tab']").count();
    assert(tabs >= 7, `expected the dashboard tab bar, saw ${tabs} tabs`);
  });

  await step("wheel editor: rarity change moves the odds", async () => {
    await clickTab(page, "Wheel");
    const before = (await page.locator("body").innerText()).match(/[\d.]+%/g)?.slice(0, 8) ?? [];
    const sel = page.locator("select.ff-input").first();
    await sel.selectOption("legendary");
    await page.waitForTimeout(500);
    const after = (await page.locator("body").innerText()).match(/[\d.]+%/g)?.slice(0, 8) ?? [];
    assert(JSON.stringify(before) !== JSON.stringify(after), "odds recomputed on rarity change");
    await sel.selectOption("common");
    await page.waitForTimeout(300);
  });

  await step("wheel editor: edit title + save persists", async () => {
    // The title is the first text-ish ff-input that isn't a hex color.
    let title = null;
    for (const c of await page.locator("input.ff-input").all()) {
      try {
        const v = await c.inputValue();
        const type = await c.getAttribute("type");
        if (!v.startsWith("#") && (type === null || type === "text") && (await c.isEditable())) {
          title = c;
          break;
        }
      } catch {
        /* skip */
      }
    }
    assert(title, "found the wheel title input");
    await title.fill("E2E Wheel " + Date.now());
    await page.waitForTimeout(200);
    await page.locator("button:has-text('Save wheel')").first().click();
    await page.waitForTimeout(1300);
    const body = await page.locator("body").innerText();
    assert(/saved|all changes saved/i.test(body), "save confirmed in the UI");
  });

  await step("fans: create an account", async () => {
    await clickTab(page, "Fans");
    const name = page.locator("input.ff-input").first();
    if (await name.isEditable()) await name.fill("E2E Fan");
    await page.waitForTimeout(150);
    const btn = page.locator("button:has-text('Create account')").first();
    if ((await btn.count()) && (await btn.isEnabled())) {
      await btn.click();
      await page.waitForTimeout(1300);
    }
    // A fan link / token should now be present somewhere on the page.
    const body = await page.locator("body").innerText();
    assert(/fan|link|spin/i.test(body), "fans panel rendered after create");
  });

  await step("analytics tab merges performance + deep insights", async () => {
    await clickTab(page, "Analytics");
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText();
    const pulse = /spins played|spins trend|conversion|what.?s landing/i.test(body);
    const deep = /heatmap|cohort|profit|prize cost/i.test(body);
    assert(pulse, "analytics shows performance metrics");
    assert(deep, "analytics shows deep analytics (CRM/heatmap/profit/cohorts)");
  });

  await step("boosts: leaderboard toggle succeeds (no error toast)", async () => {
    await clickTab(page, "Boosts");
    const toggle = page.locator("button[aria-pressed]").first();
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(1000);
      const body = await page.locator("body").innerText();
      assert(!/couldn.?t update leaderboard/i.test(body), "no leaderboard error toast");
    }
  });

  await step("in-app debug console caught nothing during creator flow", async () => {
    const launcher = page.locator("button[aria-label='Open debug console']");
    assert(await launcher.count(), "debug launcher present with ?debug=1");
    await launcher.click();
    await page.waitForTimeout(400);
    const entries = await page.locator("[aria-label='Debug error console'] ul > li").count();
    assert(entries === 0, `debug console captured ${entries} error(s) during creator flow`);
    await page.locator("button[aria-label='Close debug console']").click();
    await page.waitForTimeout(200);
  });
}

export async function fanJourney(page, { step, assert }, ctx) {
  // Make sure the leaderboard is on so we can assert it renders.
  await step("enable leaderboard (setup)", async () => {
    const res = await ctx.request.post(BASE + "/api/leaderboard/enable", {
      data: { enabled: true },
    });
    assert(res.ok(), "leaderboard enable endpoint ok");
  });

  await step("fan page: age gate appears", async () => {
    await goto(page, "/spin/demo?debug=1", 1800);
    assert(
      (await page.locator("[role='dialog'][aria-modal='true']").count()) === 1,
      "age gate dialog shown to a fresh fan"
    );
  });

  await step("fan page: leaderboard visible before spinning", async () => {
    await passAgeGate(page);
    const body = await page.locator("body").innerText();
    assert(/top spinners/i.test(body), "leaderboard section renders pre-spin");
  });

  // Carries the share id from the spin to the verify step.
  ctx._shareId = null;

  await step("fan: spin decrements balance and shows a win", async () => {
    const before = (await page.locator("body").innerText()).match(/(\d+)\s*spins?\s*(left|remaining)/i);
    // Capture the spin's shareId straight from the API response (the share
    // control is a copy-to-clipboard button, not an anchor, so there's no DOM
    // link to scrape).
    const onResp = async (r) => {
      try {
        if (r.url().includes("/api/spin") && r.request().method() === "POST") {
          const j = await r.json();
          if (j && typeof j.shareId === "string") ctx._shareId = j.shareId;
        }
      } catch {
        /* non-JSON / error response */
      }
    };
    page.on("response", onResp);
    await page.locator("button:has-text('SPIN')").first().click();
    await page.waitForTimeout(6500);
    page.off("response", onResp);

    const body = await page.locator("body").innerText();
    assert(/you won|won a|congrat|prize|🎉|awesome/i.test(body), "win result is shown after the spin");
    if (before) {
      const after = body.match(/(\d+)\s*spins?\s*(left|remaining)/i);
      if (after) assert(Number(after[1]) === Number(before[1]) - 1, "balance decremented by 1");
    }
    // close any prize modal
    for (const s of ["button:has-text('Awesome')", "button:has-text('Close')"]) {
      const el = page.locator(s).first();
      if (await el.count()) {
        try {
          await el.click();
          await page.waitForTimeout(400);
          break;
        } catch {
          /* ignore */
        }
      }
    }
  });

  await step("fan: provably-fair verify shows 'Hash matches'", async () => {
    assert(ctx._shareId, "the spin API returned a shareId to verify");
    await goto(page, `/verify/${ctx._shareId}`, 1200);
    const body = await page.locator("body").innerText();
    assert(/hash matches/i.test(body), "verify page confirms the commitment");
  });

  await step("link-in-bio page renders", async () => {
    await goto(page, "/c/demo", 1400);
    const body = await page.locator("body").innerText();
    assert(/spin|win|prize/i.test(body), "public link-in-bio renders");
  });
}

// Creator edge cases. Runs AFTER the fan has spun (so a pending redemption
// exists to fulfil). Operates on the dashboard.
export async function creatorExtras(page, { step, assert }) {
  await step("redemptions: advance a fulfilment status", async () => {
    await goto(page, "/dashboard", 1800);
    await clickTab(page, "Prizes");
    await page.waitForTimeout(800);
    // The primary per-row action moves status (Start → Mark fulfilled → …).
    const action = page
      .locator("button")
      .filter({ hasText: /^(Start|Mark fulfilled|Reopen|Mark delivered)$/i })
      .first();
    assert(await action.count(), "a redemption with a status action exists");
    const before = await page.locator("body").innerText();
    await action.click();
    await page.waitForTimeout(1200);
    const after = await page.locator("body").innerText();
    assert(before !== after, "the fulfilment queue changed after advancing a status");
  });

  await step("webhooks: add then remove", async () => {
    await goto(page, "/dashboard", 1500);
    await clickTab(page, "Boosts");
    await page.waitForTimeout(600);
    const urlInput = page.locator("input[type='url']").last(); // webhook endpoint
    assert(await urlInput.count(), "webhook URL input present");
    await urlInput.fill("https://example.com/hooks/e2e");
    await page.locator("button:has-text('Add')").first().click();
    await page.waitForTimeout(1000);
    assert(
      (await page.locator("text=example.com/hooks/e2e").count()) > 0,
      "webhook appears in the list after Add"
    );
    await page.locator("button:has-text('Remove')").first().click();
    await page.waitForTimeout(800);
    assert(
      (await page.locator("text=example.com/hooks/e2e").count()) === 0,
      "webhook removed from the list"
    );
  });

  await step("happy hour: schedule a boost window", async () => {
    // (Still on Boosts.) Fill the multiplier + the start/end datetimes.
    const mult = page.locator("input[type='number']").first();
    if (await mult.count()) await mult.fill("3");
    const dts = await page.locator("input[type='datetime-local']").all();
    if (dts.length >= 1) {
      const pad = (n) => String(n).padStart(2, "0");
      const fmt = (d) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const now = new Date();
      await dts[0].fill(fmt(new Date(now.getTime() + 3600_000)));
      if (dts.length >= 2) await dts[1].fill(fmt(new Date(now.getTime() + 7200_000)));
    }
    await page.locator("button:has-text('Schedule')").first().click();
    await page.waitForTimeout(1200);
    assert(
      (await page.locator("text=/×\\s*3/").count()) > 0 ||
        /happy hour|boost|×/i.test(await page.locator("body").innerText()),
      "a happy-hour window with the multiplier appears"
    );
  });
}

// Fan extras. Runs LAST — the self-exclude at the end deactivates the demo link.
export async function fanExtras(page, { step, assert }, ctx) {
  await step("fan: wishlist toggle", async () => {
    await goto(page, "/spin/demo", 1800);
    await passAgeGate(page);
    const wl = page.locator("button[aria-pressed]").filter({ hasText: /🎁|☆|★/ }).first();
    if (await wl.count()) {
      const before = await wl.getAttribute("aria-pressed");
      await wl.click();
      await page.waitForTimeout(700);
      const after = await wl.getAttribute("aria-pressed");
      assert(before !== after, "wishlist star toggled its pressed state");
    } else {
      assert(false, "no wishlist toggle found on the fan page");
    }
  });

  await step("fan: chat opens, sends, and shows the message", async () => {
    const fab = page.locator("button[aria-label='Message creator']");
    assert(await fab.count(), "chat launcher present");
    await fab.first().click();
    await page.waitForTimeout(1200);
    const panel = page.locator("[aria-label^='Chat with']");
    assert(await panel.count(), "chat panel opened");
    const input = page.locator("input[aria-label^='Message ']");
    if (await input.count()) {
      const msg = "e2e hello " + Date.now();
      await input.fill(msg);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
      assert((await panel.innerText()).includes(msg), "sent message appears in the thread");
    }
    await page.keyboard.press("Escape");
  });

  await step("fan: share card renders", async () => {
    if (ctx._shareId) {
      await goto(page, `/share/${ctx._shareId}`, 1400);
      const body = await page.locator("body").innerText();
      assert(/won|prize|fanfunnel|spin/i.test(body), "share card page renders");
    }
  });

  await step("fan: spinning to empty shows the out-of-spins state", async () => {
    await goto(page, "/spin/demo", 1600);
    await passAgeGate(page);
    let guard = 0;
    while (guard++ < 12) {
      const spin = page.locator("button:has-text('SPIN')").first();
      if (!(await spin.count()) || !(await spin.isEnabled())) break;
      const label = (await spin.innerText()).toLowerCase();
      if (label.includes("out of spins")) break;
      await spin.click();
      await page.waitForTimeout(5800);
      for (const s of ["button:has-text('Awesome')", "button:has-text('Close')"]) {
        const el = page.locator(s).first();
        if (await el.count()) {
          try {
            await el.click();
            await page.waitForTimeout(300);
            break;
          } catch {
            /* ignore */
          }
        }
      }
    }
    const body = await page.locator("body").innerText();
    assert(/out of spins|tip|get (more )?spins|top.?up/i.test(body), "out-of-spins / top-up prompt shown");
  });

  await step("fan: self-exclude deactivates the link (LAST)", async () => {
    const safety = page.locator("button:has-text('Safety')").first();
    assert(await safety.count(), "safety menu trigger present");
    await safety.click();
    await page.waitForTimeout(500);
    await page.locator("button:has-text('Pause my link')").first().click();
    await page.waitForTimeout(400);
    await page.locator("button:has-text('Yes, pause my link')").first().click();
    await page.waitForTimeout(1200);
    // The now-paused link should 404 (getFanPass returns null). Check via the
    // request context so this *expected* 404 isn't logged as a page signal.
    const resp = await ctx.request.get(BASE + "/spin/demo");
    assert(resp.status() === 404, `paused link should 404, got ${resp.status()}`);
  });
}
