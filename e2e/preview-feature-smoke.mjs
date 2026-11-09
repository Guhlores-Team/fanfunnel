// Optional real hosted feature smoke. Source preparation is not execution.
// No screenshots, trace, HAR, storageState, private URLs or raw errors leave memory.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  TEST_ORIGIN, browserEnvironment, checkCheckoutIdentity, checkPreflightRecord, failureCode, preflightRecord, refuse, verifyPreviewDeployment,
} from "./preview-lcp-guards.mjs";
import {
  SHARED_GUARD_SHA256, MAX_BINGO_PLAYS, UUID, SAFE_SHARE_ID, ensure, previewFeatureEnvironment,
  featureBrowserUrlAllowed, ownFixtureUser, safeApiUrl, checkPrimaryReceipt, checkReplay, checkCleanupBeforeAuth,
  checkInstantHealth, checkNoPrivateReward, checkPublicRewardDocument, checkInstantStock, checkInstantWin, checkInstantEconomy,
} from "./preview-feature-guards.mjs";

const OUTPUT = new URL("./artifacts/preview-feature-smoke/", import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = (reply, code) => { ensure(!reply.error && reply.data != null, code); return reply.data; };
function writeReport(name, value) { mkdirSync(OUTPUT, { recursive: true }); writeFileSync(new URL(name, OUTPUT), JSON.stringify(value, null, 2) + "\n"); }
async function api(context, config, path, method = "GET", body) {
  const response = await context.request.fetch(safeApiUrl(config.origin, path), {
    method, maxRedirects: 0, timeout: 30_000, ...(body === undefined ? {} : { data: body }),
  });
  ensure(response.ok(), "FEATURE_API_REFUSED");
  return response.json();
}
async function guardedContext(browser, config, state, creator = false) {
  const context = await browser.newContext({ viewport: creator ? { width: 1280, height: 960 } : { width: 390, height: 844 },
    serviceWorkers: "block", reducedMotion: "reduce" });
  state.contexts.push(context);
  await context.route("**/*", route => {
    if (featureBrowserUrlAllowed(route.request().url(), config.origin)) return route.continue();
    state.counters.blockedRequests++; return route.abort("blockedbyclient");
  });
  context.on("page", page => {
    page.on("pageerror", () => { state.counters.pageErrors++; });
    page.on("console", message => { if (message.type() === "error") state.counters.consoleErrors++; });
  });
  return context;
}
async function goto(page, config, path) {
  ensure(typeof path === "string" && path.startsWith("/") && !path.startsWith("//"), "INVALID_FEATURE_PAGE");
  const target = new URL(path, config.origin);
  ensure(target.origin === config.origin, "INVALID_FEATURE_PAGE");
  const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  ensure(response?.ok() && new URL(page.url()).origin === config.origin, "FEATURE_PAGE_UNAVAILABLE");
}
async function createFixture(admin, runId, state) {
  state.userId = randomUUID();
  state.email = `e2e-feature-smoke-${runId}-${randomBytes(6).toString("hex")}@fanfunnel.test`;
  const password = randomBytes(32).toString("base64url") + "aA1!";
  // Save the exact cleanup UUID before a potentially ambiguous create response.
  const created = data(await admin.auth.admin.createUser({ id: state.userId, email: state.email, password, email_confirm: true }), "FIXTURE_CREATE_FAILED");
  ensure(ownFixtureUser(created.user, state.userId, state.email), "FIXTURE_CREATE_FAILED");
  state.createAcknowledged = true;
  let present = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await admin.from("profiles").select("id").eq("id", state.userId).maybeSingle();
    ensure(!reply.error, "FIXTURE_PROFILE_FAILED");
    if (reply.data?.id === state.userId) { present = true; break; }
    await pause(250);
  }
  ensure(present, "FIXTURE_PROFILE_FAILED");
  data(await admin.from("profiles").update({ approval_status: "approved", is_active: true, role: "creator",
    display_name: "Preview feature fixture", features: { wheel: true, scratch: true, bingo: true },
    tip_url: null, avatar_url: null, notify_new_spin: false, notify_low_balance: false, notify_messages: false,
  }).eq("id", state.userId).select("id").single(), "FIXTURE_PROFILE_FAILED");
  return { email: state.email, password };
}
async function chaseRemainsOff(admin, state) {
  const reply = await admin.from("focus_creator_config").select("chase_enabled").eq("creator_id", state.userId).maybeSingle();
  ensure(!reply.error && reply.data?.chase_enabled !== true, "CHASE_MUST_REMAIN_DISABLED");
}
async function login(browser, admin, config, credentials, state) {
  state.auth = await guardedContext(browser, config, state, true);
  const page = await state.auth.newPage();
  await goto(page, config, "/login");
  await page.locator("input[aria-label='Email address']").fill(credentials.email);
  await page.locator("input[aria-label='Password']").fill(credentials.password);
  await page.locator("button[type='submit']").filter({ hasText: /^Sign in$/ }).click();
  await page.waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30_000 });
  const account = await api(state.auth, config, "/api/account");
  ensure(account.email === credentials.email && account.features?.scratch === true && account.features?.bingo === true, "FIXTURE_SESSION_UNVERIFIED");
  let terms = await api(state.auth, config, "/api/account/terms");
  if (terms.needsAcceptance === true) {
    const prompt = page.getByTestId("terms-prompt");
    await prompt.waitFor({ timeout: 15_000 });
    await prompt.getByTestId("terms-checkbox").check();
    await prompt.getByRole("button", { name: "Agree and continue" }).click();
    await prompt.waitFor({ state: "hidden", timeout: 15_000 });
    terms = await api(state.auth, config, "/api/account/terms");
  }
  ensure(terms.needsAcceptance === false && terms.current === terms.version && !!terms.acceptedAt, "CREATOR_TERMS_UNVERIFIED");
  const profile = data(await admin.from("profiles").select("terms_version,terms_accepted_at").eq("id", state.userId).single(), "CREATOR_TERMS_UNVERIFIED");
  ensure(profile.terms_version === terms.current && !!profile.terms_accepted_at, "CREATOR_TERMS_UNVERIFIED");
  return page;
}
async function ownRecord(admin, table, id, owner, ownerColumn = "creator_id") {
  ensure(UUID.test(id ?? ""), "FIXTURE_RECORD_ID_UNVERIFIED");
  const row = data(await admin.from(table).select("id").eq("id", id).eq(ownerColumn, owner).single(), "FIXTURE_RECORD_OWNERSHIP_UNVERIFIED");
  ensure(row.id === id, "FIXTURE_RECORD_OWNERSHIP_UNVERIFIED");
}
async function gameFixture(admin, config, state, kind) {
  const name = `Preview ${kind} fixture`;
  const settings = kind === "scratch" ? { style: "classic" } : kind === "bingo" ? { size: 3, linePrizeId: null } : {};
  const created = await api(state.auth, config, "/api/wheels", "POST", { name, gameKind: kind, gameConfig: settings });
  ensure(created.wheel && UUID.test(created.wheel.id ?? ""), "FIXTURE_WHEEL_UNVERIFIED");
  await ownRecord(admin, "wheels", created.wheel.id, state.userId);
  const prizes = Array.from({ length: kind === "bingo" ? 9 : 3 }, (_, index) => ({ id: randomUUID(), label: `Fixture prize ${index + 1}`,
    rarity: kind === "bingo" || index === 2 ? "rare" : "common", weight: kind === "bingo" ? 1 : index === 0 ? 1 : 9,
    emoji: "◇", color: "#6366f1", stock: null, cost: 0, boostable: kind === "wheel" && index === 0 }));
  const line = { id: randomUUID(), label: "Fixture line bonus", rarity: "rare", weight: 0, emoji: "◇", color: "#6366f1", stock: null, cost: 0 };
  const { gameKindLocked: _locked, gameReady: _ready, ...editable } = created.wheel;
  const saved = await api(state.auth, config, "/api/wheel", "PUT", { wheel: { ...editable, gameKind: kind,
    gameConfig: kind === "bingo" ? { size: 3, linePrizeId: line.id } : settings,
    showStock: false, prizes: kind === "bingo" ? [...prizes, line] : prizes } });
  // Wheel/Scratch save maps new client prize IDs to real DB IDs; Bingo's
  // publication preserves UUIDs to bind its configured line target. Always
  // consume the returned stored IDs rather than assuming the new draft IDs.
  const target = saved.wheel?.prizes?.find(prize => prize.label === prizes[0].label);
  ensure(saved.wheel?.id === created.wheel.id && saved.wheel.gameReady !== false && UUID.test(target?.id ?? "")
    && (kind !== "bingo" || saved.wheel.gameConfig?.linePrizeId === line.id), "FIXTURE_GAME_SAVE_UNVERIFIED");
  // Pin every fixture so later game creation/schedules cannot move an older link.
  const campaign = (await api(state.auth, config, "/api/campaigns", "POST", { name, pinnedWheelId: saved.wheel.id })).campaign;
  await ownRecord(admin, "campaigns", campaign?.id, state.userId);
  const credits = kind === "bingo" ? MAX_BINGO_PLAYS : 2;
  const fan = await api(state.auth, config, "/api/passes", "POST", { requestId: randomUUID(), name, spins: credits,
    wheelId: saved.wheel.id, campaignId: campaign.id, amountDollars: 0 });
  await ownRecord(admin, "fans", fan.fanId, state.userId);
  ensure(typeof fan.token === "string" && fan.token.length >= 16, "FIXTURE_FAN_LINK_UNVERIFIED");
  return { kind, name, wheel: saved.wheel, target, fanId: fan.fanId, token: fan.token, balance: credits };
}
async function openFan(browser, config, state, fixture) {
  const context = await guardedContext(browser, config, state);
  const page = await context.newPage();
  await goto(page, config, `/spin/${encodeURIComponent(fixture.token)}`);
  const gate = page.getByRole("dialog", { name: "Before you spin" });
  await gate.waitFor({ timeout: 15_000 });
  await gate.getByRole("checkbox", { name: "I am 18 or older, and an adult where I live." }).check();
  await gate.getByRole("checkbox", { name: /I agree to the Terms of Service/ }).check();
  const ack = page.waitForResponse(response => new URL(response.url()).pathname === "/api/fans/ack" && response.request().method() === "POST");
  ack.catch(() => {});
  await gate.getByRole("button", { name: "Enter & spin" }).click();
  ensure((await ack).ok(), "FAN_TERMS_UNVERIFIED");
  await gate.waitFor({ state: "hidden", timeout: 15_000 });
  await page.getByTestId("fan-spin").waitFor({ timeout: 15_000 });
  return { page, context };
}
async function play(page, fixture, beforeAcknowledge) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === "/api/spin" && response.request().method() === "POST", { timeout: 45_000 });
  waiting.catch(() => {});
  await page.getByTestId("fan-spin").click();
  const response = await waiting;
  ensure(response.ok(), "BROWSER_PLAY_REFUSED");
  const result = await response.json();
  const intent = response.request().postDataJSON(); // Memory only, never written or logged.
  checkPrimaryReceipt(result, fixture.kind, fixture.balance);
  ensure(intent?.token === fixture.token && intent.requestId === result.attemptId, "PLAY_INTENT_UNVERIFIED");
  fixture.balance = result.spinsRemaining;
  if (fixture.kind === "scratch") {
    await page.getByTestId("scratch-ticket").waitFor({ timeout: 15_000 });
    const symbols = await page.getByTestId("scratch-cell").evaluateAll(cells => cells.map(cell => cell.dataset.symbolId));
    ensure(JSON.stringify(symbols) === JSON.stringify(result.presentation.cells.map(cell => cell.id)), "SCRATCH_FACE_UNVERIFIED");
    await page.getByTestId("scratch-reveal-all").focus();
    await page.keyboard.press("Enter");
  }
  await page.getByTestId("reward-reveal").waitFor({ timeout: 15_000 });
  ensure((await page.getByTestId("reward-reveal").innerText()).includes(result.prize.label), "BROWSER_REWARD_UNVERIFIED");
  if (fixture.kind === "bingo") {
    const marked = await page.getByTestId("bingo-cell").evaluateAll(cells => cells.reduce((mask, cell, index) => mask | (cell.dataset.marked === "true" ? 1 << index : 0), 0));
    ensure(marked === result.presentation.after.markedMask && (await page.getByTestId("bingo-cell").count()) === 9, "BROWSER_BINGO_MARKS_UNVERIFIED");
    ensure((await page.getByTestId("bingo-bonus").count()) === (result.bonusWins ?? []).length, "BROWSER_BINGO_BONUSES_UNVERIFIED");
  }
  if (beforeAcknowledge) await beforeAcknowledge(result);
  await page.getByRole("button", { name: "Awesome!" }).click();
  await page.getByTestId("reward-reveal").waitFor({ state: "hidden", timeout: 10_000 });
  return { result, intent };
}
async function replay(context, config, played) {
  const recovered = await api(context, config, "/api/spin", "POST", played.intent);
  checkReplay(played.result, recovered);
  const status = await api(context, config, "/api/spin/status", "POST", played.intent);
  ensure(status.status === "committed", "STATUS_OUTCOME_UNVERIFIED");
  checkReplay(played.result, status.result);
}
async function publicProof(browser, config, state, result, kind) {
  ensure(SAFE_SHARE_ID.test(result.shareId ?? ""), "PUBLIC_PROOF_ID_UNVERIFIED");
  const context = await guardedContext(browser, config, state);
  const page = await context.newPage();
  await goto(page, config, `/verify/${encodeURIComponent(result.shareId)}`);
  if (kind === "bonus") await page.getByRole("heading", { name: "Bingo line bonus verified", exact: true }).waitFor({ timeout: 15_000 });
  else {
    await page.getByText("✓ Hash matches", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByText("Replayed: these odds and seeds draw", { exact: false }).waitFor({ timeout: 15_000 });
    if (kind !== "wheel") await page.getByRole("heading", { name: kind === "scratch" ? "Replayed scratch ticket" : "Replayed bingo card", exact: true }).waitFor({ timeout: 15_000 });
  }
  await context.close();
}
async function focusJourney(browser, admin, config, state, creatorPage, report) {
  const fixture = await gameFixture(admin, config, state, "wheel");
  const pack = (await api(state.auth, config, "/api/campaign-packs", "POST", { label: "Preview Focus fixture", spins: 5, bonusSpins: 0,
    amountCents: 100, packKind: "focus", focusMultiplier: 3, focusSpins: 5 })).pack;
  await ownRecord(admin, "campaign_packs", pack?.id, state.userId);
  const eligible = await api(state.auth, config, `/api/fans/${fixture.fanId}/focus`);
  ensure(eligible.chaseEnabled === false && eligible.passes?.length === 1, "FOCUS_ELIGIBILITY_UNVERIFIED");
  await goto(creatorPage, config, "/dashboard");
  await creatorPage.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Fans", exact: true }).click();
  await creatorPage.getByRole("button", { name: `View ${fixture.name}`, exact: true }).click();
  const panel = creatorPage.getByTestId("creator-focus-panel");
  await panel.getByTestId("focus-open").click();
  await panel.getByTestId("focus-pack").selectOption(pack.id);
  await panel.getByTestId("focus-target").selectOption(fixture.target.id);
  await panel.getByTestId("focus-pass").selectOption(eligible.passes[0].id);
  await panel.getByTestId("focus-review").check();
  const granting = creatorPage.waitForResponse(response => new URL(response.url()).pathname === `/api/fans/${fixture.fanId}/focus` && response.request().method() === "POST");
  granting.catch(() => {});
  await panel.getByTestId("focus-grant").click();
  const response = await granting; ensure(response.ok(), "FOCUS_UI_GRANT_REFUSED");
  const grant = await response.json();
  ensure(grant.focus?.kind === "focus" && grant.focus.spinsLeft === 5 && grant.spinsRemaining === 7, "FOCUS_UI_GRANT_UNVERIFIED");
  fixture.balance = grant.spinsRemaining;
  const { page, context } = await openFan(browser, config, state, fixture);
  await page.getByTestId("fan-focus").waitFor({ timeout: 15_000 });
  const played = await play(page, fixture);
  ensure(played.result.focusConsumed === true && played.result.focus?.spinsLeft === 4, "FOCUS_CONSUMPTION_UNVERIFIED");
  await replay(context, config, played);
  await publicProof(browser, config, state, played.result, "wheel");
  report.focus = { creatorGrantClicked: true, fanConsentClicked: true, fanPlayClicked: true, plays: 1, consumedOnce: true, replayVerified: true, publicProofVerified: true };
  await context.close();
}
async function scratchJourney(browser, admin, config, state, report) {
  const fixture = await gameFixture(admin, config, state, "scratch");
  const { page, context } = await openFan(browser, config, state, fixture);
  const played = await play(page, fixture);
  await replay(context, config, played);
  await publicProof(browser, config, state, played.result, "scratch");
  report.scratch = { fanConsentClicked: true, fanPlayClicked: true, keyboardReveal: true, committedCellsMatched: true, plays: 1, replayVerified: true, publicProofVerified: true };
  await context.close();
}
async function bingoJourney(browser, admin, config, state, report) {
  const fixture = await gameFixture(admin, config, state, "bingo");
  const { page, context } = await openFan(browser, config, state, fixture);
  report.bingo = { fanConsentClicked: true, bound: MAX_BINGO_PLAYS, plays: 0, lineBonusVerified: false, replayVerified: false, publicProofVerified: false };
  for (let count = 0; count < MAX_BINGO_PLAYS; count++) {
    // Pace real plays under the per-fan8/10s server limit; never alter outcomes,
    // seeds, marks, counters or an already-created card to obtain a line.
    if (count) await pause(1500);
    const played = await play(page, fixture); report.bingo.plays++;
    if (count === 0) {
      ensure(played.result.presentation.newCard === true, "BINGO_FIRST_CARD_UNVERIFIED");
      await replay(context, config, played);
      await publicProof(browser, config, state, played.result, "bingo");
    }
    if (played.result.presentation.newLines.length) {
      ensure(played.result.bonusWins?.length === played.result.presentation.newLines.length && played.result.bonusWins.length > 0, "BINGO_LINE_BONUS_UNVERIFIED");
      await replay(context, config, played);
      await publicProof(browser, config, state, played.result, "bingo");
      for (const bonus of played.result.bonusWins) await publicProof(browser, config, state, bonus, "bonus");
      Object.assign(report.bingo, { lineBonusVerified: true, replayVerified: true, publicProofVerified: true, bonusCount: played.result.bonusWins.length });
      break;
    }
  }
  ensure(report.bingo.lineBonusVerified, "BINGO_LINE_NOT_OBSERVED_WITHIN_BOUND");
  await context.close();
}
async function instantFixture(admin, config, state) {
  const name = "Preview instant fixture";
  const created = await api(state.auth, config, "/api/wheels", "POST", { name, gameKind: "wheel", gameConfig: {} });
  await ownRecord(admin, "wheels", created.wheel?.id, state.userId);
  const prizes = [
    { id: randomUUID(), label: "Preview dummy code", rarity: "common", weight: 100, emoji: "◇", color: "#6366f1", stock: null, cost: 0 },
    { id: randomUUID(), label: "Preview unused manual", rarity: "common", weight: 0, emoji: "◇", color: "#6366f1", stock: null, cost: 0 },
    { id: randomUUID(), label: "Preview unlimited rare", rarity: "rare", weight: 0, emoji: "◇", color: "#6366f1", stock: null, cost: 0 },
  ];
  const { gameKindLocked: _locked, gameReady: _ready, ...editable } = created.wheel;
  const saved = await api(state.auth, config, "/api/wheel", "PUT", { wheel: { ...editable, gameKind: "wheel", gameConfig: {}, showStock: false, prizes } });
  const target = saved.wheel?.prizes?.find(prize => prize.label === prizes[0].label);
  ensure(saved.wheel?.id === created.wheel.id && UUID.test(target?.id ?? ""), "INSTANT_CONFIG_UNVERIFIED");
  // Benign nonredeemable test values exist only in memory, never artifacts.
  const codes = [1, 2].map(index => `FF-NO-VALUE-${randomBytes(12).toString("hex")}-${index}`);
  const route = `/api/prizes/${target.id}`;
  const imported = await api(state.auth, config, `${route}/codes`, "POST", { codes: [...codes, codes[0]].join("\n") });
  ensure(imported.added === 2 && imported.duplicates === 1, "INSTANT_IMPORT_UNVERIFIED");
  checkNoPrivateReward(imported, codes); checkInstantStock(imported.delivery, 2, 0, codes);
  const duplicate = await api(state.auth, config, `${route}/codes`, "POST", { codes: codes.join("\n") });
  ensure(duplicate.added === 0 && duplicate.duplicates === 2, "INSTANT_DUPLICATE_UNVERIFIED");
  checkNoPrivateReward(duplicate, codes); checkInstantStock(duplicate.delivery, 2, 0, codes);
  // Read back authoritative server weights/delivery BEFORE either paid play.
  const current = (await api(state.auth, config, `/api/wheels/${saved.wheel.id}`)).wheel;
  ensure(current?.id === saved.wheel.id && current.prizes?.length === 3
    && current.prizes.every(prize => prize.weight === (prize.id === target.id ? 100 : 0))
    && current.prizes.some(prize => prize.id === target.id && prize.delivery === "codes" && prize.stock === 2)
    && current.prizes.some(prize => prize.rarity === "rare" && prize.stock == null && prize.delivery !== "codes"), "INSTANT_CONFIG_UNVERIFIED");
  const campaign = (await api(state.auth, config, "/api/campaigns", "POST", { name, pinnedWheelId: saved.wheel.id })).campaign;
  await ownRecord(admin, "campaigns", campaign?.id, state.userId);
  const fan = await api(state.auth, config, "/api/passes", "POST", { requestId: randomUUID(), name, spins: 2,
    wheelId: saved.wheel.id, campaignId: campaign.id, amountDollars: 0 });
  await ownRecord(admin, "fans", fan.fanId, state.userId);
  ensure(typeof fan.token === "string" && fan.token.length >= 16, "FIXTURE_FAN_LINK_UNVERIFIED");
  return { kind: "wheel", name, wheel: current, target, fanId: fan.fanId, token: fan.token, balance: 2, codes };
}
async function instantJourney(browser, admin, config, state, report) {
  const fixture = await instantFixture(admin, config, state);
  const { page, context } = await openFan(browser, config, state, fixture);
  const wins = [];
  checkInstantEconomy(await api(state.auth, config, `/api/fans/${fixture.fanId}`), fixture.fanId, 2, 0);
  for (let index = 0; index < 2; index++) {
    const played = await play(page, fixture, async result => {
      checkInstantWin(result, fixture.target.id, fixture.codes);
      ensure(await page.getByTestId("reward-reveal").getByTestId("reward-value").innerText() === result.reward.value, "INSTANT_BROWSER_VALUE_UNVERIFIED");
    });
    wins.push(played);
    await replay(context, config, played);
    const delivery = await api(state.auth, config, `/api/prizes/${fixture.target.id}/reward`);
    checkInstantStock(delivery.delivery, 1 - index, 1 + index, fixture.codes);
    checkInstantEconomy(await api(state.auth, config, `/api/fans/${fixture.fanId}`), fixture.fanId, fixture.balance, 1 + index);
    await publicProof(browser, config, state, played.result, "wheel");
    const proof = await context.request.get(new URL(`/verify/${encodeURIComponent(played.result.shareId)}`, config.origin).href,
      { maxRedirects: 0, timeout: 30_000 });
    ensure(proof.ok(), "INSTANT_PUBLIC_PROOF_UNVERIFIED");
    checkPublicRewardDocument(await proof.text(), fixture.codes);
  }
  ensure(wins[0].result.reward.value !== wins[1].result.reward.value && fixture.balance === 0, "INSTANT_UNIQUENESS_UNVERIFIED");
  checkNoPrivateReward(await page.evaluate(() => [Object.values(localStorage), Object.values(sessionStorage)]), fixture.codes);
  // The history UI and its actual POST response must refer to the same wins.
  const loading = page.waitForResponse(response => new URL(response.url()).pathname === "/api/fan/reward/history" && response.request().method() === "POST");
  loading.catch(() => {});
  await page.getByTestId("reward-history-toggle").click();
  const response = await loading; ensure(response.ok(), "INSTANT_HISTORY_UNVERIFIED");
  const history = await response.json(); checkNoPrivateReward(history, fixture.codes);
  ensure(Array.isArray(history.wins) && history.wins.length === 2 && history.nextCursor === null
    && wins.every(win => history.wins.some(entry => entry.shareId === win.result.shareId)), "INSTANT_HISTORY_UNVERIFIED");
  const firstIndex = history.wins.findIndex(entry => entry.shareId === wins[0].result.shareId);
  await page.getByTestId("reward-history-win").nth(1).waitFor({ timeout: 15_000 });
  const viewing = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/fan/reward" && reply.request().method() === "POST");
  viewing.catch(() => {});
  await page.getByTestId("reward-history-win").nth(firstIndex).getByTestId("reward-history-view").click();
  const viewed = await viewing; ensure(viewed.ok() && /no-store/.test(viewed.headers()["cache-control"] ?? ""), "INSTANT_REVIEW_UNVERIFIED");
  const reopened = await viewed.json();
  ensure(reopened.reward?.kind === "code" && reopened.reward.value === wins[0].result.reward.value
    && Number.isSafeInteger(reopened.views) && reopened.views >= 2, "INSTANT_REVIEW_UNVERIFIED");
  const dialog = page.getByTestId("saved-reward-dialog");
  await dialog.getByTestId("reward-value").waitFor({ timeout: 15_000 });
  ensure(await dialog.getByTestId("reward-value").innerText() === wins[0].result.reward.value, "INSTANT_BROWSER_VALUE_UNVERIFIED");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  ensure(await page.getByTestId("reward-value").count() === 0, "INSTANT_CLOSE_UNVERIFIED");
  checkNoPrivateReward(await page.evaluate(() => [Object.values(localStorage), Object.values(sessionStorage)]), fixture.codes);
  const foreign = await api(state.auth, config, "/api/passes", "POST", { requestId: randomUUID(), name: "Preview other instant fan", spins: 1,
    wheelId: fixture.wheel.id, amountDollars: 0 });
  await ownRecord(admin, "fans", foreign.fanId, state.userId);
  ensure(foreign.fanId !== fixture.fanId && typeof foreign.token === "string" && foreign.token.length >= 16, "INSTANT_NEGATIVE_FIXTURE_UNVERIFIED");
  for (const [body, expected] of [[{ shareId: wins[0].result.shareId }, 400], [{ token: foreign.token, shareId: wins[0].result.shareId }, 404]]) {
    const denied = await context.request.post(safeApiUrl(config.origin, "/api/fan/reward"), { data: body, maxRedirects: 0, timeout: 30_000 });
    ensure(denied.status() === expected, "INSTANT_ACCESS_NEGATIVE_FAILED");
    checkNoPrivateReward(await denied.json(), fixture.codes);
  }
  // Neither recovery, history nor re-view consumes another code or credit.
  await replay(context, config, wins[1]);
  checkInstantStock((await api(state.auth, config, `/api/prizes/${fixture.target.id}/reward`)).delivery, 0, 2, fixture.codes);
  checkInstantEconomy(await api(state.auth, config, `/api/fans/${fixture.fanId}`), fixture.fanId, 0, 2);
  report.instant = { canaryPrecheckVerified: true, imported: 2, pasteDuplicates: 1, repeatDuplicates: 2,
    plays: 2, uniqueCodes: true, replayVerified: true, stockVerified: true, historyUiVerified: true,
    reviewUiVerified: true, closeClearedValue: true, browserStoragePrivateValuesAbsent: true, publicProofPrivateFieldsAbsent: true, accessNegatives: 2 };
  await context.close();
}
async function cleanup(admin, config, state) {
  if (!state.userId) return { completed: true, authDeleted: true, mediaRemaining: 0, storageRemaining: 0, publicObjectsRemaining: 0 };
  const lookup = await admin.auth.admin.getUserById(state.userId);
  const userAbsent = lookup.error?.status === 404;
  ensure(userAbsent || !lookup.error && ownFixtureUser(lookup.data?.user, state.userId, state.email), "CLEANUP_OWNERSHIP_UNVERIFIED");
  ensure(!(userAbsent && !state.createAcknowledged), "CLEANUP_CREATE_UNCONFIRMED");
  const media = await admin.from("creator_media").select("id").eq("creator_id", state.userId).limit(101);
  ensure(!media.error && media.data?.length <= 100, "CLEANUP_MEDIA_UNVERIFIED");
  for (const row of media.data) {
    ensure(UUID.test(row.id) && state.auth, "CLEANUP_MEDIA_UNVERIFIED");
    ensure((await api(state.auth, config, `/api/account/media/${row.id}`, "DELETE")).ok === true, "CLEANUP_MEDIA_UNVERIFIED");
  }
  const mediaLeft = await admin.from("creator_media").select("id", { count: "exact", head: true }).eq("creator_id", state.userId);
  const storageLeft = await admin.from("creator_storage_objects").select("id", { count: "exact", head: true }).eq("owner_id", state.userId).is("removed_at", null);
  ensure(!mediaLeft.error && !storageLeft.error, "CLEANUP_STORAGE_UNVERIFIED");
  // This smoke uploads no bytes. Any unexpected object/folder fails closed;
  // do not erase its recovery metadata by deleting Auth first.
  let publicObjects = 0;
  for (const bucket of ["avatars", "creator-media"]) {
    const listing = await admin.storage.from(bucket).list(state.userId, { limit: 1 });
    ensure(!listing.error && Array.isArray(listing.data), "CLEANUP_PUBLIC_BYTES_UNVERIFIED");
    publicObjects += listing.data.length;
  }
  checkCleanupBeforeAuth({ acknowledged: state.createAcknowledged, userAbsent,
    owned: ownFixtureUser(lookup.data?.user, state.userId, state.email), media: mediaLeft.count, storage: storageLeft.count, publicObjects });
  if (!userAbsent) ensure(!(await admin.auth.admin.deleteUser(state.userId)).error, "CLEANUP_AUTH_FAILED");
  const absent = await admin.auth.admin.getUserById(state.userId);
  ensure(!absent.data?.user && absent.error?.status === 404, "CLEANUP_AUTH_UNVERIFIED");
  return { completed: true, authDeleted: true, mediaRemaining: 0, storageRemaining: 0, publicObjectsRemaining: 0 };
}

async function main() {
  const report = { version: 1, executed: false, sourceSha: null, workflowRunId: null, provenance: null,
    focus: null, scratch: null, bingo: null, instant: null, chaseEnabledBySmoke: false, cleanup: null, browserSignals: null, errors: [] };
  const state = { userId: null, email: null, createAcknowledged: false, auth: null, contexts: [], counters: { blockedRequests: 0, pageErrors: 0, consoleErrors: 0 } };
  let config, admin, browser, preflightOnly = false, stage = "preflight";
  try {
    // Never let inherited protocol debugging print headers or locator fill
    // values, including during the authenticated metadata-only preflight.
    delete process.env.DEBUG; delete process.env.PWDEBUG;
    delete process.env.NODE_DEBUG; delete process.env.NODE_DEBUG_NATIVE;
    ensure(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === "--preflight"), "INVALID_ARGUMENTS");
    preflightOnly = process.argv[2] === "--preflight";
    ensure(createHash("sha256").update(readFileSync(new URL("./preview-lcp-guards.mjs", import.meta.url))).digest("hex") === SHARED_GUARD_SHA256, "SHARED_PREVIEW_GUARD_CHANGED");
    config = previewFeatureEnvironment(process.env, { preflight: preflightOnly });
    checkCheckoutIdentity(config.expectedSha,
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    // SUP-5: only the preflight step holds VERCEL_TOKEN and reads Vercel; the
    // smoke step trusts that step's record from the same workflow run.
    let provenance;
    if (preflightOnly) {
      provenance = await verifyPreviewDeployment(config);
    } else {
      let record;
      try { record = JSON.parse(readFileSync(new URL("preflight.json", OUTPUT), "utf8")); } catch { refuse("PREFLIGHT_NOT_VERIFIED"); }
      provenance = checkPreflightRecord(config, record);
    }
    report.sourceSha = config.expectedSha; report.workflowRunId = config.runId;
    report.provenance = { deploymentId: provenance.deploymentId, target: provenance.target, sourceShaMatched: true, projectVerified: true, teamVerified: true };
    if (preflightOnly) writeReport("preflight.json", preflightRecord(config, provenance));
    if (preflightOnly) { console.log("Preview feature preflight verified: exact source, immutable Preview, project/team and TEST."); return; }
    const [{ createClient }, { chromium }] = await Promise.all([import("@supabase/supabase-js"), import("playwright")]);
    const testFetch = (input, options) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      ensure(url.origin === TEST_ORIGIN, "UNEXPECTED_ADMIN_ORIGIN");
      return fetch(input, { ...options, redirect: "error", signal: AbortSignal.timeout(30_000) });
    };
    admin = createClient(config.databaseOrigin, config.service, { auth: { persistSession: false, autoRefreshToken: false, debug: false }, global: { fetch: testFetch } });
    stage = "instant-health";
    const health = await admin.from("system_health_checks").select("canary_status,canary_checked_at,canary_failure_at").eq("singleton", true).maybeSingle();
    ensure(!health.error, "INSTANT_CANARY_NOT_VERIFIED"); checkInstantHealth(health.data);
    stage = "fixture";
    const credentials = await createFixture(admin, config.runId, state);
    await chaseRemainsOff(admin, state);
    browser = await chromium.launch({ env: browserEnvironment(process.env) });
    stage = "login-and-terms";
    const creatorPage = await login(browser, admin, config, credentials, state);
    stage = "focus"; await focusJourney(browser, admin, config, state, creatorPage, report);
    stage = "scratch"; await scratchJourney(browser, admin, config, state, report);
    stage = "bingo"; await bingoJourney(browser, admin, config, state, report);
    stage = "instant"; await instantJourney(browser, admin, config, state, report);
    await chaseRemainsOff(admin, state);
    ensure(Object.values(state.counters).every(count => count === 0), "FEATURE_BROWSER_SIGNAL_FAILURE");
    report.executed = true;
  } catch (error) {
    report.errors.push({ stage, code: failureCode(error) });
    if (stage === "preflight") writeReport("preflight.json", { verified: false, errors: report.errors });
  } finally {
    if (!preflightOnly) {
      if (admin && config) {
        try { report.cleanup = await cleanup(admin, config, state); }
        catch (error) { report.errors.push({ stage: "cleanup", code: failureCode(error) }); report.cleanup = { completed: false, requiresRecoveryReview: true }; }
      }
      for (const context of state.contexts) await context.close().catch(() => { report.errors.push({ stage: "cleanup", code: "CONTEXT_CLOSE_FAILED" }); });
      if (browser) await browser.close().catch(() => { report.errors.push({ stage: "cleanup", code: "BROWSER_CLOSE_FAILED" }); });
      report.browserSignals = state.counters;
      writeReport("report.json", report);
    }
    if (report.errors.length) {
      console.error(`Preview feature smoke failed: ${report.errors.map(error => `${error.stage}:${error.code}`).join(", ")}. Private details suppressed.`);
      process.exitCode = 1;
    } else if (!preflightOnly) console.log(`Preview feature smoke passed: Focus1, Scratch1, Bingo${report.bingo.plays}/${MAX_BINGO_PLAYS}, Instant2; replay, public proofs and fixture cleanup verified.`);
  }
}
main().catch(() => { console.error("Preview feature smoke failed before safe reporting."); process.exitCode = 1; });
