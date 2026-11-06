// Game switching UI states for the axe scan: the schedule takeover confirm,
// campaign cards with a chosen / followed game, and the fan drawer's
// "Change game" panel. Each prep makes and removes its own fixtures, so none
// depends on demo data surviving e2e's first-run wipe.
import { randomUUID } from "node:crypto";
import { BASE, clickTab, goto } from "./harness.mjs";
import { json } from "./focus.mjs";

const owned = new WeakMap();
const PHONE = { width: 390, height: 844 };

async function readyWheel(request, title) {
  const created = await json(await request.post(BASE + "/api/wheels", { data: { name: title, gameKind: "wheel", gameConfig: {} } }), "create a11y switching wheel");
  const prizes = ["A", "B", "C"].map((label, index) => ({ id: randomUUID(), label: `${title} ${label}`, rarity: index === 2 ? "rare" : "common", weight: index + 1, emoji: "⭐", stock: null }));
  const { gameKindLocked: _locked, gameReady: _ready, ...editable } = created.wheel;
  return (await json(await request.put(BASE + "/api/wheel", { data: { wheel: { ...editable, prizes } } }), "save a11y switching wheel")).wheel;
}
const track = (page) => { const state = owned.get(page) ?? { wheels: [], campaigns: [], fans: [] }; owned.set(page, state); return state; };

const takeoverConfirm = async (page) => {
  const state = track(page);
  const title = `A11y Switch ${Date.now().toString(36)}`;
  state.wheels.push((await readyWheel(page.request, title)).id);
  await goto(page, "/dashboard", 1200);
  await clickTab(page, "Games");
  await page.getByRole("region", { name: "Game switcher" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await page.getByRole("region", { name: `Schedule for ${title}` }).waitFor({ timeout: 8000 });
  const until = new Date(Date.now() + 86400000);
  await page.getByLabel("Active until").fill(new Date(until.getTime() - until.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Save schedule" }).click();
  await page.getByTestId("schedule-takeover").waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
};
const campaignsWithGames = async (page) => {
  const state = track(page);
  const wheel = await readyWheel(page.request, `A11y Campaign Game ${Date.now().toString(36)}`);
  state.wheels.push(wheel.id);
  for (const [name, pinnedWheelId] of [["A11y plays", wheel.id], ["A11y follows", null]]) {
    state.campaigns.push((await json(await page.request.post(BASE + "/api/campaigns", { data: { name, pinnedWheelId } }), "create a11y campaign")).campaign.id);
  }
  await goto(page, "/dashboard", 1200);
  await clickTab(page, "Campaigns");
  await page.getByTestId("campaign-plays").first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
};
const drawerChangeGame = async (page) => {
  const state = track(page);
  const campaign = (await json(await page.request.post(BASE + "/api/campaigns", { data: { name: "A11y drawer campaign", pinnedWheelId: null } }), "create a11y drawer campaign")).campaign;
  state.campaigns.push(campaign.id);
  const name = `A11y Link Fan ${Date.now().toString(36)}`;
  const fan = await json(await page.request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name, spins: 2, campaignId: campaign.id } }), "mint a11y drawer fan");
  state.fans.push(fan.fanId);
  await goto(page, "/dashboard", 1200);
  await clickTab(page, "Fans");
  await page.getByRole("button", { name: `View ${name}` }).first().click();
  const drawer = page.getByRole("dialog", { name: "Fan details" });
  await drawer.getByTestId("link-plays").first().getByRole("button", { name: "Change game" }).click();
  await drawer.getByLabel(/^Game for campaign/).waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
};
async function cleanup(page) {
  const state = owned.get(page);
  if (!state) return;
  await page.keyboard.press("Escape").catch(() => {});
  for (const id of state.fans) await page.request.delete(`${BASE}/api/fans/${id}`).catch(() => {});
  for (const id of state.campaigns) await page.request.delete(`${BASE}/api/campaigns/${id}`).catch(() => {});
  for (const id of state.wheels) await page.request.delete(`${BASE}/api/wheels/${id}`).catch(() => {});
  owned.delete(page);
}

export function gameSwitchingA11yStates(advisory) {
  const s = (name, prep, viewport) => ({ path: null, name, prep, cleanup, context: {}, advisory, ...(viewport ? { viewport } : {}) });
  return [
    s("dashboard (Games: schedule takeover confirm)", takeoverConfirm),
    s("dashboard phone (Games: schedule takeover confirm)", takeoverConfirm, PHONE),
    s("dashboard (Campaigns: chosen and followed games)", campaignsWithGames),
    s("dashboard phone (Campaigns: chosen and followed games)", campaignsWithGames, PHONE),
    s("dashboard (fan drawer: Change game)", drawerChangeGame),
    s("dashboard phone (fan sheet: Change game)", drawerChangeGame, PHONE),
  ];
}
