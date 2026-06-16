// E2E harness: server lifecycle, an error "sink" that attributes every genuine
// browser signal (pageerror / console error+warning / failed + unexpected
// 4xx-5xx) to the step in progress, plus small assertion + step helpers.
//
// No test-runner dependency — uses the `playwright` package already in
// devDependencies. Targets MOCK mode (no Supabase env), so it's deterministic
// and needs no external services: perfect for CI.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, writeSync } from "node:fs";

/** Synchronous stdout write — survives process.exit() even when stdout is a
 *  pipe (CI), unlike the async console.log buffer. */
export function log(s = "") {
  writeSync(1, s + "\n");
}

export const PORT = Number(process.env.E2E_PORT || 3100);
export const BASE = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
export const ARTIFACTS = new URL("./artifacts/", import.meta.url).pathname;

/** Start `next start` and resolve once it answers 200 (unless E2E_BASE_URL is
 *  provided, in which case we assume a server is already running). */
export async function startServer() {
  if (process.env.E2E_BASE_URL) return null;
  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    env: { ...process.env },
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
const benignRequestFail = (url) => /[?&]_rsc=/.test(url);

// Expected, non-bug HTTP statuses from the app's own endpoints.
const EXPECTED_4XX = [
  ["/api/spin", 409], // out of spins
  ["/api/spin", 403], // blocked / needs ack
  ["/api/spin", 429], // rate limited
];
function benignResponse(url, status) {
  const path = url.replace(BASE, "").split("?")[0];
  if (status === 401 && path.startsWith("/api/")) return true; // unauth reads
  return EXPECTED_4XX.some(([p, s]) => p === path && s === status);
}
const benignConsole = (text) => {
  const t = text.toLowerCase();
  return t.includes("download the react devtools") || t.includes("favicon");
};

/** Attach listeners to a page; returns a sink whose `.step` you set before each
 *  action so captured signals are attributed to it. */
export function attachSink(page) {
  const sink = { step: "boot", signals: [] };
  const push = (kind, detail) =>
    sink.signals.push({ step: sink.step, kind, detail: String(detail).slice(0, 240) });

  page.on("pageerror", (e) => push("pageerror", e.message || e));
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !benignConsole(m.text()))
      push("console." + m.type(), m.text());
  });
  page.on("requestfailed", (r) => {
    if (!benignRequestFail(r.url()))
      push("requestfailed", `${r.method()} ${r.url()} — ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !benignResponse(r.url(), r.status()))
      push("http", `${r.status()} ${r.url().replace(BASE, "")}`);
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

export async function clickTab(page, name) {
  const tabs = await page.locator("[role='tab']").all();
  for (const t of tabs) {
    try {
      if ((await t.innerText()).trim().toLowerCase().includes(name.toLowerCase())) {
        await t.click();
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {
      /* tab detached — skip */
    }
  }
  return false;
}

/** Complete the fan age-gate if present (checks both boxes, clicks Enter). */
export async function passAgeGate(page) {
  if (await page.locator("[role='dialog'][aria-modal='true']").count()) {
    for (const box of await page.locator("[role='dialog'] input[type='checkbox']").all()) {
      await box.check();
      await page.waitForTimeout(100);
    }
    await page.locator("[role='dialog'] button:has-text('Enter')").first().click();
    await page.waitForTimeout(1200);
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
