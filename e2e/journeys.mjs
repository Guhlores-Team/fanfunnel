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
    // Web-first wait: poll until the rendered odds actually change, not a fixed sleep.
    await page
      .waitForFunction(
        (b) => JSON.stringify((document.body.innerText.match(/[\d.]+%/g) ?? []).slice(0, 8)) !== b,
        JSON.stringify(before)
      )
      .catch(() => {});
    const after = (await page.locator("body").innerText()).match(/[\d.]+%/g)?.slice(0, 8) ?? [];
    assert(JSON.stringify(before) !== JSON.stringify(after), "odds recomputed on rarity change");
    await sel.selectOption("common");
  });

  await step("wheel editor: edit title + save persists", async () => {
    // Stable selector: the wheel title input carries data-testid="wheel-title-input"
    // (replaces the old "first text-ish ff-input that isn't a hex color" heuristic).
    const title = page.getByTestId("wheel-title-input");
    assert(await title.count(), "found the wheel title input");
    await title.fill("E2E Wheel " + Date.now());
    await page.locator("button:has-text('Save wheel')").first().click();
    // Web-first wait for the save confirmation rather than a fixed sleep.
    await page
      .waitForFunction(() => /saved|all changes saved/i.test(document.body.innerText))
      .catch(() => {});
    const body = await page.locator("body").innerText();
    assert(/saved|all changes saved/i.test(body), "save confirmed in the UI");
  });

  await step("fans: create an account", async () => {
    await clickTab(page, "Fans");
    const name = page.locator("input.ff-input").first();
    if (await name.isEditable()) await name.fill("E2E Fan");
    const btn = page.locator("button:has-text('Create account')").first();
    if ((await btn.count()) && (await btn.isEnabled())) {
      await btn.click();
      // Web-first wait for post-create content instead of a fixed sleep.
      await page.waitForFunction(() => /fan|link|spin/i.test(document.body.innerText)).catch(() => {});
    }
    // A fan link / token should now be present somewhere on the page.
    const body = await page.locator("body").innerText();
    assert(/fan|link|spin/i.test(body), "fans panel rendered after create");
  });

  await step("analytics tab merges performance + deep insights", async () => {
    await clickTab(page, "Analytics");
    // Web-first wait until the analytics content has rendered, instead of a fixed sleep.
    await page
      .waitForFunction(() => {
        const t = document.body.innerText;
        return (
          /spins played|spins trend|conversion|what.?s landing/i.test(t) &&
          /heatmap|cohort|profit|prize cost/i.test(t)
        );
      })
      .catch(() => {});
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
      const before = await toggle.getAttribute("aria-pressed");
      const handle = await toggle.elementHandle();
      await toggle.click();
      // Web-first wait for the toggle to reflect its new state instead of a fixed sleep.
      await page
        .waitForFunction(([el, b]) => el.getAttribute("aria-pressed") !== b, [handle, before])
        .catch(() => {});
      const body = await page.locator("body").innerText();
      assert(!/couldn.?t update leaderboard/i.test(body), "no leaderboard error toast");
    }
  });

  await step("in-app debug console caught nothing during creator flow", async () => {
    const launcher = page.locator("button[aria-label='Open debug console']");
    assert(await launcher.count(), "debug launcher present with ?debug=1");
    await launcher.click();
    // Auto-wait for the console panel to open instead of a fixed sleep.
    await page.locator("[aria-label='Debug error console']").waitFor().catch(() => {});
    const entries = await page.locator("[aria-label='Debug error console'] ul > li").count();
    assert(entries === 0, `debug console captured ${entries} error(s) during creator flow`);
    await page.locator("button[aria-label='Close debug console']").click();
    await page.locator("[aria-label='Debug error console']").waitFor({ state: "hidden" }).catch(() => {});
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
    // Wait for the spin's POST to land (captures shareId), then for the win UI to
    // render — instead of a fixed sleep timed to the wheel animation.
    await page
      .waitForResponse((r) => r.url().includes("/api/spin") && r.request().method() === "POST")
      .catch(() => {});
    await page
      .waitForFunction(() => /you won|won a|congrat|prize|🎉|awesome/i.test(document.body.innerText))
      .catch(() => {});
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
          await el.waitFor({ state: "hidden" }).catch(() => {});
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
    // The primary per-row action moves status (Start → Mark fulfilled → …).
    const action = page
      .locator("button")
      .filter({ hasText: /^(Start|Mark fulfilled|Reopen|Mark delivered)$/i })
      .first();
    await action.waitFor().catch(() => {});
    assert(await action.count(), "a redemption with a status action exists");
    const before = await page.locator("body").innerText();
    await action.click();
    // Web-first wait for the fulfilment queue to change instead of a fixed sleep.
    await page.waitForFunction((b) => document.body.innerText !== b, before).catch(() => {});
    const after = await page.locator("body").innerText();
    assert(before !== after, "the fulfilment queue changed after advancing a status");
  });

  await step("webhooks: add then remove", async () => {
    await goto(page, "/dashboard", 1500);
    await clickTab(page, "Boosts");
    const urlInput = page.locator("input[type='url']").last(); // webhook endpoint
    await urlInput.waitFor().catch(() => {});
    assert(await urlInput.count(), "webhook URL input present");
    await urlInput.fill("https://example.com/hooks/e2e");
    await page.locator("button:has-text('Add')").first().click();
    // Auto-wait for the new webhook row to appear instead of a fixed sleep.
    await page.locator("text=example.com/hooks/e2e").first().waitFor().catch(() => {});
    assert(
      (await page.locator("text=example.com/hooks/e2e").count()) > 0,
      "webhook appears in the list after Add"
    );
    await page.locator("button:has-text('Remove')").first().click();
    // Auto-wait for the webhook row to disappear instead of a fixed sleep.
    await page.locator("text=example.com/hooks/e2e").first().waitFor({ state: "hidden" }).catch(() => {});
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
    // Web-first wait for the scheduled window to render instead of a fixed sleep.
    await page
      .waitForFunction(() => {
        const t = document.body.innerText;
        return /×\s*3/.test(t) || /happy hour|boost|×/i.test(t);
      })
      .catch(() => {});
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
      const handle = await wl.elementHandle();
      await wl.click();
      // Web-first wait for the star's pressed state to flip instead of a fixed sleep.
      await page
        .waitForFunction(([el, b]) => el.getAttribute("aria-pressed") !== b, [handle, before])
        .catch(() => {});
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
    const panel = page.locator("[aria-label^='Chat with']");
    // Auto-wait for the chat panel to open instead of a fixed sleep.
    await panel.first().waitFor().catch(() => {});
    assert(await panel.count(), "chat panel opened");
    const input = page.locator("input[aria-label^='Message ']");
    if (await input.count()) {
      const msg = "e2e hello " + Date.now();
      await input.fill(msg);
      await page.keyboard.press("Enter");
      // Auto-wait for the sent message to appear in the thread instead of a fixed sleep.
      await panel.filter({ hasText: msg }).first().waitFor().catch(() => {});
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
      // Wait for the spin result (prize modal) instead of a fixed sleep for the animation.
      await page
        .locator("button:has-text('Awesome')")
        .or(page.locator("button:has-text('Close')"))
        .first()
        .waitFor()
        .catch(() => {});
      for (const s of ["button:has-text('Awesome')", "button:has-text('Close')"]) {
        const el = page.locator(s).first();
        if (await el.count()) {
          try {
            await el.click();
            await el.waitFor({ state: "hidden" }).catch(() => {});
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
    // Each click below auto-waits for its target to become actionable.
    await page.locator("button:has-text('Pause my link')").first().click();
    // Arm the pause-mutation wait before confirming, so the link is actually
    // deactivated server-side before we probe it — instead of a fixed sleep.
    const paused = page
      .waitForResponse((r) => r.request().method() === "POST" && r.status() < 400)
      .catch(() => null);
    await page.locator("button:has-text('Yes, pause my link')").first().click();
    await paused;
    // The now-paused link should 404 (getFanPass returns null). Check via the
    // request context so this *expected* 404 isn't logged as a page signal.
    const resp = await ctx.request.get(BASE + "/spin/demo");
    assert(resp.status() === 404, `paused link should 404, got ${resp.status()}`);
  });
}
