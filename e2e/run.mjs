// E2E orchestrator. Boots `next start` (unless E2E_BASE_URL points at a running
// server), runs the creator + fan journeys with the error sink attached, writes
// a screenshot on any failure, prints a report, and exits non-zero if any step
// failed or any genuine browser signal was captured.
//
//   npm run build && npm run e2e
//   E2E_BASE_URL=https://preview.example.com node e2e/run.mjs   (against a deploy)

import { chromium } from "playwright";
import {
  startServer,
  stopServer,
  attachSink,
  createRunner,
  ensureArtifacts,
  log,
  BASE,
} from "./harness.mjs";
import { creatorJourney, fanJourney } from "./journeys.mjs";

let server = null;
let browser = null;
let exitCode = 1;

try {
  server = await startServer();
  log(`E2E target: ${BASE}`);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const sink = attachSink(page);
  const runner = createRunner(sink);

  try {
    await creatorJourney(page, runner);
    await fanJourney(page, runner, ctx);
  } catch (e) {
    log("Journey crashed: " + (e?.stack || e));
  }

  // Screenshot the final state if anything went wrong, for debugging in CI.
  const ok = runner.report();
  if (!ok) {
    try {
      const dir = ensureArtifacts();
      await page.screenshot({ path: dir + "failure.png", fullPage: true });
      log(`\nSaved failure screenshot → ${dir}failure.png`);
    } catch {
      /* ignore */
    }
  }
  exitCode = ok ? 0 : 1;
} catch (e) {
  log("E2E harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  stopServer(server);
  process.exit(exitCode);
}
