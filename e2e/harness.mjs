// E2E harness: server lifecycle, an error "sink" that attributes every genuine
// browser signal (pageerror / console error+warning / failed + unexpected
// 4xx-5xx) to the step in progress, plus small assertion + step helpers.
//
// No test-runner dependency — uses the `playwright` package already in
// devDependencies. Targets MOCK mode (no Supabase env), so it's deterministic
// and needs no external services: perfect for CI.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Synchronous stdout write — survives process.exit() even when stdout is a
 *  pipe (CI), unlike the async console.log buffer. */
export function log(s = "") {
  writeSync(1, s + "\n");
}

export const PORT = Number(process.env.E2E_PORT || 3100);
export const BASE = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
// fileURLToPath (not .pathname) so Windows gets `C:\...\artifacts\` rather than
// the broken `/C:/...` that .pathname yields, which breaks mkdir/writeFile.
export const ARTIFACTS = fileURLToPath(new URL("./artifacts/", import.meta.url));

/**
 * Fixture setup only: respect the real age-acknowledgement IP limit when many
 * independent accessibility states share one server. The application returns
 * Retry-After as positive integer seconds. Never retry another status, guess a missing
 * delay, change identity, or hide a refusal from the caller's existing checks.
 */
export async function acknowledgeFixtureFan(request, token, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const post = () => request.post(BASE + "/api/fans/ack", { data: { token } });
  let response = await post();
  for (let retry = 0; response.status() === 429 && retry < 2; retry++) {
    const header = response.headers()["retry-after"];
    if (typeof header !== "string" || !/^\d+$/.test(header.trim())) return response;
    const seconds = Number(header.trim());
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) return response;
    await wait(seconds * 1000);
    response = await post();
  }
  return response;
}

/** Start `next start` and resolve once it answers 200 (unless E2E_BASE_URL is
 *  provided, in which case we assume a server is already running). */
export async function startServer() {
  if (process.env.E2E_BASE_URL) return null;
  // shell:true so `npx` resolves to npx.cmd on Windows (otherwise spawn ENOENT).
  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    env: { ...process.env },
    shell: true,
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/", { signal: AbortSignal.timeout(5000) });
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  child.kill("SIGKILL");
  throw new Error(`server did not become ready at ${BASE} within 90s`);
}

export function stopServer(child) {
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

// ---- benign-signal filters -------------------------------------------------

// `?_rsc=` route prefetches get aborted when we navigate before they finish —
// that's normal App Router behavior, not an error.
//
// `net::ERR_ABORTED` is a BROWSER cancellation, not a server failure: a
// fire-and-forget mutation (optimistic UI) whose page unmounts/navigates before
// the request resolves reports exactly this. Real backend failures surface as a
// 4xx/5xx response (caught by benignResponse below) or a different net error
// (ERR_FAILED / ERR_CONNECTION_*), so filtering ERR_ABORTED removes the
// teardown-timing flake without hiding genuine signals.
const benignRequestFail = (url, errorText = "") =>
  /[?&]_rsc=/.test(url) || errorText === "net::ERR_ABORTED";

// Expected, non-bug HTTP statuses from the app's own endpoints.
const EXPECTED_4XX = [
  ["/api/spin", 409], // out of spins
  ["/api/spin", 403], // blocked / needs ack
  ["/api/spin", 429], // rate limited
];
// Read-only endpoints reachable BEFORE login — the public-page reads plus the
// identity probe. A GET 401 on one of these is expected during pre-login
// navigation. Trailing "/" marks a prefix so dynamic [param] segments match.
const PRELOGIN_READS = [
  "/api/me",
  "/api/public-profile",
  "/api/public/wheel/",
  "/api/recent-wins/",
  "/api/leaderboard/",
  "/api/share-cards/",
];
const isPreloginRead = (path) =>
  PRELOGIN_READS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
function benignResponse(url, status, method = "GET") {
  const path = url.replace(BASE, "").split("?")[0];
  // A GET 401 is benign ONLY on a known pre-login read endpoint. Restricting to
  // PRELOGIN_READS (instead of every /api/* path) means a 401 on a GET endpoint
  // that should be authenticated still surfaces as a genuine auth regression —
  // as does any 401 on a MUTATION (POST/PUT/DELETE/PATCH) or non-/api path.
  if (status === 401 && method.toUpperCase() === "GET" && isPreloginRead(path)) {
    return true;
  }
  return EXPECTED_4XX.some(([p, s]) => p === path && s === status);
}
const benignConsole = (text) => {
  const t = text.toLowerCase();
  return t.includes("download the react devtools") || t.includes("favicon");
};

/** Attach listeners to a page; returns a sink whose `.step` you set before each
 *  action so captured signals are attributed to it. Pass an existing sink to
 *  collect a second page (e.g. the phone-viewport journey) into the same report. */
export function attachSink(page, sink = { step: "boot", signals: [] }) {
  const push = (kind, detail) =>
    sink.signals.push({ step: sink.step, kind, detail: String(detail).slice(0, 240) });

  page.on("pageerror", (e) => push("pageerror", e.message || e));
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !benignConsole(m.text()))
      push("console." + m.type(), m.text());
  });
  page.on("requestfailed", (r) => {
    const errorText = r.failure()?.errorText ?? "";
    if (!benignRequestFail(r.url(), errorText))
      push("requestfailed", `${r.method()} ${r.url()} — ${errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !benignResponse(r.url(), r.status(), r.request().method()))
      push("http", `${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`);
  });
  return sink;
}

// ---- step + assertion plumbing --------------------------------------------

export function createRunner(sink) {
  const results = []; // { name, ok, note }
  let failures = 0;

  async function step(name, fn) {
    sink.step = name;
    try {
      await fn();
      results.push({ name, ok: true, note: "" });
    } catch (e) {
      failures++;
      results.push({ name, ok: false, note: String(e?.message || e).slice(0, 160) });
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error("assertion failed: " + msg);
  }

  function report() {
    const genuine = dedupe(sink.signals);
    const lines = [];
    lines.push("\n================ E2E STEPS ================");
    for (const r of results)
      lines.push(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.note ? "  — " + r.note : ""}`);

    lines.push("\n================ GENUINE BROWSER SIGNALS ================");
    if (genuine.length === 0) {
      lines.push("  none (no pageerrors, console errors/warnings, failed requests, unexpected 4xx/5xx)");
    } else {
      for (const s of genuine) lines.push(`  [${s.kind}] during «${s.step}»\n      ${s.detail}`);
    }

    const passed = results.filter((r) => r.ok).length;
    lines.push(
      `\nRESULT: ${passed}/${results.length} steps passed · ${genuine.length} genuine signal(s)`
    );
    const ok = failures === 0 && genuine.length === 0;
    lines.push(ok ? "\n✅ E2E PASSED" : "\n❌ E2E FAILED");

    const out = lines.join("\n");
    log(out);
    try {
      ensureArtifacts();
      writeFileSync(ARTIFACTS + "report.txt", out + "\n");
    } catch {
      /* ignore */
    }
    return ok;
  }

  return { step, assert, report };
}

function dedupe(signals) {
  const seen = new Set();
  const out = [];
  for (const s of signals) {
    const key = s.step + "|" + s.kind + "|" + s.detail.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ---- shared page helpers ---------------------------------------------------

export async function goto(page, path, settle = 1400) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(settle);
}

// Dashboard section nav. Items are buttons inside the visible "Dashboard
// sections" <nav> — the sidebar from `lg`, the bottom tab bar below it — and the
// active one carries aria-current="page". The phone bar's "More" button (it
// opens the More sheet, aria-haspopup) is not a section item.
export const NAV_ITEMS = "nav[aria-label='Dashboard sections']:visible button:not([aria-haspopup])";
export const MORE_BUTTON = "nav[aria-label='Dashboard sections']:visible button[aria-haspopup='dialog']";

export async function clickTab(page, name) {
  if (await clickNavItem(page, name)) return true;
  // Phone layout: sections not on the bar live in the More sheet.
  const more = page.locator(MORE_BUTTON);
  if (!(await more.count())) return false;
  await more.first().click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await sheet.waitFor({ timeout: 4000 });
  for (const t of await sheet.locator("nav button").all()) {
    if ((await t.innerText()).trim().toLowerCase().includes(name.toLowerCase())) {
      await t.click();
      await sheet.waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
      return true;
    }
  }
  await page.keyboard.press("Escape");
  return false;
}

async function clickNavItem(page, name) {
  const items = await page.locator(NAV_ITEMS).all();
  for (const t of items) {
    try {
      if ((await t.innerText()).trim().toLowerCase().includes(name.toLowerCase())) {
        await t.click();
        // Web-first wait: the clicked item reflects its current state once the
        // panel has switched — wait for that instead of a fixed pause.
        await t
          .and(page.locator("[aria-current='page']"))
          .waitFor({ timeout: 4000 })
          .catch(() => {});
        return true;
      }
    } catch {
      /* item detached — skip */
    }
  }
  return false;
}

/** Complete the fan age-gate if present (checks both boxes, clicks Enter).
 *  Best-effort + tolerant: only acts on a dialog that actually has the gate's
 *  checkboxes, uses short timeouts, and never throws (a missing/already-passed
 *  gate must not fail the calling step). */
export async function passAgeGate(page) {
  try {
    const dialog = page.locator("[role='dialog'][aria-modal='true']");
    if (!(await dialog.count())) return;
    const boxes = await page.locator("[role='dialog'] input[type='checkbox']").all();
    if (boxes.length === 0) return; // some other modal, not the age gate
    for (const box of boxes) {
      // check() auto-waits for and verifies the checked state — no fixed pause.
      await box.check({ timeout: 3000 }).catch(() => {});
    }
    const enter = page.locator("[role='dialog'] button:has-text('Enter')").first();
    await enter.click({ timeout: 4000 }).catch(() => {});
    // Web-first wait: the gate is done once its dialog is gone, not after a fixed
    // pause.
    await dialog.first().waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
  } catch {
    /* gate not blocking — proceed */
  }
}

export function ensureArtifacts() {
  try {
    mkdirSync(ARTIFACTS, { recursive: true });
  } catch {
    /* exists */
  }
  return ARTIFACTS;
}
