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
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

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

// Pages to scan + an optional prep step to reach a meaningful state.
//
// `advisory` lists rule ids that are reported but NOT blocking for that page.
// The dashboard used to treat `color-contrast` as advisory while white text sat
// on the creator's `--brand` (3.52:1 on the default pink). Brand fills now use
// `--brand-ink` (readableInk) and initials avatars use ink on the brand tint,
// so since RD-8 every rule blocks on every page, the dashboard included.
const DASH_ADVISORY = [];
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
  { path: "/spin/demo", name: "fan spin (age gate)" },
  { path: "/spin/demo", name: "fan spin (wheel)", prep: passAgeGate },
];

// Impacts that fail the build vs. advisory-only.
const BLOCKING = new Set(["critical", "serious"]);

async function scan(page, { path, name, prep, advisory = [], viewport = DESKTOP }) {
  await page.setViewportSize(viewport);
  await goto(page, path, 1600);
  if (prep) await prep(page);
  await page.addScriptTag({ content: AXE_SRC });
  const result = await page.evaluate(async () => {
    // WCAG 2 A & AA.
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });
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
    const { name, violations, advisory } = await scan(page, p);
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
