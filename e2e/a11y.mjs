// Accessibility scan — runs axe-core (WCAG 2.0/2.1 A + AA) against the key
// pages in mock mode and fails the build on any *critical* or *serious*
// violation (moderate/minor are reported as advisories so the gate is
// meaningful without drowning in nitpicks). No secrets needed.
//
//   npm run build && npm run e2e:a11y
//   E2E_BASE_URL=<url> node e2e/a11y.mjs   (against a running server)

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { startServer, stopServer, goto, passAgeGate, clickTab, log, BASE, MORE_BUTTON } from "./harness.mjs";
import { createRevealFan, forceRarity, clearForcedRarity, spinAndTime } from "./reveal.mjs";
import { mintFanLink, fakeInstallPrompt, spinAndCloseWin, IPHONE_UA } from "./pwa.mjs";
import { staleTermsRoute } from "./journeys.mjs";

const AXE_SRC = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const openTab = (name) => async (page) => {
  await clickTab(page, name);
  await page.waitForTimeout(600);
};
const openMore = async (page) => {
  await page.locator(MORE_BUTTON).click();
  await page.getByRole("dialog", { name: "More" }).waitFor({ timeout: 4000 });
  await page.waitForTimeout(500);
};
// e2e's first-run step wipes the demo account before this scan runs on the same
// server, so open whichever fan exists and create one if none does.
const openFanSheet = async (page) => {
  const { fans } = await (await page.request.get(BASE + "/api/fans")).json().catch(() => ({ fans: [] }));
  if (!fans?.length) {
    const res = await page.request.post(BASE + "/api/passes", { data: { name: "A11y Fan", spins: 3 } });
    if (!res.ok()) throw new Error(`could not create a fan for the scan (${res.status()})`);
    await page.reload();
  }
  await clickTab(page, "Fans");
  await page.getByRole("button", { name: /^View / }).first().click();
  await page.getByRole("dialog", { name: "Fan details" }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(800);
};
// 0055: the creator's Terms prompt, forced by a stale version (the demo account
// itself stays accepted, so nothing here depends on e2e's data).
const openTermsPrompt = (ticked) => async (page) => {
  await staleTermsRoute(page);
  await page.reload();
  await page.getByTestId("terms-prompt").waitFor({ timeout: 10000 });
  if (ticked) await page.getByTestId("terms-prompt").getByTestId("terms-checkbox").check();
  await page.waitForTimeout(400);
};
const closeTermsPrompt = async (page) => {
  await page.unroute("**/api/account/terms").catch(() => {});
};
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

// RM-4: the fan's home-screen install card, on a freshly minted link (so it
// doesn't depend on demo data surviving the first-run wipe), in a fresh
// context per platform (own storage, so no earlier "Not now" hides it).
const installNudge = (platform) => async (page) => {
  const token = await mintFanLink(page.request, 2);
  await goto(page, `/spin/${token}`, 1800);
  await passAgeGate(page);
  if (platform === "android") await fakeInstallPrompt(page);
  await spinAndCloseWin(page);
  const nudge = page.locator("[data-testid='install-nudge']");
  await nudge.waitFor({ timeout: 5000 });
  if (platform === "ios") await nudge.getByRole("button", { name: "How" }).click();
  await page.waitForTimeout(400);
};
const PHONE_CTX = { isMobile: true, hasTouch: true };

// RD-8: overlays and editors. Each prep only needs what survives e2e's
// first-run wipe (the fan comes from openFanSheet, the rest is static UI).
const openBell = async (page) => {
  await page.getByTestId("notification-bell").click();
  await page.getByRole("dialog", { name: "Notifications" }).waitFor({ timeout: 4000 });
  await page.waitForTimeout(500);
};
const inDrawer = (name) => async (page) => {
  await openFanSheet(page);
  await page.getByRole("dialog", { name: "Fan details" }).getByRole("button", { name }).first().click();
  await page.waitForTimeout(600);
};
const clickIn = (tab, name) => async (page) => {
  await clickTab(page, tab);
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(600);
};

// Fairness v3: a fresh spin's verify page with its odds table. The fan and the
// spin are made here, so the state doesn't depend on demo data surviving e2e.
const openFreshVerify = async (page) => {
  const pass = await (await page.request.post(BASE + "/api/passes", { data: { name: "A11y Verify", spins: 1 } })).json();
  if (!pass?.token) throw new Error("could not create a fan for the verify scan");
  const ack = await page.request.post(BASE + "/api/fans/ack", { data: { token: pass.token } });
  if (!ack.ok()) throw new Error(`could not acknowledge the age gate (${ack.status()})`);
  const res = await page.request.post(BASE + "/api/spin", { data: { token: pass.token, clientSeed: "a11y" } });
  const spin = await res.json().catch(() => null);
  if (!spin?.shareId) throw new Error(`could not spin for the verify scan (${res.status()})`);
  await goto(page, `/verify/${spin.shareId}`, 1200);
  await page.getByRole("table").waitFor({ timeout: 5000 });
};

// Pages to scan + an optional prep step to reach a meaningful state.
//
// `advisory` lists rule ids that are reported but NOT blocking for that page.
// The dashboard used to treat `color-contrast` as advisory while white text sat
// on the creator's `--brand` (3.52:1 on the default pink). Brand fills now use
// `--brand-ink` (readableInk) and initials avatars use ink on the brand tint,
// so since RD-8 every rule blocks on every page, the dashboard included.
const DASH_ADVISORY = [];
// RM-1: the win reveal. A fresh fan each time (e2e's first-run step has wiped
// the demo fan by now); the rarity is forced on the real spin response only.
const openReveal = (rarity, { reduced = false } = {}) => async (page) => {
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  const token = await createRevealFan(page.request, "A11y Reveal Fan", 2);
  await goto(page, `/spin/${token}`, 1400);
  await forceRarity(page, rarity);
  await spinAndTime(page);
  await page.getByTestId("reward-reveal").waitFor({ timeout: 9000 });
  await page.waitForTimeout(900); // let the entrance settle
};
const closeReveal = async (page) => {
  await page.emulateMedia({ reducedMotion: null }).catch(() => {});
  await clearForcedRarity(page);
};
// RM-2: the fan page's Limited row and the prize book's counts. The wheel is
// set through the creator API (e2e's first-run step may have left it empty),
// with a low-stock, a sold-out and an unlimited prize, then a fresh fan.
const openStock = async (page) => {
  const { wheel } = await (await page.request.get(BASE + "/api/wheel")).json();
  const prizes = [
    { id: "a11y-s1", label: "Signed Polaroid", rarity: "epic", weight: 5, emoji: "📸", stock: 2 },
    { id: "a11y-s2", label: "VIP Month Free", rarity: "legendary", weight: 1, emoji: "👑", stock: 0 },
    { id: "a11y-s3", label: "Exclusive Selfie", rarity: "common", weight: 50, emoji: "🤳" },
  ];
  const put = await page.request.put(BASE + "/api/wheel", { data: { wheel: { ...wheel, showStock: true, prizes } } });
  if (!put.ok()) throw new Error(`could not set a stocked wheel for the scan (${put.status()})`);
  const token = await createRevealFan(page.request, "A11y Stock Fan", 2);
  await goto(page, `/spin/${token}`, 1400);
  await page.getByTestId("limited-stock").waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: /Prize book/ }).click();
  await page.waitForTimeout(400);
};

const PAGES = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/terms", name: "terms" },
  { path: "/privacy", name: "privacy" },
  { path: "/c/demo", name: "link-in-bio" },
  { path: "/dashboard", name: "dashboard (Today)", advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Wheel editor)", prep: openTab("Wheel"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Fans)", prep: openTab("Fans"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Fulfilment)", prep: openTab("Fulfilment"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Admin)", prep: openTab("Admin"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Analytics)", prep: openTab("Analytics"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Boosts)", prep: openTab("Boosts"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Settings)", prep: openTab("Settings"), advisory: DASH_ADVISORY },
  // Phone layout (RD-6): bottom tab bar, the More sheet, the fan bottom sheet.
  { path: "/dashboard", name: "dashboard phone (tab bar)", viewport: PHONE, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (More sheet)", viewport: PHONE, prep: openMore, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (fan sheet)", viewport: PHONE, prep: openFanSheet, advisory: DASH_ADVISORY },
  // RD-8: every remaining section, the bell, the drawer and its menus, and the
  // modals, on desktop and phone.
  { path: "/dashboard", name: "dashboard (Inbox)", prep: openTab("Inbox"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Campaigns)", prep: openTab("Campaigns"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (bell panel)", prep: openBell, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (fan drawer)", prep: openFanSheet, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (fan drawer: top-up form)", prep: inDrawer("Top up spins"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (fan drawer: Copy DM menu)", prep: inDrawer(/^Copy DM/), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (fan drawer: QR dialog)", prep: inDrawer(/QR/), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (DM templates modal)", prep: clickIn("Fans", /Manage messages/), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Import fans)", prep: clickIn("Fans", /Import fans/), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (wheel Manage menu)", prep: clickIn("Wheel", /^Manage /), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Admin New account modal)", prep: clickIn("Admin", "New account"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (bell panel)", viewport: PHONE, prep: openBell, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (Wheels)", viewport: PHONE, prep: openTab("Wheels"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (Inbox)", viewport: PHONE, prep: openTab("Inbox"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (Analytics)", viewport: PHONE, prep: openTab("Analytics"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (Settings)", viewport: PHONE, prep: openTab("Settings"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Terms prompt)", prep: openTermsPrompt(false), cleanup: closeTermsPrompt, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Terms prompt, ticked)", prep: openTermsPrompt(true), cleanup: closeTermsPrompt, advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard phone (Terms prompt)", viewport: PHONE, prep: openTermsPrompt(false), cleanup: closeTermsPrompt, advisory: DASH_ADVISORY },
  { path: "/spin/demo", name: "fan spin (age gate)" },
  { path: "/spin/demo", name: "fan spin (wheel)", prep: passAgeGate },
  { path: "/", name: "fan spin phone (legendary reveal)", viewport: PHONE, prep: openReveal("legendary"), cleanup: closeReveal },
  { path: "/", name: "fan spin (reduced-motion reveal)", prep: openReveal("epic", { reduced: true }), cleanup: closeReveal },
  { path: null, name: "fan spin (install nudge, Android)", viewport: PHONE, context: PHONE_CTX, prep: installNudge("android") },
  { path: null, name: "fan spin (install nudge, iPhone guide)", viewport: PHONE, context: { ...PHONE_CTX, userAgent: IPHONE_UA }, prep: installNudge("ios") },
  { path: "/", name: "verify (fairness v3 odds)", prep: openFreshVerify },
  { path: "/", name: "verify phone (fairness v3 odds)", viewport: PHONE, prep: openFreshVerify },
  // RM-2: "N left" chips + prize book counts. The editor's "Show stock to fans"
  // switch is scanned by the Wheel editor states above.
  { path: "/", name: "fan spin (limited stock + prize book)", prep: openStock },
  { path: "/", name: "fan spin phone (limited stock + prize book)", viewport: PHONE, prep: openStock },
];

// Impacts that fail the build vs. advisory-only.
const BLOCKING = new Set(["critical", "serious"]);

async function scan(page, { path, name, prep, cleanup, advisory = [], viewport = DESKTOP }) {
  await page.setViewportSize(viewport);
  if (path) await goto(page, path, 1600);
  if (prep) await prep(page);
  await page.addScriptTag({ content: AXE_SRC });
  const result = await page.evaluate(async () => {
    // WCAG 2 A & AA.
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });
  if (cleanup) await cleanup(page);
  const adv = new Set(advisory);
  return { name, violations: result.violations, advisory: adv };
}

let server = null;
let browser = null;
let exitCode = 1;
try {
  server = await startServer();
  log(`A11y scan → ${BASE}`);
  browser = await chromium.launch();
  const page = await browser.newContext({ viewport: DESKTOP }).then((c) => c.newPage());

  let blocking = 0;
  let advisories = 0;
  const lines = ["\n================ ACCESSIBILITY (axe wcag2a/aa) ================"];
  for (const p of PAGES) {
    // A `context` entry gets its own browser context (user agent, storage).
    const own = p.context ? await browser.newContext({ viewport: p.viewport ?? DESKTOP, ...p.context }) : null;
    const target = own ? await own.newPage() : page;
    const { name, violations, advisory } = await scan(target, p).finally(() => own?.close());
    // Split serious/critical into blocking vs. advisory (per-page allow-list).
    const block = violations.filter((v) => BLOCKING.has(v.impact) && !advisory.has(v.id));
    const adv = violations.filter((v) => BLOCKING.has(v.impact) && advisory.has(v.id));
    const moderate = violations.filter((v) => v.impact === "moderate").length;
    const minor = violations.filter((v) => v.impact === "minor").length;
    blocking += block.length;
    advisories += adv.length;
    const mark = block.length > 0 ? "✗" : "✓";
    lines.push(
      `  ${mark} ${name}: blocking=${block.length} advisory=${adv.length} moderate=${moderate} minor=${minor}`
    );
    for (const v of block) lines.push(`        [${v.impact}] ${v.id} (${v.nodes.length}) — ${v.help}`);
    for (const v of adv) lines.push(`        [advisory: ${v.impact}] ${v.id} (${v.nodes.length}) — tracked in ROADMAP`);
  }
  lines.push(
    blocking === 0
      ? `\n✅ A11Y PASSED (no blocking violations${advisories ? `; ${advisories} tracked advisory` : ""})`
      : `\n❌ A11Y FAILED — ${blocking} blocking violation(s)`
  );
  log(lines.join("\n"));
  exitCode = blocking === 0 ? 0 : 1;
} catch (e) {
  log("A11y harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  stopServer(server);
  process.exit(exitCode);
}
