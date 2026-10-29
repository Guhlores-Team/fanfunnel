import { randomUUID } from "node:crypto";
// #26: private instant rewards, real creator routes and the real mock spin
// path. Each fixture owns a wheel and fan; odds are set through creator APIs,
// never by replacing a spin response. Run before firstRunJourney's reset.
import { acknowledgeFixtureFan, BASE, NAV_ITEMS, clickTab, goto } from "./harness.mjs";

let fixtureNumber = 0;
const json = async (response, operation) => {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()})`);
  return response.json();
};
const endpoint = (prizeId, route = "reward") => `${BASE}/api/prizes/${encodeURIComponent(prizeId)}/${route}`;

export async function instantFixture(request, name = "Instant", codeCount = 51) {
  const suffix = `${Date.now().toString(36)}-${++fixtureNumber}`;
  const title = `${name} ${suffix}`;
  const created = await json(await request.post(BASE + "/api/wheels", { data: { name: title } }), "create reward wheel");
  const draft = {
    ...created.wheel,
    title,
    prizes: [
      { id: `code-${suffix}`, label: `${title} codes`, rarity: "common", weight: 100, emoji: "🎟️", color: "#94a3b8", stock: null },
      { id: `text-${suffix}`, label: `${title} note`, rarity: "common", weight: 0, emoji: "💌", color: "#94a3b8", stock: null },
      { id: `link-${suffix}`, label: `${title} link`, rarity: "common", weight: 0, emoji: "🔗", color: "#94a3b8", stock: null },
    ],
  };
  const saved = await json(await request.put(BASE + "/api/wheel", { data: { wheel: draft } }), "save reward wheel");
  const fixture = {
    wheel: saved.wheel,
    title,
    name: `${name} fan ${suffix}`,
    code: saved.wheel.prizes[0], text: saved.wheel.prizes[1], link: saved.wheel.prizes[2],
    codes: Array.from({ length: codeCount }, (_, n) => `FF-${suffix}-CODE-${String(n + 1).padStart(4, "0")}`),
    textValue: `Private thank-you note ${suffix}. Only its winner receives this.`,
    linkValue: `https://example.test/reward/${suffix}?claim=winner-only`,
  };
  // Model C resolves the live wheel before a pass's fallback wheel. Own a schedule,
  // leaving every other wheel's active flag intact; archiving restores prior resolution.
  await json(await request.patch(`${BASE}/api/wheels/${fixture.wheel.id}`, {
    data: { activeFrom: new Date(Date.now() - 1000).toISOString(), activeUntil: null },
  }), "schedule reward fixture wheel");
  const pass = await json(await request.post(BASE + "/api/passes", {
    data: { requestId: randomUUID(), name: fixture.name, spins: codeCount + 5, wheelId: fixture.wheel.id },
  }), "create reward fan");
  fixture.token = pass.token;
  fixture.fanId = pass.fanId;
  await json(await acknowledgeFixtureFan(request, fixture.token), "acknowledge reward fan");
  return fixture;
}

export async function archiveInstantFixture(request, fixture) {
  if (!fixture?.wheel?.id) return;
  await json(await request.delete(`${BASE}/api/wheels/${fixture.wheel.id}`), "archive reward fixture");
}

export async function seedInstantCodes(request, fixture) {
  return json(await request.post(endpoint(fixture.code.id, "codes"), { data: { codes: fixture.codes.join("\n") } }), "seed reward codes");
}

export async function chooseInstantPrize(request, fixture, prizeId) {
  const current = await json(await request.get(`${BASE}/api/wheels/${fixture.wheel.id}`), "load reward wheel");
  const wheel = { ...current.wheel, prizes: current.wheel.prizes.map((p) => ({ ...p, weight: p.id === prizeId ? 100 : 0 })) };
  const saved = await json(await request.put(BASE + "/api/wheel", { data: { wheel } }), "choose reward fixture prize");
  fixture.wheel = saved.wheel;
}

export async function openInstantEditor(page, fixture, prize = fixture.code) {
  await goto(page, "/dashboard", 800);
  if (!(await clickTab(page, "Wheel"))) throw new Error("wheel navigation was not available");
  const chip = page.getByRole("region", { name: "Game switcher" })
    .getByRole("button").filter({ has: page.getByText(fixture.title, { exact: true }) });
  await chip.waitFor({ timeout: 10000 });
  await chip.click();
  const editor = page.locator(`[data-testid='prize-delivery-editor'][data-prize-id='${prize.id}']`);
  await editor.waitFor({ timeout: 8000 });
  const toggle = editor.getByTestId("delivery-toggle");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await editor.getByTestId("delivery-kind").waitFor({ timeout: 8000 });
  return editor;
}

export async function spinInstantForCard(page, fixture) {
  await goto(page, `/spin/${fixture.token}`, 300);
  const pending = page.waitForResponse((r) => r.url().endsWith("/api/spin") && r.request().method() === "POST", { timeout: 15000 });
  pending.catch(() => {});
  await page.getByRole("button", { name: /^SPIN/ }).first().click();
  const response = await pending;
  const result = await json(response, "spin reward fixture");
  await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 });
  return { response, result };
}

export async function closeInstantCard(page) {
  await page.getByRole("button", { name: "Awesome!" }).click();
  await page.getByTestId("reward-reveal").waitFor({ state: "hidden", timeout: 4000 });
}

async function saveEditor(page, editor, route) {
  const pending = page.waitForResponse((r) => r.url().endsWith(route) && ["POST", "PUT"].includes(r.request().method()), { timeout: 10000 });
  pending.catch(() => {});
  await editor.getByTestId("delivery-save").click();
  const response = await pending;
  const data = await json(response, "save delivery from editor");
  await editor.getByTestId("delivery-status").filter({ hasText: /saved|added/i }).waitFor({ timeout: 5000 });
  return data;
}

export async function instantJourney(page, { step, assert }, ctx) {
  let fixture;
  let firstWin;
  const codeWins = [];
  try {
    await step("instant: creator adds code-list delivery, sees masked hints and locked stock", async () => {
      fixture = await instantFixture(ctx.request);
      const editor = await openInstantEditor(page, fixture);
      await editor.getByTestId("delivery-kind").selectOption("codes");
      await editor.getByTestId("delivery-codes").fill([...fixture.codes, fixture.codes[0]].join("\n"));
      const data = await saveEditor(page, editor, `/api/prizes/${fixture.code.id}/codes`);
      assert(data.added === 51 && data.duplicates === 1, "one paste stores distinct codes and reports a duplicate");
      assert(/51 codes left/.test(await editor.getByTestId("delivery-code-count").innerText()), "unused code count shown");
      const preview = await editor.getByTestId("delivery-code-preview").innerText();
      assert(preview.includes("••••") && !fixture.codes.some((code) => preview.includes(code)), "saved codes are only masked");
      assert(await editor.getByTestId("delivery-codes").inputValue() === "", "full pasted codes are cleared after saving");
      const stock = page.getByLabel("Stock", { exact: true }).first();
      assert(await stock.isDisabled() && await stock.inputValue() === "51", "stock follows the code count and cannot be manually changed");
    });

    await step("instant: replacing unused codes requires explicit consent", async () => {
      const editor = page.locator(`[data-testid='prize-delivery-editor'][data-prize-id='${fixture.code.id}']`);
      await editor.getByTestId("delivery-kind").selectOption("manual");
      const confirm = editor.getByTestId("delivery-remove-codes-confirm");
      assert(await confirm.isVisible() && !(await confirm.isChecked()), "removing 51 unused codes is an unchecked choice");
      assert(await editor.getByTestId("delivery-save").isDisabled(), "delivery cannot change without consent");
      await confirm.focus();
      await page.keyboard.press("Space");
      assert(await confirm.isChecked() && !(await editor.getByTestId("delivery-save").isDisabled()), "the confirmation works with the keyboard");
      await editor.getByRole("button", { name: "Discard delivery changes" }).click();
      await page.getByText("All changes saved", { exact: true }).waitFor({ timeout: 5000 });
      const stored = await json(await ctx.request.get(endpoint(fixture.code.id)), "read intact code pool");
      assert(stored.delivery.delivery === "codes" && stored.delivery.codesLeft === 51, "discarding the replacement keeps every code");
    });

    await step("instant: sidebar, search, push navigation and reload protect secret delivery drafts", async () => {
      const editor = await openInstantEditor(page, fixture, fixture.text);
      const secretDraft = `Unsaved private draft ${fixture.title}`;
      await editor.getByTestId("delivery-kind").selectOption("text");
      await editor.getByTestId("delivery-value").fill(secretDraft);
      const prompt = page.getByRole("dialog", { name: "Discard unsaved changes?" });
      const keep = async () => {
        await prompt.waitFor({ timeout: 5000 });
        assert(/delivery/.test(await prompt.innerText()), "the prompt explains which private draft would be lost");
        await prompt.getByRole("button", { name: "Keep editing" }).click();
        await prompt.waitFor({ state: "hidden", timeout: 4000 });
        assert(await editor.getByTestId("delivery-value").inputValue() === secretDraft, "Keep editing preserves the private value");
      };
      await page.locator(NAV_ITEMS).filter({ hasText: /^Fans(?:\s|$)/ }).first().click();
      await keep();
      await page.getByRole("searchbox", { name: "Search fans by name" }).fill(fixture.name);
      await page.getByRole("searchbox", { name: "Search fans by name" }).press("Enter");
      await keep();
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "ff:navigate", url: "/dashboard?section=settings" } })));
      await keep();
      const unloading = page.waitForEvent("dialog", { timeout: 5000 });
      unloading.catch(() => {});
      const reload = page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
      const native = await unloading;
      assert(native.type() === "beforeunload", "reload invokes the browser's leave protection");
      await native.dismiss();
      await reload;
      assert(await editor.getByTestId("delivery-value").inputValue() === secretDraft, "cancelled reload keeps the draft");
      await page.locator(NAV_ITEMS).filter({ hasText: /^Fans(?:\s|$)/ }).first().click();
      await prompt.waitFor({ timeout: 5000 });
      await prompt.getByRole("button", { name: "Discard changes" }).click();
      await page.getByRole("region", { name: "Fans", exact: true }).waitFor({ timeout: 8000 });
      const stored = await json(await ctx.request.get(endpoint(fixture.text.id)), "read discarded delivery");
      assert(stored.delivery.delivery === "manual" && stored.delivery.value === null, "discarding a secret draft never stores it");
      const wheel = await json(await ctx.request.get(`${BASE}/api/wheels/${fixture.wheel.id}`), "read safe wheel payload");
      assert(!JSON.stringify(wheel).includes(secretDraft), "private drafts never enter the wheel payload");
    });

    await step("instant: an in-flight delivery save blocks leaving until it completes", async () => {
      const text = await openInstantEditor(page, fixture, fixture.text);
      await text.getByTestId("delivery-kind").selectOption("text");
      await text.getByTestId("delivery-value").fill(fixture.textValue);
      const pattern = `**/api/prizes/${fixture.text.id}/reward`;
      let release;
      const held = page.waitForRequest((request) => request.url().endsWith(`/api/prizes/${fixture.text.id}/reward`) && request.method() === "PUT", { timeout: 10000 });
      held.catch(() => {});
      const waiting = new Promise((resolve) => { release = resolve; });
      const hold = async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        await waiting;
        const response = await route.fetch();
        await route.fulfill({ response });
      };
      await page.route(pattern, hold);
      const saved = page.waitForResponse((response) => response.url().endsWith(`/api/prizes/${fixture.text.id}/reward`) && response.request().method() === "PUT", { timeout: 15000 });
      saved.catch(() => {});
      try {
        await text.getByTestId("delivery-save").click();
        await held;
        const blocked = page.getByRole("dialog", { name: "Delivery is still saving" });
        await page.locator(NAV_ITEMS).filter({ hasText: /^Fans(?:\s|$)/ }).first().click();
        await blocked.waitFor({ timeout: 5000 });
        assert(await blocked.getByRole("button", { name: "Discard changes" }).count() === 0, "pending work offers no unsafe discard action");
        await blocked.getByRole("button", { name: "Keep this page open" }).click();
        assert(await text.getByTestId("delivery-value").isDisabled(), "the delivery stays mounted and locked while saving");
        await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "ff:navigate", url: "/dashboard?section=settings" } })));
        await blocked.waitFor({ timeout: 5000 });
        await blocked.getByRole("button", { name: "Keep this page open" }).click();
        release();
        assert((await saved).ok(), "the original request completes successfully");
        await text.getByTestId("delivery-status").filter({ hasText: "Delivery saved." }).waitFor({ timeout: 5000 });
        assert(await text.getByTestId("delivery-value").inputValue() === fixture.textValue, "the completed value remains available in the editor");
      } finally {
        release();
        await saved.catch(() => {});
        await page.unroute(pattern, hold);
      }
    });

    await step("instant: creator saves a safe external link", async () => {
      const link = await openInstantEditor(page, fixture, fixture.link);
      await link.getByTestId("delivery-kind").selectOption("link");
      await link.getByTestId("delivery-value").fill("javascript:alert(1)");
      await link.getByTestId("delivery-save").click();
      await link.getByTestId("delivery-error").waitFor({ timeout: 3000 });
      assert(/https/.test(await link.getByTestId("delivery-error").innerText()), "unsafe links are refused locally with useful guidance");
      await link.getByTestId("delivery-value").fill(fixture.linkValue);
      await saveEditor(page, link, `/api/prizes/${fixture.link.id}/reward`);
    });

    await step("instant: a real winning spin reveals its own code without manual-claim copy", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const { response, result } = await spinInstantForCard(page, fixture);
      firstWin = result;
      codeWins.push(result);
      assert(result.prize.id === fixture.code.id && result.reward?.kind === "code", "the committed server draw won the configured code prize");
      assert(fixture.codes.includes(result.reward.value), "the awarded value belongs to this fixture's code pool");
      assert(/no-store/.test(response.headers()["cache-control"] ?? ""), "private spin response is never cached");
      const card = page.getByTestId("reward-reveal");
      assert(await card.getByTestId("reward-value").innerText() === result.reward.value, "the card shows exactly this winning code");
      assert(!/Screenshot this and send/.test(await card.innerText()), "instant rewards are already delivered");
      assert(await card.getByTestId("reward-copy").isVisible(), "the winner can copy the code");
      assert(await card.getAttribute("data-entrance") === "static", "reduced motion keeps the complete static reward card");
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      assert(!stored.includes(result.reward.value), "the code is never persisted in browser storage");
      await page.evaluate(() => {
        window.__instantShareOriginal = Object.getOwnPropertyDescriptor(navigator, "share");
        window.__instantShared = null;
        Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => { window.__instantShared = data; } });
      });
      try {
        await card.getByRole("button", { name: /Share your win/ }).click();
        await page.waitForFunction(() => window.__instantShared !== null, null, { timeout: 3000 });
        const shared = await page.evaluate(() => window.__instantShared);
        assert(shared.url === `${BASE}/share/${result.shareId}`, "share carries the public win link");
        assert(!JSON.stringify(shared).includes(result.reward.value) && !JSON.stringify(shared).includes(fixture.token), "native sharing contains neither reward nor fan credential");
      } finally {
        await page.evaluate(() => {
          if (window.__instantShareOriginal) Object.defineProperty(navigator, "share", window.__instantShareOriginal);
          else delete navigator.share;
          delete window.__instantShareOriginal;
          delete window.__instantShared;
        });
      }
      await closeInstantCard(page);
    });

    await step("instant: public views and another fan cannot reveal the code", async () => {
      const other = await json(await ctx.request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: fixture.name + " other", spins: 1, wheelId: fixture.wheel.id } }), "create another reward fan");
      for (const [body, status] of [[{ shareId: firstWin.shareId }, 400], [{ token: other.token, shareId: firstWin.shareId }, 404], [{ token: fixture.token, shareId: "missing-instant-win" }, 404]]) {
        const refused = await ctx.request.post(BASE + "/api/fan/reward", { data: body });
        assert(refused.status() === status, `reward credentials refused with ${status}`);
        assert(!(await refused.text()).includes(firstWin.reward.value), "refusal contains no reward value");
      }
      for (const path of [`/share/${firstWin.shareId}`, `/verify/${firstWin.shareId}`, `/api/share-cards/${firstWin.shareId}`, `/spin/${fixture.token}`]) {
        const publicView = await ctx.request.get(BASE + path);
        assert(publicView.ok(), `public prize view renders (${path.split("/")[1]})`);
        const body = await publicView.text();
        assert(!body.includes(firstWin.reward.value) && !body.includes(fixture.textValue) && !body.includes(fixture.linkValue), "neither public pages nor fan bootstrap HTML contain private values");
      }
    });

    await step("instant: every code is unique and all 51 rewards remain available through history", async () => {
      // The initial browser spin plus nine API spins fit the existing 10/10s
      // limit. Each later batch waits for that same documented window.
      for (let done = 0; done < 50;) {
        const batch = Math.min(9, 50 - done);
        for (let i = 0; i < batch; i++) {
          const result = await json(await ctx.request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: fixture.token, clientSeed: `instant-${done + i}` } }), "spin another private code");
          assert(result.reward?.kind === "code" && result.prize.id === fixture.code.id, "each limited stock win receives a code");
          codeWins.push(result);
        }
        done += batch;
        if (done < 50) await new Promise((resolve) => setTimeout(resolve, 10_500));
      }
      assert(codeWins.length === 51 && new Set(codeWins.map((win) => win.reward.value)).size === 51, "51 spins received 51 distinct code values");
      const first = await json(await ctx.request.post(BASE + "/api/fan/reward/history", { data: { token: fixture.token } }), "read instant history");
      assert(first.wins.length === 20 && typeof first.nextCursor === "string", "first history page contains 20 references and a cursor");
      assert(!JSON.stringify(first).includes("CODE-"), "history carries references, never reward values");
      const second = await json(await ctx.request.post(BASE + "/api/fan/reward/history", { data: { token: fixture.token, cursor: first.nextCursor } }), "read older instant history");
      assert(second.wins.length === 20 && typeof second.nextCursor === "string", "second page continues without repeating the first");
      const third = await json(await ctx.request.post(BASE + "/api/fan/reward/history", { data: { token: fixture.token, cursor: second.nextCursor } }), "read oldest instant history");
      const all = [...first.wins, ...second.wins, ...third.wins];
      assert(third.wins.length === 11 && third.wins.at(-1).shareId === firstWin.shareId && third.nextCursor === null, "oldest win survives beyond the recent-50 cutoff");
      assert(new Set(all.map((win) => win.shareId)).size === 51, "history pages contain every distinct win exactly once");
      await goto(page, `/spin/${fixture.token}`, 500);
      await page.getByTestId("reward-history-toggle").click();
      await page.getByTestId("reward-history-more").waitFor({ timeout: 8000 });
      assert(await page.getByTestId("reward-history-win").count() === 20, "the fan can browse the first complete history page");
      await page.getByTestId("reward-history-more").click();
      await page.waitForFunction(() => document.querySelectorAll("[data-testid='reward-history-win']").length === 40, null, { timeout: 8000 });
      await page.getByTestId("reward-history-more").click();
      await page.waitForFunction(() => document.querySelectorAll("[data-testid='reward-history-win']").length === 51, null, { timeout: 8000 });
      await page.getByTestId("reward-history-view").last().click();
      const saved = page.getByTestId("saved-reward-dialog");
      await saved.getByTestId("reward-value").waitFor({ timeout: 8000 });
      assert(await saved.getByTestId("reward-value").innerText() === firstWin.reward.value, "the oldest history entry reopens its original code");
      await page.keyboard.press("Escape");
      await saved.waitFor({ state: "hidden", timeout: 4000 });
      assert(await page.getByTestId("reward-value").count() === 0, "closing the dialog removes the decrypted code from the page");
    });

    await step("instant: text and link wins render safely on a phone", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await chooseInstantPrize(ctx.request, fixture, fixture.text.id);
      const text = await spinInstantForCard(page, fixture);
      assert(text.result.reward?.kind === "text" && await page.getByTestId("reward-value").innerText() === fixture.textValue, "text win is revealed exactly");
      await closeInstantCard(page);
      await chooseInstantPrize(ctx.request, fixture, fixture.link.id);
      await spinInstantForCard(page, fixture);
      const link = page.getByTestId("reward-open");
      assert(await link.getAttribute("href") === fixture.linkValue, "the awarded link is the configured destination");
      assert(await link.getAttribute("target") === "_blank" && /noopener/.test(await link.getAttribute("rel") ?? "") && /noreferrer/.test(await link.getAttribute("rel") ?? ""), "off-site reward cannot access its opener or receive a referrer");
      assert(await link.getAttribute("referrerpolicy") === "no-referrer", "explicit referrer policy protects the fan link");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "reward reveal fits a 390px phone");
      await closeInstantCard(page);
    });

    await step("instant: Fulfilment shows Auto and the fan's repeated view count", async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await goto(page, "/dashboard", 600);
      await clickTab(page, "Fulfilment");
      await page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: "Fulfilled", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search redemptions by fan or prize" }).fill(fixture.name);
      while (await page.getByRole("button", { name: "Load more", exact: true }).count()) await page.getByRole("button", { name: "Load more", exact: true }).click();
      await page.getByTestId("redemption-auto").first().waitFor({ timeout: 8000 });
      assert(await page.getByTestId("redemption-auto").count() === 53, "all code, text and link wins are auto-delivered");
      const viewed = await page.getByTestId("reward-view-count").allInnerTexts();
      assert(viewed.some((text) => /Viewed by fan · 2×.*last/.test(text)), "opening an old reward is counted and dated");
      assert(await page.getByRole("button", { name: /^Reopen:/ }).count() === 0, "already delivered rewards cannot be reopened as pending work");
    });
  } finally {
    await page.emulateMedia({ reducedMotion: null }).catch(() => {});
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    await archiveInstantFixture(ctx.request, fixture);
  }
}
