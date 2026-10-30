// Independent real game states. Scratch registrations ship with0060; bingo
// registrations are a separate0061 integration fragment, never a skipped test.
import { BASE, goto } from "./harness.mjs";
import { json } from "./focus.mjs";
import { closeInstantCard } from "./instant.mjs";
import { getTheme, putTheme, themePng } from "./theming.mjs";
import { gameFeatureSettings, setGameFeatures, gameFixture, cleanupGame, openGame, startGame,
  knownGameClientSeed, playBingoPrize, readyBingoFinal, privateLineReward } from "./games.mjs";

const owned = new WeakMap();
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 360, height: 800 };
async function prepare(page, kind = "scratch") {
  const state = { original: await gameFeatureSettings(page.request), initialTheme: await getTheme(page.request), photoIds: [] };
  owned.set(page, state);
  await setGameFeatures(page.request, { ...state.original, [kind]: true });
  state.fixture = await gameFixture(page.request, kind, `A11y ${kind}`, 32);
  if (kind === "bingo") { await knownGameClientSeed(page); await privateLineReward(page.request, state.fixture); }
  return state.fixture;
}
export async function gameA11yCleanup(page) {
  await page.unroute("**/api/spin").catch(() => {});
  await page.unroute("**/api/spin/status").catch(() => {});
  const state = owned.get(page);
  if (!state) return;
  await goto(page, "/dashboard", 50);
  await putTheme(page.request, state.initialTheme.theme);
  for (const id of state.photoIds) await json(await page.request.delete(`${BASE}/api/account/media/${id}`), "remove only game fixture photo");
  await cleanupGame(page.request, state.fixture);
  await setGameFeatures(page.request, state.original);
  owned.delete(page);
  await page.emulateMedia({ reducedMotion: null });
}
async function appearance(page, fixture, { color = "#ffffff", font = "unbounded", photo = null } = {}) {
  const current = await json(await page.request.get(`${BASE}/api/wheels/${fixture.wheel.id}`), "read own game appearance");
  const { gameKindLocked: _locked, gameReady: _ready, ...editable } = current.wheel;
  fixture.wheel = (await json(await page.request.put(BASE + "/api/wheel", { data: { wheel: { ...editable, brandColor: color } } }), "set own game brand")).wheel;
  let bgMediaId = null;
  if (photo) {
    const upload = await json(await page.request.post(BASE + "/api/account/media", { multipart: { file: { name: "game-contrast.png", mimeType: "image/png", buffer: themePng(photo) }, caption: "A plain decorative background", sfw: "yes" } }), "upload own game contrast background");
    owned.get(page).photoIds.push(upload.media.id); bgMediaId = upload.media.id;
  }
  await putTheme(page.request, { font, background: photo ? "photo" : "solid", bgMediaId });
}
const scratchReady = async page => openGame(page, await prepare(page));
const scratchFoil = async page => { await scratchReady(page); await startGame(page); await page.getByTestId("scratch-foil").waitFor(); };
const scratchWin = async page => { await scratchFoil(page); await page.getByTestId("scratch-reveal-all").click(); await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 }); };
const scratchReduced = async page => { const fixture = await prepare(page); await openGame(page, fixture, true); await startGame(page); await page.getByTestId("reward-reveal").waitFor({ timeout: 12000 }); };
const scratchContrast = (color, photo) => async page => { const fixture = await prepare(page); await appearance(page, fixture, { color, photo }); await openGame(page, fixture); await startGame(page); await page.getByTestId("scratch-foil").waitFor(); };
const pendingScratch = async page => {
  await scratchReady(page);
  await page.route("**/api/spin", route => route.abort("aborted"));
  await page.getByTestId("fan-spin").click();
  await page.getByTestId("spin-recovery-controls").waitFor();
};
const bingoEmpty = async page => openGame(page, await prepare(page, "bingo"), true);
const bingoMarked = async page => { const fixture = await prepare(page, "bingo"); await playBingoPrize(page, page.request, fixture, fixture.cellPrizes[0].id); };
const bingoBonus = async page => { const fixture = await prepare(page, "bingo"); await readyBingoFinal(page, page.request, fixture); await playBingoPrize(page, page.request, fixture, fixture.finalPrizeId, { keepOpen: true }); };
const bingoFull = async page => { await bingoBonus(page); await closeInstantCard(page); await page.getByTestId("bingo-full-card").waitFor(); };
const bingoBreak = async page => {
  await bingoMarked(page); const fixture = owned.get(page).fixture;
  await json(await page.request.post(BASE + "/api/fan/break", { data: { token: fixture.token, duration: "24h" } }), "take a game fixture break");
  await openGame(page, fixture, true);
  if (!await page.getByTestId("fan-spin").isDisabled()) throw new Error("break did not disable bingo play");
};
const bingoContrast = (color, photo) => async page => { const fixture = await prepare(page, "bingo"); await appearance(page, fixture, { color, photo }); await playBingoPrize(page, page.request, fixture, fixture.cellPrizes[0].id); };
const state = (name, prep, viewport) => ({ path: null, name, prep, cleanup: gameA11yCleanup, context: {}, ...(viewport ? { viewport } : {}) });
export function scratchA11yStates() {
  return [
    state("scratch (ready)", scratchReady),
    state("scratch phone (ready)", scratchReady, PHONE),
    state("scratch small phone (committed foil and Reveal all)", scratchFoil, SMALL),
    state("scratch phone (actual revealed win)", scratchWin, PHONE),
    state("scratch (reduced-motion committed reveal)", scratchReduced),
    state("scratch small phone (white brand, white photo, wide font)", scratchContrast("#ffffff", [255,255,255]), SMALL),
    state("scratch phone (black brand, black photo, wide font)", scratchContrast("#000000", [0,0,0]), PHONE),
    state("scratch small phone (saved request recovery)", pendingScratch, SMALL),
  ];
}
export function bingoA11yStates() {
  return [
    state("bingo (before first card)", bingoEmpty),
    state("bingo phone (committed personal card)", bingoMarked, PHONE),
    state("bingo small phone (multi-line private rewards in one dialog)", bingoBonus, SMALL),
    state("bingo phone (full card retained)", bingoFull, PHONE),
    state("bingo small phone (saved card during break)", bingoBreak, SMALL),
    state("bingo small phone (white brand and white photo)", bingoContrast("#ffffff", [255,255,255]), SMALL),
    state("bingo phone (black brand and black photo)", bingoContrast("#000000", [0,0,0]), PHONE),
  ];
}
