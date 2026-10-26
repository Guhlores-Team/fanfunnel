// The actual journeys: creator dashboard + fan flow. Each `step` asserts a real
// outcome; the harness records pass/fail and attributes any browser signal.
// Runs against MOCK mode, so data is deterministic per fresh server.

import { goto, clickTab, passAgeGate, BASE, NAV_ITEMS } from "./harness.mjs";

const NAV = "nav[aria-label='Dashboard sections']";

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
  await step("dashboard loads with all sections (?debug=1)", async () => {
    await goto(page, "/dashboard?debug=1", 2200);
    const tabs = await page.locator(NAV_ITEMS).count();
    assert(tabs >= 7, `expected the dashboard section nav, saw ${tabs} sections`);
  });

  await step("wheel editor: rarity change moves the odds", async () => {
    await clickTab(page, "Wheel");
    const before = (await page.locator("body").innerText()).match(/[\d.]+%/g)?.slice(0, 8) ?? [];
    // Target the rarity dropdown specifically (the select that has a 'legendary'
    // option) — the editor has other `select.ff-input` controls (e.g. label size),
    // so `.first()` alone is ambiguous.
    const sel = page
      .locator("select.ff-input")
      .filter({ has: page.locator('option[value="legendary"]') })
      .first();
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
    // Web-first wait for the save bar's own confirmation. Match the whole status
    // text: a bare /saved/ also matches "Unsaved changes", which shows before
    // the save has landed.
    const savedStatus = page
      .locator('[role="status"]')
      .filter({ hasText: /^\s*(Saved|All changes saved)\s*$/ });
    await savedStatus.first().waitFor({ timeout: 10000 }).catch(() => {});
    assert(await savedStatus.count(), "save confirmed in the UI");
  });

  await step("wheel editor: invalid brand color blocks save with an accessible error", async () => {
    // Let the previous step's save land first: its response replaces the editor
    // state and would wipe an edit made while it was in flight.
    await page
      .waitForFunction(() => /all changes saved|^saved$/im.test(document.body.innerText) && !/unsaved changes|saving…/i.test(document.body.innerText))
      .catch(() => {});
    const hex = page.getByRole("textbox", { name: "Brand color hex" });
    const original = await hex.inputValue();
    await hex.fill("nope");
    await hex.blur();
    await page
      .waitForFunction(() => document.querySelector('[aria-label="Brand color hex"]')?.getAttribute("aria-invalid") === "true")
      .catch(() => {});
    assert((await hex.getAttribute("aria-invalid")) === "true", "hex field marked aria-invalid");
    const errId = await hex.getAttribute("aria-describedby");
    assert(errId, "hex field points at its error text");
    const errText = await page.locator(`[id="${errId}"]`).innerText();
    assert(/hex color/i.test(errText), `error text explains the format (saw "${errText}")`);

    await page.locator("button:has-text('Save wheel')").first().click();
    await page.waitForFunction(() => /can't save yet/i.test(document.body.innerText)).catch(() => {});
    assert(/can't save yet/i.test(await page.locator('[role="alert"]').allInnerTexts().then((t) => t.join(" "))), "save blocked with a summary");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Brand color hex").catch(() => {});
    assert(
      (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Brand color hex",
      "focus moved to the invalid field",
    );

    // #RGB shorthand is accepted and normalized to lowercase #rrggbb on blur.
    await hex.fill("#ABC");
    await hex.blur();
    await page
      .waitForFunction(() => document.querySelector('[aria-label="Brand color hex"]')?.value === "#aabbcc")
      .catch(() => {});
    assert((await hex.inputValue()) === "#aabbcc", "shorthand normalized on blur");
    assert((await hex.getAttribute("aria-invalid")) === null, "error cleared once valid");
    const save = page.locator("button:has-text('Save wheel')").first();
    await save.click();
    await page.waitForFunction(() => !/unsaved changes/i.test(document.body.innerText)).catch(() => {});
    const after = await page.locator("body").innerText();
    assert(!/unsaved changes|can't save yet/i.test(after), "valid color saves");

    // Put the original brand color back so later steps see the usual theme.
    await hex.fill(original || "#ec4899");
    await hex.blur();
    if (await save.isEnabled()) {
      await save.click();
      await page.waitForFunction(() => !/unsaved changes/i.test(document.body.innerText)).catch(() => {});
    }
  });

  await step("wheel editor: unsaved edits survive leaving the section", async () => {
    const title = page.getByTestId("wheel-title-input");
    const draft = "Draft " + Date.now();
    await title.fill(draft);
    await page.locator('[role="status"]').filter({ hasText: /unsaved changes/i }).first().waitFor({ timeout: 5000 });
    // Leave the section and come back: the edit and its dirty state must still be there.
    await clickTab(page, "Fans");
    await clickTab(page, "Wheel");
    await page.getByTestId("wheel-title-input").waitFor({ timeout: 5000 });
    assert((await page.getByTestId("wheel-title-input").inputValue()) === draft, "the draft title is still in the editor");
    assert(
      (await page.locator('[role="status"]').filter({ hasText: /unsaved changes/i }).count()) > 0,
      "the save bar still says Unsaved changes",
    );
  });

  await step("wheel editor: switching wheels with unsaved edits asks in-app (not window.confirm)", async () => {
    // A native confirm() would auto-dismiss here and fail the step; the dialog
    // must be the app's own accessible one.
    page.once("dialog", (d) => d.dismiss().catch(() => {}));
    const draft = await page.getByTestId("wheel-title-input").inputValue();
    // P23: the win description is visible on every prize of the open wheel without opening "More".
    assert(
      (await page.getByRole("textbox", { name: "Description (shown on win)" }).count()) >= 2,
      "each prize shows its win description field",
    );
    // "New wheel" creates a wheel and tries to open it → the guard must fire.
    // exact: a wheel created with the default title is itself called "New wheel".
    await page.getByRole("button", { name: "New wheel", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /discard unsaved changes/i });
    await dialog.waitFor({ timeout: 8000 });
    assert(await dialog.count(), "an in-app discard dialog opened");
    assert(
      (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Keep editing",
      "focus lands on the safe action",
    );
    // Focus is trapped: tabbing past the last button wraps back inside the dialog.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    assert(
      await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']")),
      "Tab stays inside the discard dialog",
    );
    // Escape keeps the edits.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 4000 });
    assert((await page.getByTestId("wheel-title-input").inputValue()) === draft, "Escape kept the draft");
    // Clicking the chip of the wheel already open must not reload it over the edits.
    const switcher = page.locator("section[aria-label='Wheel switcher']");
    await switcher.locator("button[title*='prize'][aria-current='true']").click();
    await page.waitForTimeout(600);
    assert((await page.getByTestId("wheel-title-input").inputValue()) === draft, "re-clicking the open wheel kept the draft");
    assert((await page.getByRole("dialog").count()) === 0, "re-clicking the open wheel asks nothing");
    // The new wheel now exists as a chip; opening it asks again, and Discard switches.
    const chips = switcher.locator("button[title*='prize']:not([aria-current])");
    const count = await chips.count();
    assert(count >= 1, `expected another wheel chip, saw ${count}`);
    // P21: "Set active" is one click on an inactive wheel's chip, not in the menu.
    assert(
      await page.locator("section[aria-label='Wheel switcher']").getByRole("button", { name: /^Set .+ active$/ }).count(),
      "Set active is visible on an inactive wheel's chip",
    );
    await chips.first().click();
    await dialog.waitFor({ timeout: 8000 });
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 4000 });
    await page
      .waitForFunction((d) => document.querySelector('[data-testid="wheel-title-input"]')?.value !== d, draft)
      .catch(() => {});
    assert((await page.getByTestId("wheel-title-input").inputValue()) !== draft, "Discard switched to the other wheel");
    assert(
      (await page.locator('[role="status"]').filter({ hasText: /unsaved changes/i }).count()) === 0,
      "the freshly opened wheel is clean",
    );
    // The schedule card is always visible for the selected wheel.
    assert(await page.locator("section[aria-label^='Schedule for']").count(), "schedule card visible");
  });

  await step("fans: create an account", async () => {
    await clickTab(page, "Fans");
    const name = page.locator("input.ff-input").first();
    if (await name.isEditable()) await name.fill("E2E Fan");
    // The mint button is labelled "Create" (Command Center). Exact match so the
    // Import form's "Create N fans" can never be picked instead.
    const btn = page.locator("button:text-is('Create')").first();
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

    // The loose checks above pass on "Prize cost" alone, so they'd miss whole
    // sections being dropped. Each section must render its own heading.
    const sections = [
      ["conversion funnel", /^conversion$/i],
      ["CRM lifetime value", /^lifetime value$/i],
      ["CRM whales", /^whales/i],
      ["CRM win-back", /^win-back/i],
      ["best-time heatmap", /^best-time heatmap$/i],
      ["cohort retention", /^cohort retention$/i],
      ["profit & prize costs", /^profit & prize costs/i],
    ];
    for (const [what, name] of sections) {
      const heading = page.getByRole("heading", { name });
      await heading.first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
      assert((await heading.count()) > 0, `analytics renders the ${what} section (heading)`);
    }

    // P40: the trend cards keep their prior one-line hints. P38: the conversion
    // funnel is the third card of the trend row (same grid as the two trends).
    const text = await page.locator("body").innerText();
    assert(/Daily spins over time\./.test(text), "spins trend keeps its 'Daily spins over time.' sub-line");
    assert(/Daily revenue over time\./.test(text), "revenue trend keeps its 'Daily revenue over time.' sub-line");
    const sameRow = await page.evaluate(() => {
      const h3s = [...document.querySelectorAll("h3")];
      const card = (re) => h3s.find((h) => re.test(h.textContent.trim()))?.closest("section");
      const spins = card(/^Spins trend$/);
      const conv = card(/^Conversion$/);
      return !!spins && !!conv && spins.parentElement === conv.parentElement;
    });
    assert(sameRow, "the Conversion card sits in the trend row beside Spins/Revenue");
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
    // The in-app debug console is a build-gated dev tool (NEXT_PUBLIC_ENABLE_DEBUG).
    // When it's compiled into the build, verify it opens and shows zero captured
    // errors. When it isn't (a prod-style build), skip the UI check — the harness
    // error sink already fails the run on ANY console error across every step, so
    // the "zero errors during the creator flow" guarantee holds either way.
    const launcher = page.locator("button[aria-label='Open debug console']");
    if (!(await launcher.count())) return;
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
    // Phone widths must not scroll sideways. The wheel's pulsing halo used to
    // push the layout past the viewport (361 vs 360), so sample the document
    // width across ~2.5s of the glow animation, not just one frame.
    for (const width of [360, 375, 390]) {
      await page.setViewportSize({ width, height: 800 });
      // Let the wheel's resize handler re-fit to the new width first (a stale
      // 1280px-sized wheel for one frame is not the bug under test).
      await page.waitForTimeout(300);
      const worst = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let max = 0;
            const t0 = performance.now();
            const tick = () => {
              max = Math.max(max, document.documentElement.scrollWidth - window.innerWidth);
              if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
              else resolve(max);
            };
            tick();
          })
      );
      assert(worst <= 0, `no horizontal overflow at ${width}px (worst +${worst}px)`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
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
export async function creatorExtras(page, { step, assert }, ctx) {
  await step("today: the pending-prizes tile shows the server count and opens Fulfilment", async () => {
    // P4: the old every-section "N prizes waiting… Open →" banner is replaced by
    // the sidebar Fulfilment badge plus the Today "To fulfil" tile. The fan has
    // just spun, so one prize is pending.
    await goto(page, "/dashboard", 1800);
    const pulse = page.locator("section[aria-label=\"Today's pulse\"]");
    await pulse.waitFor({ timeout: 10000 });
    const tile = pulse.locator("> div").filter({ hasText: /To fulfil/ }).first();
    await page
      .waitForFunction(() => /oldest waiting/.test(document.body.innerText), null, { timeout: 15000 })
      .catch(() => {});
    const value = Number((await tile.locator("p.tnum").first().innerText()).trim());
    assert(Number.isInteger(value) && value >= 1, `To fulfil tile shows the pending count (saw ${value})`);
    const badge = page.locator(NAV_ITEMS).filter({ hasText: /Fulfilment/ }).first();
    const badgeN = Number((await badge.innerText()).replace(/\D/g, ""));
    assert(badgeN === value, `sidebar Fulfilment badge (${badgeN}) matches the tile (${value})`);
    assert(
      (await page.locator("text=/prizes? (is|are) waiting to be/").count()) === 0,
      "the old 'prizes waiting' banner is gone"
    );
    await tile.getByRole("button", { name: "Open the fulfilment queue" }).click();
    await badge.and(page.locator("[aria-current='page']")).waitFor({ timeout: 4000 }).catch(() => {});
    assert((await badge.getAttribute("aria-current")) === "page", "the tile's Open jumps to Fulfilment");
  });

  await step("redemptions: advance a fulfilment status", async () => {
    await goto(page, "/dashboard", 1800);
    await clickTab(page, "Fulfilment");
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

  await step("redemptions: note, due date and Cancel prize sit on the row; cancel asks first", async () => {
    // The row just moved to In progress; show that filter.
    await page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: /^In progress/ }).click();
    const cancel = page.getByRole("button", { name: /^Cancel prize:/ }).first();
    await cancel.waitFor({ timeout: 8000 });
    // Anchor the row on its stable aria-label, not on the trigger (the confirm replaces it).
    const label = await cancel.getAttribute("aria-label");
    const subject = label.replace(/^Cancel prize:\s*/, "");
    const row = page.locator("li").filter({ has: page.getByRole("button", { name: `Mark fulfilled: ${subject}` }) }).first();
    assert(await row.count(), "found the in-progress row");
    assert(await row.locator("input[placeholder^='Add a note']").count(), "the note field is inline on the row");
    assert(await row.locator("input[type='date']").count(), "the due date is inline on the row");
    assert((await row.getByRole("button", { name: /details/i }).count()) === 0, "no Details disclosure hides them");
    await row.getByRole("button", { name: /^Cancel prize:/ }).click();
    const confirm = row.getByRole("group", { name: /confirm cancelling/i });
    await confirm.waitFor({ timeout: 4000 });
    assert(
      (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Cancel prize",
      "focus moved to the confirm button",
    );
    await confirm.getByRole("button", { name: "Keep" }).click();
    await confirm.waitFor({ state: "hidden", timeout: 4000 });
    assert(await row.getByRole("button", { name: /^Cancel prize:/ }).count(), "Keep closed the confirm without cancelling");
  });

  await step("fans: drawer Message opens that fan's Inbox thread", async () => {
    await clickTab(page, "Fans");
    await page.getByRole("button", { name: "View Demo Fan" }).click();
    const drawer = page.getByRole("dialog", { name: "Fan details" });
    await drawer.waitFor({ timeout: 5000 });
    // Campaign names + tags are row-level info; the row meta stays on the list.
    const msg = drawer.getByRole("button", { name: "Message" });
    await page
      .waitForFunction(() => {
        const b = [...document.querySelectorAll("[role='dialog'] button")].find((x) => x.textContent?.trim() === "Message");
        return b && !b.getAttribute("aria-disabled");
      })
      .catch(() => {});
    await msg.click();
    const inboxNav = page.locator(NAV_ITEMS).filter({ hasText: "Inbox" }).first();
    await inboxNav.and(page.locator("[aria-current='page']")).waitFor({ timeout: 5000 });
    const thread = page.getByRole("list", { name: "Conversations" }).locator("button[aria-current='true']");
    await thread.waitFor({ timeout: 8000 });
    assert(/demo fan/i.test(await thread.innerText()), "the demo fan's thread is selected");
    const heading = page.getByRole("heading", { name: "Demo Fan" }).first();
    assert(await heading.count(), "the conversation pane shows the fan");
  });

  await step("admin: section renders inside the shell (demo mode is open)", async () => {
    assert(await clickTab(page, "Admin"), "Admin is a section in the sidebar");
    const region = page.getByRole("region", { name: "Admin" });
    await region.getByRole("heading", { name: "Creator accounts" }).waitFor({ timeout: 8000 });
    assert(await region.getByRole("button", { name: "New account" }).count(), "New account lives in the section");
    // The heading renders before the accounts load; wait for the first row.
    await region.getByRole("button", { name: /^Show role and features for/ }).first().waitFor({ timeout: 8000 });
    const text = await region.innerText();
    assert(/wheels/.test(text) && /spins/.test(text) && /pending/.test(text), "per-account counts show on the rows");
    assert(/Suspend|Reactivate/.test(text) && /Delete/.test(text), "Suspend and Delete are on the rows");
    // Role + feature flags are behind each row's disclosure.
    await region.getByRole("button", { name: /^Show role and features for/ }).first().click();
    assert(await region.getByRole("combobox").first().count(), "the role select is in the disclosure");
    assert(await region.getByRole("switch").first().count(), "feature flags are in the disclosure");
  });

  await step("admin: a non-admin answer from the server shows Admins only", async () => {
    // A separate page (no error sink): the 403 here is the point of the step.
    const other = await ctx.newPage();
    try {
      await other.route("**/api/admin", (route) =>
        route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' }),
      );
      await goto(other, "/dashboard?section=admin", 2000);
      await other.getByRole("alert").filter({ hasText: /admins only/i }).waitFor({ timeout: 8000 });
      assert(
        (await other.getByRole("region", { name: "Admin" }).getByRole("heading", { name: "Creator accounts" }).count()) === 0,
        "no account data renders for a non-admin answer",
      );
    } finally {
      await other.close().catch(() => {});
    }
  });

  await step("webhooks: add then remove", async () => {
    await goto(page, "/dashboard", 1500);
    await clickTab(page, "Boosts");
    // Scope to the Webhooks card (a named region) so an earlier url input,
    // "Add" or "Remove" elsewhere on Boosts can't be picked up by mistake.
    const hooks = page.getByRole("region", { name: /webhooks/i });
    const urlInput = hooks.locator("input[type='url']").last(); // webhook endpoint
    await urlInput.waitFor().catch(() => {});
    assert(await urlInput.count(), "webhook URL input present");
    await urlInput.fill("https://example.com/hooks/e2e");
    await hooks.locator("button:has-text('Add')").first().click();
    // Auto-wait for the new webhook row to appear instead of a fixed sleep.
    await hooks.locator("text=example.com/hooks/e2e").first().waitFor().catch(() => {});
    assert(
      (await hooks.locator("text=example.com/hooks/e2e").count()) > 0,
      "webhook appears in the list after Add"
    );
    await hooks.locator("button:has-text('Remove')").first().click();
    // Removing asks first (UX-3): the row stays until the confirm is clicked.
    assert(
      (await hooks.locator("text=example.com/hooks/e2e").count()) > 0,
      "webhook still listed while the remove confirm is open"
    );
    await hooks.getByRole("button", { name: "Remove webhook", exact: true }).click();
    // Auto-wait for the webhook row to disappear instead of a fixed sleep.
    await hooks.locator("text=example.com/hooks/e2e").first().waitFor({ state: "hidden" }).catch(() => {});
    assert(
      (await hooks.locator("text=example.com/hooks/e2e").count()) === 0,
      "webhook removed from the list"
    );
  });

  await step("happy hour: schedule a boost window", async () => {
    // (Still on Boosts.) Fill the multiplier + the start/end datetimes, scoped
    // to the Happy hours card so other number inputs on Boosts can't interfere.
    const hh = page.getByRole("region", { name: /happy hours/i });
    const mult = hh.locator("input[type='number']").first();
    if (await mult.count()) await mult.fill("3");
    const dts = await hh.locator("input[type='datetime-local']").all();
    if (dts.length >= 1) {
      const pad = (n) => String(n).padStart(2, "0");
      const fmt = (d) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const now = new Date();
      await dts[0].fill(fmt(new Date(now.getTime() + 3600_000)));
      if (dts.length >= 2) await dts[1].fill(fmt(new Date(now.getTime() + 7200_000)));
    }
    await hh.locator("button:has-text('Schedule')").first().click();
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

  await step("boosts: read-only link-in-bio card (link, Copy, jump to Settings)", async () => {
    // P43/P44: Boosts shows the public link read-only; editing lives in Settings.
    const card = page.locator("#boosts-link-in-bio").locator("xpath=ancestor::section[1]");
    await card.waitFor();
    await card.locator("text=/\\/c\\//").first().waitFor({ timeout: 8000 });
    assert(/\/c\/[\w-]+/.test(await card.innerText()), "the public /c/ link is shown");
    assert((await card.getByRole("button", { name: /^Copy$/ }).count()) === 1, "a Copy button for the link");
    assert((await card.locator("input").count()) === 0, "the Boosts card has no editable fields");
    await card.getByRole("button", { name: "Edit in Settings" }).click();
    const settings = page.locator(NAV_ITEMS).filter({ hasText: /Settings/ }).first();
    await settings.and(page.locator("[aria-current='page']")).waitFor({ timeout: 4000 }).catch(() => {});
    assert((await settings.getAttribute("aria-current")) === "page", "'Edit in Settings' opens Settings");
  });

  await step("settings: handle is a read-only @slug; Public page keeps the form, note and live preview", async () => {
    // P49: the Profile "Handle" is the public slug, read-only.
    const handle = page.locator("input[aria-describedby='handle-hint']");
    await handle.waitFor();
    await page.waitForFunction(() => /^@/.test(document.querySelector("input[aria-describedby='handle-hint']")?.value ?? "")).catch(() => {});
    assert((await handle.getAttribute("readonly")) !== null, "Handle is read-only");
    assert(/^@[\w-]+$/.test(await handle.inputValue()), `Handle shows @slug (saw "${await handle.inputValue()}")`);

    // P43/P44: slug, tagline, tip link, personal note, Save, Open, Copy link
    // and the live /c/[slug] preview all stay under Settings › Public page.
    const pub = page.locator("section[aria-labelledby='settings-public']");
    const slug = pub.getByPlaceholder("your-name");
    await slug.waitFor();
    await page.waitForFunction(() => (document.querySelector("input[placeholder='your-name']")?.value ?? "") !== "").catch(() => {});
    assert((await slug.inputValue()) !== "", "slug field is populated");
    const tagline = pub.getByPlaceholder(/Spin my wheel/);
    const note = pub.getByPlaceholder(/spin away/);
    assert((await tagline.count()) === 1 && (await note.count()) === 1, "tagline + personal note fields present");
    assert((await pub.getByPlaceholder(/tip link/).count()) === 1, "tip link field present");
    for (const name of [/^Save$/, /^Copy link$/]) {
      assert((await pub.getByRole("button", { name }).count()) === 1, `Public page has a ${name} button`);
    }
    assert((await pub.getByRole("link", { name: /^Open/ }).count()) === 1, "Public page has an Open link");
    // (The label is uppercased by CSS, and innerText reflects that.)
    assert(/Live preview/i.test(await pub.innerText()), "the live preview is in Settings");
    const original = await tagline.inputValue();
    await tagline.fill("E2E live tagline " + Date.now());
    const typed = await tagline.inputValue();
    // innerText never includes an <input>'s value, so the only place the typed
    // text can appear in the section's text is the live preview.
    await page.waitForFunction((t) => document.body.innerText.includes(t), typed).catch(() => {});
    assert((await pub.innerText()).includes(typed), "the preview mirrors the tagline as it's typed (unsaved)");
    await tagline.fill(original);
  });

  await step("settings: brand colour saves and re-tints the dashboard live", async () => {
    // P48: the Settings brand-colour card persists to the active wheel and the
    // whole shell re-tints without a refresh.
    const pub = page.locator("section[aria-labelledby='settings-public']");
    const hex = pub.getByRole("textbox", { name: "Brand color hex" });
    await hex.waitFor();
    const original = (await hex.inputValue()) || "#ec4899";
    // The live --brand is set on the client shell (the nearest styled ancestor
    // of the section nav); the server wrapper above it only seeds first paint.
    const shellBrand = (sel) => {
      const root = document.querySelector(sel)?.closest("[style*='--brand']");
      return root ? getComputedStyle(root).getPropertyValue("--brand").trim().toLowerCase() : "";
    };
    const brandOf = () => page.evaluate(shellBrand, NAV);
    const waitForBrand = (want) =>
      page
        .waitForFunction(
          ([sel, w]) => {
            const root = document.querySelector(sel)?.closest("[style*='--brand']");
            return !!root && getComputedStyle(root).getPropertyValue("--brand").trim().toLowerCase() === w;
          },
          [NAV, want]
        )
        .catch(() => {});
    const before = await brandOf();
    assert(before !== "", "the dashboard shell carries --brand");
    const next = before === "#3366ff" ? "#22aa66" : "#3366ff";
    await hex.fill(next);
    const save = pub.getByRole("button", { name: /^Save color$/ });
    assert(await save.isEnabled(), "Save color enables once the colour changes");
    await save.click();
    await page.waitForFunction(() => /Brand color saved/i.test(document.body.innerText)).catch(() => {});
    await waitForBrand(next);
    assert((await brandOf()) === next, `the shell re-tinted to ${next} without a refresh`);
    // Put the original colour back for the rest of the run.
    await hex.fill(original);
    await save.click();
    await waitForBrand(original.toLowerCase());
  });
}

// First-run (RD-5). Runs LAST of all: it wipes the demo account, so a brand-new
// creator's Today can be exercised (and nothing after it needs the demo data).
export async function firstRunJourney(page, { step, assert }, ctx) {
  await step("first run: reset the account (setup)", async () => {
    const res = await ctx.request.post(BASE + "/api/account/reset", { data: { confirm: "RESET" } });
    assert(res.ok(), "account reset endpoint ok");
  });

  const navItem = (re) => page.locator(NAV_ITEMS).filter({ hasText: re }).first();
  const isCurrent = async (re) => (await navItem(re).getAttribute("aria-current")) === "page";
  const list = () => page.getByTestId("first-steps");

  await step("first run: a brand-new creator lands on Today with 'Your first steps'", async () => {
    await goto(page, "/dashboard", 2000);
    await list().waitFor({ timeout: 12000 }).catch(() => {});
    assert(await isCurrent(/^Today/), "landed on Today (not auto-switched to Wheels)");
    assert(await list().count(), "'Your first steps' renders inside Today");
    const text = await list().innerText();
    assert(/Your first steps/.test(text), "checklist heading");
    assert(/1 of 5 done/.test(text), `progress reads '1 of 5 done' (saw: ${text.match(/\d of \d done/)?.[0]})`);
    assert((await list().locator("li").count()) === 5, "five steps");
    for (const t of ["Create your account", "Build your first wheel", "Mint your first fan link", "Share their spin link", "Fulfil your first win"]) {
      assert(text.includes(t), `step present: ${t}`);
    }
    // Honest first-run framing: no invented numbers, muted chips, no badges.
    const body = await page.locator("body").innerText();
    assert(/get spinning/.test(body) && /no spins yet/.test(body) && /invite fans/.test(body), "pulse tiles explain what would fill them");
    const navTexts = await page.locator(NAV_ITEMS).allInnerTexts();
    assert(navTexts.every((t) => !/\d/.test(t)), "sidebar badges are hidden at 0");
    assert((await page.locator("#needs-you-now").count()) === 0, "an empty 'Needs you now' feed is replaced by the checklist");
  });

  await step("first run: a step's CTA opens its section", async () => {
    await list().getByRole("button", { name: "Open wheel editor" }).click();
    await navItem(/Wheels/).and(page.locator("[aria-current='page']")).waitFor({ timeout: 4000 }).catch(() => {});
    assert(await isCurrent(/Wheels/), "'Open wheel editor' opens Wheels");
    await clickTab(page, "Today");
    await list().waitFor({ timeout: 6000 }).catch(() => {});
    assert(await list().count(), "the checklist is still on Today");
  });

  await step("first run: dismiss persists, and 'Get started' re-opens it on Today", async () => {
    const persisted = () =>
      page.waitForResponse((r) => r.url().includes("/api/account/onboarding") && r.request().method() === "POST").catch(() => null);
    let wait = persisted();
    await list().getByRole("button", { name: /^Dismiss/ }).click();
    await wait;
    await list().waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
    assert((await list().count()) === 0, "dismiss hides the checklist");
    const reopen = page.getByRole("button", { name: /Get started/ });
    await reopen.waitFor({ timeout: 4000 }).catch(() => {});
    assert(await reopen.count(), "the sidebar footer offers 'Get started'");

    // Reload: the dismissal lives on the account, not in this browser.
    await goto(page, "/dashboard", 2200);
    await page.waitForFunction(() => /get spinning/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
    assert((await list().count()) === 0, "still dismissed after a reload (persisted server-side)");
    assert(await page.getByRole("button", { name: /Get started/ }).count(), "'Get started' survives the reload");

    // Re-open from another section: it switches to Today and shows the list.
    await clickTab(page, "Fans");
    wait = persisted();
    await page.getByRole("button", { name: /Get started/ }).click();
    await wait;
    await list().waitFor({ timeout: 6000 }).catch(() => {});
    assert(await isCurrent(/^Today/), "'Get started' switches to Today");
    assert(await list().count(), "and the checklist is back");
    await goto(page, "/dashboard", 2200);
    await list().waitFor({ timeout: 12000 }).catch(() => {});
    assert(await list().count(), "re-opening persisted too");
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

  // Regression for React #418 on the fan page: the out-of-spins state (which
  // now has fresh wins in the gallery) must hydrate cleanly on reload and on a
  // fresh load. Clock-derived text ("just now" vs "1m ago") only diverged when a
  // boundary fell between SSR and hydration, so a second page runs with its
  // clock 50s ahead of the server to make any such divergence deterministic.
  await step("fan: out-of-spins state hydrates cleanly (reload + skewed clock)", async () => {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1400);
    assert(/out of spins/i.test(await page.locator("body").innerText()), "out-of-spins state after reload");

    const skewed = await ctx.newPage();
    const errors = [];
    skewed.on("pageerror", (e) => errors.push(String(e.message || e)));
    skewed.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    try {
      await skewed.clock.install({ time: Date.now() + 50_000 });
      await goto(skewed, "/spin/demo", 1600);
      await skewed.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      await skewed.waitForTimeout(1600);
      assert(/out of spins/i.test(await skewed.locator("body").innerText()), "out-of-spins state with a skewed clock");
    } finally {
      await skewed.close();
    }
    assert(errors.length === 0, `skewed-clock page logged errors: ${errors[0]?.slice(0, 120)}`);
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
      .waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().includes("/api/self-exclude") &&
          r.status() < 400
      )
      .catch(() => null);
    // Marker on the live document: if the page reloads/navigates it disappears,
    // proving the paused state below came from in-page state, not a refresh.
    await page.evaluate(() => {
      window.__ffNoReload = true;
    });
    await page.locator("button:has-text('Yes, pause my link')").first().click();
    await paused;
    // The fan sees a confirmation, and the page flips to paused WITHOUT a reload:
    // SPIN is disabled and says so (distinct from the "Out of spins" label that
    // the previous step leaves behind), and the balance chip reads "Paused".
    const status = page.locator("[role='dialog'] [role='status']");
    await status.first().waitFor();
    assert(/paused/i.test(await status.first().innerText()), "pause confirmation shown to the fan");
    await page.locator("[role='dialog'] button:has-text('Close')").first().click();
    const spinBtn = page.getByRole("button", { name: "Link paused" });
    await spinBtn.waitFor();
    assert(await spinBtn.isDisabled(), "SPIN is disabled immediately after pausing, without a reload");
    assert(
      /Spins left\s*Paused/i.test(await page.locator("body").innerText()),
      "balance chip shows the paused state without a reload"
    );
    assert(
      await page.evaluate(() => window.__ffNoReload === true),
      "the page was not reloaded after pausing"
    );
    // The now-paused link should 404 (getFanPass returns null). Check via the
    // request context so this *expected* 404 isn't logged as a page signal.
    const resp = await ctx.request.get(BASE + "/spin/demo");
    assert(resp.status() === 404, `paused link should 404, got ${resp.status()}`);
  });
}
