import { randomUUID } from "node:crypto";
// Trust & safety (batch 6). Every fixture is a fresh fan made through the
// creator API, so nothing depends on other journeys' data.
//
// T2: until a fan confirms the age gate, chat, wishlist and a leaderboard
//     opt-in answer 403 needs_ack, while Safety & privacy still works.
// T5: the fan page lists each win's delivery state.
// T3: a paused link is a read-only "Your wins" view (no SPIN, no chat) with
//     the Safety menu, which no longer offers to pause again.
// T11/T12/T19: Terms and Privacy links on the public pages, prize odds on /c,
//     and /.well-known/security.txt names the published contact.

import { acknowledgeFixtureFan, goto, BASE } from "./harness.mjs";

async function json(res, what) {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()})`);
  return res.json();
}

async function newFan(request, name, { ack = true } = {}) {
  const fan = await json(await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 3 } }), `create ${name}`);
  if (ack) await json(await acknowledgeFixtureFan(request, fan.token), `ack ${name}`);
  return { name, token: fan.token, fanId: fan.fanId };
}

async function hasLegalLinks(page) {
  const nav = page.getByRole("navigation", { name: "Legal" }).last();
  await nav.waitFor({ timeout: 8000 });
  return (await nav.getByRole("link", { name: "Terms" }).getAttribute("href")) === "/terms"
    && (await nav.getByRole("link", { name: "Privacy" }).getAttribute("href")) === "/privacy";
}

export async function trustJourney(page, { step, assert }, ctx) {
  const tag = Math.random().toString(36).slice(2, 7);
  const post = (path, data) => ctx.request.post(BASE + path, { data });

  await step("trust T2: before the age gate, chat, wishlist and opt-in are 403 needs_ack", async () => {
    const fan = await newFan(ctx.request, `Gate Fan ${tag}`, { ack: false });
    for (const [what, res] of [
      ["chat send", await post("/api/messages/fan", { token: fan.token, body: "hello?" })],
      ["chat read", await post("/api/messages/fan/thread", { token: fan.token })],
      ["wishlist", await post("/api/wishlists", { token: fan.token, prizeLabel: "anything" })],
      ["leaderboard opt-in", await post("/api/leaderboard/opt-in", { token: fan.token, optIn: true, handle: `gate${tag}` })],
    ]) {
      const body = await res.json().catch(() => null);
      assert(res.status() === 403 && body?.error === "needs_ack", `${what} → 403 needs_ack (got ${res.status()} ${JSON.stringify(body)})`);
    }
    assert((await post("/api/fan-data/export", { token: fan.token })).ok(), "Safety & privacy: the data export still works behind the gate");
    assert((await post("/api/leaderboard/opt-in", { token: fan.token, optIn: false })).ok(), "leaving the leaderboard still works behind the gate");
    await json(await acknowledgeFixtureFan(ctx.request, fan.token), "ack");
    assert((await post("/api/messages/fan/thread", { token: fan.token })).ok(), "after the gate, the thread reads");
  });

  let fan;
  let shareId;
  await step("trust T5: the fan page shows each win's delivery state", async () => {
    fan = await newFan(ctx.request, `Trust Fan ${tag}`);
    const win = await json(await post("/api/spin", { token: fan.token, requestId: randomUUID(), clientSeed: `trust-${tag}` }), "spin");
    shareId = win.shareId;
    await goto(page, `/spin/${fan.token}`, 800);
    const list = page.getByTestId("win-delivery");
    await list.waitFor({ timeout: 8000 });
    await list.locator("summary").click();
    const status = list.getByTestId("win-delivery-status").first();
    await status.waitFor({ timeout: 5000 });
    const state = await status.getAttribute("data-status");
    assert(["waiting", "in_progress", "delivered", "cancelled"].includes(state ?? ""), `a delivery state is shown (${state})`);
    assert(/Waiting for the creator|In progress|Delivered|Cancelled/.test(await status.innerText()), "in plain words");
  });

  await step("trust T3: the pause dialog says pausing is permanent", async () => {
    await page.getByRole("button", { name: "Safety & privacy" }).click();
    const dialog = page.getByRole("dialog", { name: "Safety and privacy" });
    await dialog.waitFor({ timeout: 5000 });
    assert(await hasLegalLinks(dialog), "T11: the Safety menu links the Terms and Privacy");
    await dialog.getByRole("button", { name: /Pause my link/ }).click();
    assert(/permanently stops your link.*can't be undone/s.test(await dialog.innerText()), "the warning is plain");
    await dialog.getByRole("button", { name: "Back" }).click();
    await page.keyboard.press("Escape");
    assert(await hasLegalLinks(page), "T11: the fan page footer links the Terms and Privacy");
  });

  await step("trust T3: a paused link keeps a read-only wins view", async () => {
    assert((await post("/api/self-exclude", { token: fan.token })).ok(), "the fan pauses the link");
    const res = await ctx.request.get(`${BASE}/spin/${fan.token}`);
    assert(res.status() === 200, `the paused link answers 200, not 404 (got ${res.status()})`);
    await goto(page, `/spin/${fan.token}`, 800);
    await page.getByTestId("paused-wins").waitFor({ timeout: 8000 });
    const win = page.getByTestId("paused-win").first();
    assert(await win.isVisible(), "the win is listed");
    assert((await win.getByRole("link", { name: /Check this win was fair/ }).getAttribute("href")) === `/verify/${shareId}`, "with its verify link");
    assert((await page.getByTestId("fan-spin").count()) === 0, "no SPIN");
    assert((await page.locator("button[aria-label='Message creator']").count()) === 0, "no chat");
    await page.getByRole("button", { name: "Safety & privacy" }).click();
    const dialog = page.getByRole("dialog", { name: "Safety and privacy" });
    await dialog.waitFor({ timeout: 5000 });
    assert((await dialog.getByRole("button", { name: /Report this creator/ }).count()) === 1, "reporting still works");
    assert((await dialog.getByRole("button", { name: /Pause my link/ }).count()) === 0, "no second pause offer");
    await page.keyboard.press("Escape");
    assert(await hasLegalLinks(page), "Terms and Privacy links on the paused view");
    const spin = await post("/api/spin", { token: fan.token, requestId: randomUUID(), clientSeed: "after-pause" });
    assert(spin.status() >= 400, `the database still refuses a spin (got ${spin.status()})`);
  });

  await step("trust T11/T12: public pages link the Terms and Privacy; /c shows the odds by prize", async () => {
    await goto(page, "/c/demo", 600);
    assert(await hasLegalLinks(page), "/c links the Terms and Privacy");
    const odds = page.getByTestId("public-odds");
    if (await odds.count()) {
      await odds.locator("summary").click();
      assert(/\d+(\.\d+)?%/.test(await odds.innerText()), "/c lists each prize with a percentage");
    }
    await goto(page, `/verify/${shareId}`, 600);
    assert(await hasLegalLinks(page), "/verify links the Terms and Privacy");
    await goto(page, `/share/${shareId}`, 600);
    assert(await hasLegalLinks(page), "/share links the Terms and Privacy");
  });

  await step("trust T19: /.well-known/security.txt names the published contact", async () => {
    const res = await ctx.request.get(BASE + "/.well-known/security.txt");
    assert(res.ok(), `security.txt is served (got ${res.status()})`);
    const text = await res.text();
    assert(/^Contact: mailto:support@easysimplesites\.org$/m.test(text) && /^Expires: /m.test(text) && /^Preferred-Languages: en$/m.test(text), "with Contact, Expires and Preferred-Languages");
  });
}
