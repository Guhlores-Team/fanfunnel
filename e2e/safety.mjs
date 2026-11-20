import { randomUUID } from "node:crypto";
// Safety reports and blocked fans (audit A1, A4).
//
// A1: a fan reports the creator from Safety & privacy; the admin nav counts
// open reports; Admin › Reports shows it with the creator, fan and link
// context and the fan's words; Resolve with a note moves it to Resolved, and
// Reopen brings it back.
// A4: a blocked fan's page says why and hides chat and the wishlist; the
// server refuses their chat, wishlist and leaderboard opt-in with 403
// `blocked`; a fan blocked mid-session sees the friendly note in chat.
//
// Every fixture is a fresh fan made through the creator API, so nothing
// depends on other journeys' data. Runs before firstRunJourney's reset.

import { acknowledgeFixtureFan, goto, clickTab, BASE, NAV_ITEMS } from "./harness.mjs";

const CHILD_SAFETY = "Involves someone under 18";
const BLOCKED_NOTE = /chat and wishlists are off/;

async function json(res, what) {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()})`);
  return res.json();
}

/** A fresh acknowledged fan with spins (so chat is unlocked). */
export async function safetyFan(request, name) {
  const { token, fanId } = await json(
    await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2 } }),
    `create ${name}`,
  );
  await json(await acknowledgeFixtureFan(request, token), `ack ${name}`);
  return { name, token, fanId };
}

/** The open-report count from the admin API, or null. */
async function openCount(request) {
  const res = await request.get(BASE + "/api/admin/reports/count");
  return res.ok() ? (await res.json()).openCount : null;
}

export async function safetyJourney(page, { step, assert }, ctx) {
  const tag = Math.random().toString(36).slice(2, 7);
  const detail = `e2e report ${tag}`;
  let fan;
  let before = 0;

  await step("reports (setup): a fresh fan on their own link", async () => {
    fan = await safetyFan(ctx.request, `Safety Fan ${tag}`);
    before = (await openCount(ctx.request)) ?? 0;
  });

  await step("reports: a fan reports the creator from Safety & privacy", async () => {
    await goto(page, `/spin/${fan.token}`, 800);
    await page.getByRole("button", { name: "Safety & privacy" }).click();
    const dialog = page.getByRole("dialog", { name: "Safety and privacy" });
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByRole("button", { name: /Report this creator/ }).click();
    await dialog.getByLabel("Reason for report").selectOption(CHILD_SAFETY);
    await dialog.getByLabel("Additional details (optional)").fill(detail);
    await dialog.getByRole("button", { name: "Send report" }).click();
    const done = dialog.getByRole("status");
    await done.waitFor({ timeout: 8000 });
    assert(/report was sent/.test(await done.innerText()), "the fan is told the report was sent");
    await dialog.getByRole("button", { name: "Close" }).click();
    assert((await openCount(ctx.request)) === before + 1, "the open-report count went up by one");
  });

  await step("reports: the Admin nav item counts open reports for screen readers too", async () => {
    await goto(page, "/dashboard", 1200);
    // Only the Admin item's badge says "open reports" to screen readers.
    const item = page.locator(NAV_ITEMS).filter({ hasText: "Admin" }).filter({ hasText: "open reports" }).first();
    await item.waitFor({ timeout: 15000 });
    assert(/\d+\s*open reports/.test((await item.textContent()) ?? ""), "the badge reads as N open reports");
  });

  await step("reports: Admin › Reports shows the report with its context", async () => {
    assert(await clickTab(page, "Admin"), "Admin is in the nav");
    const region = page.getByRole("region", { name: "Reports", exact: true });
    await region.waitFor({ timeout: 8000 });
    await region.getByLabel("Reason").selectOption(CHILD_SAFETY);
    const row = region.getByTestId("admin-report").filter({ hasText: fan.name });
    await row.first().waitFor({ timeout: 8000 });
    const text = await row.first().innerText();
    assert(/Urgent/.test(text) && /Open/.test(text), "the report is marked urgent and open");
    assert(text.includes(fan.name), "the fan who sent it is named");
    assert(/Reported creator/i.test(text) && /link …\S{4}/.test(text), "the creator and a link hint are shown, never the full link");
    assert(!text.includes(fan.token), "the fan's full link is never shown");
    const reveal = row.first().getByRole("button", { name: "What the fan wrote" });
    await reveal.click();
    assert((await reveal.getAttribute("aria-expanded")) === "true", "the disclosure reports its state");
    assert((await row.first().innerText()).includes(detail), "the fan's words are shown on request");
    assert(/\d+ open/.test(await region.getByTestId("admin-reports-open-count").innerText()), "the section shows the open count");
  });

  await step("reports: Resolve with a note moves it to Resolved; Reopen brings it back", async () => {
    const region = page.getByRole("region", { name: "Reports", exact: true });
    const row = region.getByTestId("admin-report").filter({ hasText: fan.name }).first();
    await row.getByLabel("Note (optional, admins only)").fill(`checked ${tag}`);
    await row.getByRole("button", { name: /^Resolve: / }).click();
    await region.getByTestId("admin-report").filter({ hasText: fan.name }).waitFor({ state: "detached", timeout: 8000 });
    assert((await openCount(ctx.request)) === before, "the open count is back where it started");
    await region.getByRole("group", { name: "Show reports" }).getByRole("button", { name: "Resolved" }).click();
    const resolved = region.getByTestId("admin-report").filter({ hasText: fan.name }).first();
    await resolved.waitFor({ timeout: 8000 });
    assert((await resolved.innerText()).includes(`checked ${tag}`), "the admin's note is kept with the outcome");
    await resolved.getByRole("button", { name: /^Reopen: / }).click();
    await region.getByTestId("admin-report").filter({ hasText: fan.name }).waitFor({ state: "detached", timeout: 8000 });
    assert((await openCount(ctx.request)) === before + 1, "reopening counts it as open again");
    // Leave the queue as we found it.
    await region.getByRole("group", { name: "Show reports" }).getByRole("button", { name: "Open" }).click();
    const reopened = region.getByTestId("admin-report").filter({ hasText: fan.name }).first();
    await reopened.waitFor({ timeout: 8000 });
    await reopened.getByRole("button", { name: /^Dismiss: / }).click();
    await region.getByTestId("admin-report").filter({ hasText: fan.name }).waitFor({ state: "detached", timeout: 8000 });
  });

  let blocked;
  await step("blocked fan (setup): the creator blocks a fresh fan", async () => {
    blocked = await safetyFan(ctx.request, `Blocked Fan ${tag}`);
    const res = await ctx.request.post(`${BASE}/api/fans/${blocked.fanId}/block`, { data: { blocked: true } });
    assert(res.ok(), "the creator blocks the fan");
  });

  try {
    await step("blocked fan: the server refuses chat, wishlist and leaderboard opt-in with 403", async () => {
      const post = (path, data) => ctx.request.post(BASE + path, { data });
      for (const [what, res] of [
        ["chat", await post("/api/messages/fan", { token: blocked.token, body: "let me in" })],
        ["wishlist", await post("/api/wishlists", { token: blocked.token, prizeLabel: "anything" })],
        ["leaderboard opt-in", await post("/api/leaderboard/opt-in", { token: blocked.token, optIn: true, handle: `blk${tag}` })],
      ]) {
        const body = await res.json().catch(() => null);
        assert(res.status() === 403 && body?.error === "blocked", `${what} → 403 blocked (got ${res.status()} ${JSON.stringify(body)})`);
      }
    });

    await step("blocked fan: the page says why and hides chat and the wishlist", async () => {
      await goto(page, `/spin/${blocked.token}`, 800);
      const note = page.getByTestId("fan-blocked-note");
      await note.waitFor({ timeout: 8000 });
      assert((await note.getAttribute("role")) === "note", "the note is a labelled note");
      assert(BLOCKED_NOTE.test(await note.innerText()), "the note explains chat and wishlists are off");
      assert((await page.locator("button[aria-label='Message creator']").count()) === 0, "no chat launcher");
      assert((await page.locator("[aria-label^='Chat with']").count()) === 0, "no chat panel");
    });

    await step("blocked fan: blocked mid-session, the chat shows the friendly note", async () => {
      // Its own page with no error sink: the 403 is the point of the step.
      const other = await ctx.newPage();
      try {
        const res = await ctx.request.post(`${BASE}/api/fans/${blocked.fanId}/block`, { data: { blocked: false } });
        assert(res.ok(), "unblocked for the setup");
        await goto(other, `/spin/${blocked.token}`, 800);
        await other.locator("button[aria-label='Message creator']").first().click();
        const input = other.locator("input[aria-label^='Message ']");
        await input.waitFor({ timeout: 8000 });
        assert((await ctx.request.post(`${BASE}/api/fans/${blocked.fanId}/block`, { data: { blocked: true } })).ok(), "blocked again");
        await input.fill("are you there?");
        await other.keyboard.press("Enter");
        const alert = other.locator("[aria-label^='Chat with'] [role='alert']");
        await alert.waitFor({ timeout: 8000 });
        assert(BLOCKED_NOTE.test(await alert.innerText()), "the refusal reads as the friendly note");
        assert((await other.locator("input[aria-label^='Message ']").count()) === 0, "the composer is replaced by the note");
      } finally {
        await other.close().catch(() => {});
      }
    });
  } finally {
    await ctx.request.post(`${BASE}/api/fans/${blocked?.fanId}/block`, { data: { blocked: false } }).catch(() => {});
  }
}
