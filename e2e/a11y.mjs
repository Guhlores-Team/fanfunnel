// Accessibility scan — runs axe-core (WCAG 2.0/2.1 A + AA) against the key
// pages in mock mode and fails the build on any *critical* or *serious*
// violation (moderate/minor are reported as advisories so the gate is
// meaningful without drowning in nitpicks). No secrets needed.
//
//   npm run build && npm run e2e:a11y
//   E2E_BASE_URL=<url> node e2e/a11y.mjs   (against a running server)

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { startServer, stopServer, goto, passAgeGate, log, BASE } from "./harness.mjs";

const AXE_SRC = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

// Pages to scan + an optional prep step to reach a meaningful state.
const PAGES = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/dashboard", name: "dashboard" },
  { path: "/spin/demo", name: "fan spin (age gate)" },
  { path: "/spin/demo", name: "fan spin (wheel)", prep: passAgeGate },
];

// Impacts that fail the build vs. advisory-only.
const BLOCKING = new Set(["critical", "serious"]);

async function scan(page, { path, name, prep }) {
  await goto(page, path, 1600);
  if (prep) await prep(page);
  await page.addScriptTag({ content: AXE_SRC });
  const result = await page.evaluate(async () => {
    // WCAG 2 A & AA.
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  });
  const byImpact = { critical: [], serious: [], moderate: [], minor: [] };
  for (const v of result.violations) {
    (byImpact[v.impact] ?? (byImpact[v.impact] = [])).push(v);
  }
  return { name, byImpact, violations: result.violations };
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
  const lines = ["\n================ ACCESSIBILITY (axe wcag2a/aa) ================"];
  for (const p of PAGES) {
    const { name, byImpact, violations } = await scan(page, p);
    const c = byImpact.critical.length;
    const s = byImpact.serious.length;
    const m = byImpact.moderate.length;
    const mi = byImpact.minor.length;
    blocking += c + s;
    const mark = c + s > 0 ? "✗" : "✓";
    lines.push(`  ${mark} ${name}: critical=${c} serious=${s} moderate=${m} minor=${mi}`);
    // Detail the blocking ones (rule id + how many nodes) so they're actionable.
    for (const v of violations.filter((v) => BLOCKING.has(v.impact))) {
      lines.push(`        [${v.impact}] ${v.id} (${v.nodes.length}) — ${v.help}`);
    }
  }
  lines.push(
    blocking === 0
      ? "\n✅ A11Y PASSED (no critical/serious violations)"
      : `\n❌ A11Y FAILED — ${blocking} critical/serious violation(s)`
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
