// Manual, authenticated Preview-only lab measurement. Never logs credentials,
// response bodies, cookies, storage state, authenticated screenshots or URLs.
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  SAMPLE_COUNT, TEST_ORIGIN, browserEnvironment, checkCheckoutIdentity, failureCode, fixturePhotoUrl,
  previewPerfEnvironment, refuse, summarizeLcp, verifyPreviewDeployment,
} from "./preview-lcp-guards.mjs";

const OUTPUT = new URL("./artifacts/preview-lcp/", import.meta.url);
const CONDITIONS = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, cpuSlowdown: 4,
  network: { latencyMs: 150, downloadBytesPerSecond: 200_000, uploadBytesPerSecond: 93_750, connectionType: "cellular4g" },
  samplesPerVariant: SAMPLE_COUNT, browserCache: "disabled and cleared before each sample",
  browserContext: "fresh anonymous mobile context per sample; service workers blocked",
  serverCache: "state verified/warmed before samples; actual x-vercel-cache recorded per sample",
  lcpWindow: "buffered observer from document start; finalize with first pointer input after font/photo readiness plus2500ms",
  percentile: "nearest rank: p75 is fourth of five ordered samples; median is third",
  scope: "Chromium lab comparison, not field p75 or an all-device performance claim",
};
const round = number => Math.round(number * 1000) / 1000;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function writeReport(name, value) { mkdirSync(OUTPUT, { recursive: true }); writeFileSync(new URL(name, OUTPUT), JSON.stringify(value, null, 2) + "\n"); }
function data(reply, code) { if (reply.error || reply.data == null) refuse(code); return reply.data; }
async function api(context, origin, path, method = "GET", options = {}) {
  const response = await context.request.fetch(origin + path, { method, maxRedirects: 0, timeout: 30_000, ...options });
  if (!response.ok()) refuse("PREVIEW_API_REFUSED");
  return response.json();
}
async function guardBrowserContext(context, origin, counters) {
  // Intercept before the network: a wrongly configured app must not send a
  // login request to Production or a third-party origin. No header is read.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.protocol === "https:" && (url.origin === origin || url.origin === TEST_ORIGIN)) return route.continue();
    counters.blockedRequests++;
    return route.abort("blockedbyclient");
  });
}
async function fixtureUser(admin, runId, state) {
  const email = `e2e-preview-lcp-${runId}-${randomBytes(6).toString("hex")}@fanfunnel.test`;
  const password = randomBytes(32).toString("base64url") + "aA1!";
  // Supabase AdminUserAttributes supports a supplied id. Save it BEFORE the
  // call so a lost create acknowledgement still has a precise cleanup target.
  state.userId = randomUUID(); state.email = email;
  const created = data(await admin.auth.admin.createUser({ id: state.userId, email, password, email_confirm: true }), "FIXTURE_CREATE_FAILED");
  if (created.user?.id !== state.userId) refuse("FIXTURE_CREATE_FAILED");
  state.createAcknowledged = true;
  let profile;
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await admin.from("profiles").select("id").eq("id", state.userId).maybeSingle();
    if (reply.error) refuse("FIXTURE_PROFILE_FAILED");
    if (reply.data) { profile = reply.data; break; }
    await pause(250);
  }
  if (!profile) refuse("FIXTURE_PROFILE_FAILED");
  state.slug = `lcp-${runId}-${randomBytes(6).toString("hex")}`;
  data(await admin.from("profiles").update({ approval_status: "approved", is_active: true, role: "creator",
    display_name: "Performance fixture", public_tagline: `Preview performance check · run${runId}`,
    public_slug: state.slug, tip_url: null, avatar_url: null }).eq("id", state.userId).select("id").single(), "FIXTURE_PROFILE_FAILED");
  return { email, password };
}
async function loginFixture(browser, admin, config, credentials, state) {
  state.auth = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await guardBrowserContext(state.auth, config.origin, state.counters);
  const page = await state.auth.newPage();
  const response = await page.goto(config.origin + "/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!response?.ok() || new URL(page.url()).origin !== config.origin) refuse("PREVIEW_ACCESS_DENIED");
  await page.locator("input[aria-label='Email address']").fill(credentials.email);
  await page.locator("input[aria-label='Password']").fill(credentials.password);
  await page.locator("button[type='submit']").filter({ hasText: /^Sign in$/ }).click();
  await page.waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30_000 });
  if (state.counters.blockedRequests) refuse("UNEXPECTED_BROWSER_ORIGIN");
  const identity = await api(state.auth, config.origin, "/api/public-profile");
  if (identity.slug !== state.slug) refuse("FIXTURE_SESSION_MISMATCH");
  let terms = await api(state.auth, config.origin, "/api/account/terms");
  if (terms.needsAcceptance === true) {
    const prompt = page.getByTestId("terms-prompt");
    await prompt.waitFor({ timeout: 15_000 });
    await prompt.getByTestId("terms-checkbox").check();
    await prompt.getByRole("button", { name: "Agree and continue" }).click();
    await prompt.waitFor({ state: "hidden", timeout: 15_000 });
    terms = await api(state.auth, config.origin, "/api/account/terms");
  }
  if (terms.needsAcceptance !== false || typeof terms.current !== "string" || terms.version !== terms.current || !terms.acceptedAt) refuse("TERMS_ACCEPTANCE_UNVERIFIED");
  const profile = data(await admin.from("profiles").select("terms_version,terms_accepted_at").eq("id", state.userId).single(), "TERMS_ACCEPTANCE_UNVERIFIED");
  if (profile.terms_version !== terms.current || !profile.terms_accepted_at) refuse("TERMS_ACCEPTANCE_UNVERIFIED");
  // Leave no authenticated form/page for screenshots. The context's private
  // in-memory session is used only for the actual creator HTTP endpoints.
  await page.close();
}
async function syntheticPhoto(sharp) {
  const width = 1280, height = 960, pixels = Buffer.alloc(width * height * 3);
  let noise = 0x739281;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const grain = (noise >>> 26) - 32, at = (y * width + x) * 3;
    pixels[at] = Math.max(0, Math.min(255, 45 + Math.round(x / width * 150) + grain));
    pixels[at + 1] = Math.max(0, Math.min(255, 60 + Math.round(y / height * 130) + grain));
    pixels[at + 2] = Math.max(0, Math.min(255, 145 + Math.round((x + y) / (width + height) * 75) + grain));
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
async function inspectTheme(page, expected) {
  await page.locator(`main[data-theme-font='${expected.font}'][data-theme-background='${expected.background}']`).waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  const observed = await page.evaluate(() => {
    const heading = document.querySelector("main h1");
    const family = heading ? getComputedStyle(heading).fontFamily : "";
    const primary = family.split(",")[0].replaceAll('"', "").replaceAll("'", "").trim().toLowerCase();
    const loaded = Array.from(document.fonts).some(font => font.status === "loaded" && !/fallback/i.test(font.family)
      && font.family.replaceAll('"', "").replaceAll("'", "").trim().toLowerCase() === primary);
    const photo = document.querySelector("[data-testid='theme-backdrop'] [data-testid='theme-photo']");
    return { family, loaded, heading: heading?.textContent, photoCount: document.querySelectorAll("[data-testid='theme-backdrop'] [data-testid='theme-photo']").length,
      photoUrl: photo?.currentSrc ?? null, photoLoaded: !!photo && photo.complete && photo.naturalWidth > 0,
      teaserPrizes: document.querySelectorAll("[data-testid='teaser-prize']").length };
  });
  if (observed.heading !== "Performance fixture" || !observed.loaded || !observed.family.toLowerCase().includes(expected.font === "bricolage" ? "bricolage" : "unbounded")) refuse("COMPUTED_FONT_UNVERIFIED");
  if (expected.background === "photo") {
    await page.waitForFunction(() => { const image = document.querySelector("[data-testid='theme-backdrop'] [data-testid='theme-photo']"); return image?.complete && image.naturalWidth > 0; }, { timeout: 45_000 });
    const actual = await page.locator("[data-testid='theme-backdrop'] [data-testid='theme-photo']").getAttribute("src");
    if (observed.photoCount !== 1 || fixturePhotoUrl(actual, expected.owner) !== expected.photoUrl) refuse("PHOTO_BACKGROUND_UNVERIFIED");
  } else if (observed.photoCount !== 0) refuse("DEFAULT_BACKGROUND_UNVERIFIED");
  return { computedFontFamily: observed.family, selectedFontLoaded: true, photoBackgroundConfirmed: expected.background === "photo", teaserPrizes: observed.teaserPrizes };
}
async function warmPublicState(browser, config, state, expected) {
  const context = await browser.newContext({ viewport: CONDITIONS.viewport, serviceWorkers: "block" });
  try {
    await guardBrowserContext(context, config.origin, state.counters);
    const page = await context.newPage();
    // On-demand ISR invalidation may serve one stale response while rebuilding.
    // This is state preparation, not a discarded performance sample.
    for (let retry = 0; retry < 6; retry++) {
      const response = await page.goto(`${config.origin}/c/${state.slug}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (!response?.ok() || new URL(page.url()).origin !== config.origin) refuse("PUBLIC_PAGE_UNAVAILABLE");
      const keys = await page.locator("main[data-theme-font]").evaluate(element => [element.dataset.themeFont, element.dataset.themeBackground]);
      if (keys[0] === expected.font && keys[1] === expected.background) { await inspectTheme(page, expected); return; }
      await pause(12_000);
    }
    refuse("PUBLIC_THEME_STALE");
  } finally { await context.close(); }
}
async function sample(browser, config, state, expected, index) {
  const context = await browser.newContext({ viewport: CONDITIONS.viewport, screen: CONDITIONS.viewport, deviceScaleFactor: CONDITIONS.deviceScaleFactor,
    isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "no-preference", serviceWorkers: "block" });
  try {
    if ((await context.cookies()).length !== 0) refuse("ANONYMOUS_CONTEXT_UNVERIFIED");
    await guardBrowserContext(context, config.origin, state.counters);
    const page = await context.newPage();
    let browserErrors = 0;
    page.on("pageerror", () => { browserErrors++; });
    page.on("console", message => { if (message.type() === "error") browserErrors++; });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: CONDITIONS.network.latencyMs, downloadThroughput: CONDITIONS.network.downloadBytesPerSecond,
      uploadThroughput: CONDITIONS.network.uploadBytesPerSecond, connectionType: CONDITIONS.network.connectionType });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CONDITIONS.cpuSlowdown });
    await page.addInitScript(() => {
      window.__ffPreviewLcp = { supported: PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint"), latest: null };
      if (!window.__ffPreviewLcp.supported) return;
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__ffPreviewLcp.latest = { startTime: entry.startTime, renderTime: entry.renderTime, loadTime: entry.loadTime, size: entry.size, elementTag: entry.element?.tagName ?? null };
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    });
    const response = await page.goto(`${config.origin}/c/${state.slug}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (!response?.ok() || new URL(page.url()).origin !== config.origin) refuse("PUBLIC_PAGE_UNAVAILABLE");
    const theme = await inspectTheme(page, expected);
    const readyMs = await page.evaluate(() => performance.now());
    await page.waitForTimeout(2500);
    // Trusted first input finalizes LCP. Coordinate1,1 is the decorative page
    // background, not a link/control; it occurs only after all critical assets.
    await page.mouse.click(1, 1);
    await page.waitForTimeout(100);
    const measurement = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      return { lcp: window.__ffPreviewLcp, ttfb: navigation.responseStart - navigation.requestStart,
        domContentLoaded: navigation.domContentLoadedEventEnd, transferredDocumentBytes: navigation.transferSize };
    });
    if (!measurement.lcp?.supported || !measurement.lcp.latest || !Number.isFinite(measurement.lcp.latest.startTime) || measurement.lcp.latest.startTime <= 0) refuse("LCP_NOT_OBSERVED");
    if (state.counters.blockedRequests) refuse("UNEXPECTED_BROWSER_ORIGIN");
    if (browserErrors) refuse("PERFORMANCE_PAGE_BROWSER_ERROR");
    if (new URL(page.url()).origin !== config.origin || new URL(page.url()).pathname !== `/c/${state.slug}`) refuse("PUBLIC_PAGE_NAVIGATED");
    const entry = measurement.lcp.latest;
    // Only this fresh anonymous public page is ever photographed. No auth
    // page, HAR, trace, headers, cookies, session storage or URL is written.
    await page.screenshot({ path: new URL(`${expected.name}-${index}.png`, OUTPUT).pathname, fullPage: false });
    return { index, lcpMs: round(entry.startTime), lcpRenderMs: round(entry.renderTime), lcpLoadMs: round(entry.loadTime), lcpSize: entry.size, lcpElementTag: entry.elementTag,
      ttfbMs: round(measurement.ttfb), domContentLoadedMs: round(measurement.domContentLoaded), criticalAssetsReadyMs: round(readyMs),
      transferredDocumentBytes: measurement.transferredDocumentBytes, edgeCache: response.headers()["x-vercel-cache"] ?? "unreported", ...theme };
  } finally { await context.close(); }
}
async function cleanupFixture(admin, config, state) {
  const result = { photoRowsRemaining: 0, storageObjectsRemaining: 0, authDeleted: state.userId === null, completed: true };
  if (!state.userId) return result;
  const fixture = await admin.auth.admin.getUserById(state.userId);
  const userAbsent = fixture.error?.status === 404;
  // A missing row cannot disprove a still-in-flight create whose response was
  // lost. Preserve an explicit failure instead of claiming cleanup completed.
  if (userAbsent && !state.createAcknowledged) refuse("CLEANUP_CREATE_UNCONFIRMED");
  if (!userAbsent && (fixture.error || fixture.data?.user?.id !== state.userId || fixture.data.user.email !== state.email)) refuse("CLEANUP_OWNERSHIP_UNVERIFIED");
  let media = await admin.from("creator_media").select("id").eq("creator_id", state.userId);
  if (media.error) refuse("CLEANUP_MEDIA_UNVERIFIED");
  const ids = [...new Set([...(media.data ?? []).map(row => row.id), ...state.photoIds])];
  for (const id of ids) {
    if (!UUID.test(id) || !state.auth) refuse("CLEANUP_MEDIA_UNVERIFIED");
    // Even a lost upload acknowledgement is recovered by the owner-filtered
    // metadata query. Never delete another creator's supplied response ID.
    const owned = await admin.from("creator_media").select("id").eq("creator_id", state.userId).eq("id", id).maybeSingle();
    if (owned.error) refuse("CLEANUP_MEDIA_UNVERIFIED");
    if (!owned.data) continue;
    const removed = await api(state.auth, config.origin, `/api/account/media/${encodeURIComponent(id)}`, "DELETE");
    if (removed.ok !== true) refuse("CLEANUP_MEDIA_UNVERIFIED");
  }
  media = await admin.from("creator_media").select("id", { count: "exact", head: true }).eq("creator_id", state.userId);
  const storage = await admin.from("creator_storage_objects").select("id", { count: "exact", head: true }).eq("owner_id", state.userId).is("removed_at", null);
  if (media.error || storage.error || media.count == null || storage.count == null) refuse("CLEANUP_STORAGE_UNVERIFIED");
  result.photoRowsRemaining = media.count; result.storageObjectsRemaining = storage.count;
  // Public bytes precede Auth deletion. Uncertainty keeps the isolated TEST
  // fixture for durable recovery and fails CI; it is never hidden as success.
  if (media.count || storage.count) refuse("CLEANUP_PENDING_STORAGE");
  if (userAbsent) return { ...result, authDeleted: true };
  const deleted = await admin.auth.admin.deleteUser(state.userId);
  if (deleted.error) refuse("CLEANUP_AUTH_FAILED");
  const absent = await admin.auth.admin.getUserById(state.userId);
  if (absent.data?.user || absent.error?.status !== 404) refuse("CLEANUP_AUTH_UNVERIFIED");
  result.authDeleted = true;
  return result;
}

async function main() {
  const report = { version: 1, measured: false, sourceSha: null, workflowRunId: null, provenance: null, conditions: CONDITIONS, variants: [], errors: [], cleanup: null };
  const state = { userId: null, email: null, createAcknowledged: false, slug: null, auth: null, photoIds: [], counters: { blockedRequests: 0 } };
  let config, admin, browser, stage = "preflight", preflightOnly = false;
  try {
    if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== "--preflight") refuse("INVALID_ARGUMENTS");
    preflightOnly = process.argv[2] === "--preflight";
    config = previewPerfEnvironment(process.env);
    checkCheckoutIdentity(config.expectedSha,
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const provenance = await verifyPreviewDeployment(config);
    report.sourceSha = config.expectedSha; report.workflowRunId = config.runId;
    report.provenance = { deploymentId: provenance.deploymentId, target: provenance.target, sourceShaMatched: true, projectVerified: true, teamVerified: true };
    writeReport("preflight.json", { verified: true, ...report.provenance });
    if (preflightOnly) { console.log("Preview LCP preflight verified: exact source, immutable Preview, project/team and TEST configuration."); return; }
    stage = "fixture";
    // Protocol/API debug logs can include fill arguments or auth headers.
    // This command intentionally reports only redacted codes and lab metrics.
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    const [{ createClient }, { chromium }, { default: sharp }] = await Promise.all([import("@supabase/supabase-js"), import("playwright"), import("sharp")]);
    admin = createClient(config.databaseOrigin, config.service, { auth: { persistSession: false, autoRefreshToken: false, debug: false } });
    const credentials = await fixtureUser(admin, config.runId, state);
    browser = await chromium.launch({ env: browserEnvironment(process.env) });
    report.runtime = { chromium: browser.version(), node: process.version, runnerOS: process.env.RUNNER_OS ?? "unreported" };
    await loginFixture(browser, admin, config, credentials, state);
    const baseline = { name: "default", font: "bricolage", background: "glow", owner: state.userId };
    const savedDefault = await api(state.auth, config.origin, "/api/account/theme", "PUT", { data: { font: baseline.font, background: baseline.background, bgMediaId: null } });
    if (savedDefault.ok !== true) refuse("THEME_SAVE_UNVERIFIED");
    stage = "default";
    await warmPublicState(browser, config, state, baseline);
    const defaultVariant = { name: baseline.name, samples: [], summary: null };
    report.variants.push(defaultVariant);
    for (let index = 1; index <= SAMPLE_COUNT; index++) defaultVariant.samples.push(await sample(browser, config, state, baseline, index));
    defaultVariant.summary = summarizeLcp(defaultVariant.samples.map(row => row.lcpMs));
    stage = "themed-upload";
    const bytes = await syntheticPhoto(sharp);
    const uploaded = await api(state.auth, config.origin, "/api/account/media", "POST", { multipart: { file: { name: "abstract-performance-fixture.png", mimeType: "image/png", buffer: bytes }, caption: "Abstract color gradient", sfw: "yes" } });
    if (!UUID.test(uploaded.media?.id ?? "")) refuse("PHOTO_UPLOAD_UNVERIFIED");
    state.photoIds.push(uploaded.media.id);
    const owned = data(await admin.from("creator_media").select("id").eq("creator_id", state.userId).eq("id", uploaded.media.id).single(), "PHOTO_OWNERSHIP_UNVERIFIED");
    if (owned.id !== uploaded.media.id) refuse("PHOTO_OWNERSHIP_UNVERIFIED");
    const themed = { name: "photo-custom-font", font: "unbounded", background: "photo", owner: state.userId, photoUrl: fixturePhotoUrl(uploaded.media.url, state.userId) };
    const saved = await api(state.auth, config.origin, "/api/account/theme", "PUT", { data: { font: themed.font, background: themed.background, bgMediaId: uploaded.media.id } });
    if (saved.ok !== true) refuse("THEME_SAVE_UNVERIFIED");
    stage = "photo-custom-font";
    await warmPublicState(browser, config, state, themed);
    const themedVariant = { name: themed.name, syntheticInputBytes: bytes.length, samples: [], summary: null };
    report.variants.push(themedVariant);
    for (let index = 1; index <= SAMPLE_COUNT; index++) themedVariant.samples.push(await sample(browser, config, state, themed, index));
    themedVariant.summary = summarizeLcp(themedVariant.samples.map(row => row.lcpMs));
    report.measured = true;
    report.comparison = { medianDeltaMs: round(themedVariant.summary.medianMs - defaultVariant.summary.medianMs), p75DeltaMs: round(themedVariant.summary.p75Ms - defaultVariant.summary.p75Ms) };
  } catch (error) {
    report.errors.push({ stage, code: failureCode(error) });
    if (stage === "preflight") writeReport("preflight.json", { verified: false, errors: report.errors });
  } finally {
    if (!preflightOnly) {
      if (admin && config) {
        try { report.cleanup = await cleanupFixture(admin, config, state); }
        catch (error) { report.errors.push({ stage: "cleanup", code: failureCode(error) }); report.cleanup = { completed: false, requiresRecoveryReview: true }; }
      }
      if (state.auth) await state.auth.close().catch(() => { report.errors.push({ stage: "cleanup", code: "AUTH_CONTEXT_CLOSE_FAILED" }); });
      if (browser) await browser.close().catch(() => { report.errors.push({ stage: "cleanup", code: "BROWSER_CLOSE_FAILED" }); });
      writeReport("report.json", report);
    }
    if (report.errors.length) {
      console.error(`Preview LCP ${preflightOnly ? "preflight" : "measurement"} failed: ${report.errors.map(error => error.code).join(", ")}. No secret details emitted.`);
      process.exitCode = 1;
    } else if (!preflightOnly) {
      for (const variant of report.variants) console.log(`${variant.name}: n=${variant.summary.samples} median=${variant.summary.medianMs}ms p75=${variant.summary.p75Ms}ms`);
      console.log("Preview LCP lab measurement completed; fixture cleanup confirmed. This is not a field p75 claim.");
    }
  }
}
main().catch(() => { console.error("Preview LCP failed before safe reporting."); process.exitCode = 1; });
