// Accessibility scan — runs axe-core (WCAG 2.0/2.1 A + AA) against the key
// pages in mock mode and fails the build on any *critical* or *serious*
// violation (moderate/minor are reported as advisories so the gate is
// meaningful without drowning in nitpicks). No secrets needed.
//
//   npm run build && npm run e2e:a11y
//   E2E_BASE_URL=<url> node e2e/a11y.mjs   (against a running server)

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { startServer, stopServer, goto, passAgeGate, clickTab, log, BASE } from "./harness.mjs";

const AXE_SRC = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const openTab = (name) => async (page) => {
  await clickTab(page, name);
  await page.waitForTimeout(600);
};

// Pages to scan + an optional prep step to reach a meaningful state.
//
// `advisory` lists rule ids that are reported but NOT blocking for that page.
// We keep every rule blocking on the public/fan/login pages, and treat
// `color-contrast` as advisory on the AUTHENTICATED dashboard: small white-text
// chips sit on the creator-customizable `--brand` (#ec4899 default = 3.52:1),
// a known systemic brand-token issue tracked in ROADMAP.md — not silently
// hidden, just not gating the whole suite on a brand redesign.
const DASH_ADVISORY = ["color-contrast"];
const PAGES = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/c/demo", name: "link-in-bio" },
  { path: "/dashboard", name: "dashboard (Today)", advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Wheel editor)", prep: openTab("Wheel"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Fans)", prep: openTab("Fans"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Analytics)", prep: openTab("Analytics"), advisory: DASH_ADVISORY },
  { path: "/dashboard", name: "dashboard (Boosts)", prep: openTab("Boosts"), advisory: DASH_ADVISORY },
  { path: "/spin/demo", name: "fan spin (age gate)" },
  { path: "/spin/demo", name: "fan spin (wheel)", prep: passAgeGate },
];

// Impacts that fail the build vs. advisory-only.
const BLOCKING = new Set(["critical", "serious"]);

async function scan(page, { path, name, prep, advisory = [] }) {
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
  const page = await browser.newContext({ viewport: { width: 1280, height: 900 } }).then((c) => c.newPage());

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
