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
import {
  creatorJourney,
  fanJourney,
  creatorExtras,
  fanExtras,
  firstRunJourney,
  notificationsJourney,
  termsJourney,
} from "./journeys.mjs";
import { mobileJourney } from "./mobile.mjs";
import { revealJourney } from "./reveal.mjs";
import { pwaJourney } from "./pwa.mjs";
import { stockJourney } from "./stock.mjs";
import { playJourney } from "./play.mjs";
import { glowJourney } from "./glow.mjs";
import { winbackJourney } from "./winback.mjs";
import { privacyJourney } from "./privacy.mjs";

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
    await fanJourney(page, runner, ctx); // fan spins → creates a pending redemption
    await creatorExtras(page, runner, ctx); // fulfil it + drawer→inbox + admin + webhooks + happy hour
    await revealJourney(page, runner, ctx); // RM-1: rarity reveal, tap-to-skip, reduced motion, announcement (own fan)
    await stockJourney(page, runner, ctx); // RM-2: "N left", the Show-stock switch, near-miss vs card on phones (restores the wheel)
    await fanExtras(page, runner, ctx); // wishlist/chat/share/out-of-spins/self-exclude
    await notificationsJourney(page, runner, ctx); // bell: count → open marks seen → items navigate
    await mobileJourney(browser, runner, sink); // phone: tab bar + More + fan sheet (read-only)
    await pwaJourney(browser, runner, sink, ctx); // home-screen install on a fresh fan link (RM-4)
    await playJourney(page, runner, ctx); // RM-6: Your play counts, reminder card, a break the server enforces (own fan)
    await glowJourney(browser, runner, page, ctx); // RM-3: visit glow on a fresh fan link (no previews, clamped dates, gate)
    await winbackJourney(page, runner, ctx); // RM-5: win-back queue, snooze, came back; Fans never copies a paused link
    await privacyJourney(page, runner, ctx); // fan export/delete on a throwaway link + creator export
    await termsJourney(page, runner); // creator clickwrap: stale version → prompt → accept (0055)
    await firstRunJourney(page, runner, ctx); // wipes the account → brand-new creator's Today (last)
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
