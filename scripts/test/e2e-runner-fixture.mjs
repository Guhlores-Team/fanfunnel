// Native-Node fixture for e2eRunner.test.ts. Executes the actual orchestrator;
// module mocks replace browser/server/journeys before its imports are evaluated.
import { mock } from "node:test";
import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2];
const allowed = new Set([
  "success", "crash_before_first", "crash_after_pass", "crash_last_journey",
  "step_failure", "browser_signal", "server_setup_failure", "browser_setup_failure",
  "context_setup_failure", "screenshot_failure", "report_failure",
  "close_failure_after_crash", "close_failure_success", "stop_failure",
]);
if (!allowed.has(scenario)) throw new Error("Unknown runner fixture scenario");
const runnerUrl = pathToFileURL(resolve("e2e/run.mjs"));
const source = readFileSync(runnerUrl, "utf8");
const events = [];
const note = (type, detail = null) => events.push({ type, detail });
let activeSink;
let failures = 0;
let stepCount = 0;
globalThis.fetch = async () => { throw new Error("Runner fixture must never use the network"); };
process.on("exit", (code) => {
  writeSync(1, "E2E_RUNNER_FIXTURE:" + JSON.stringify({ scenario, code, stepCount, failures, events }) + "\n");
});

const page = {
  screenshot: async () => {
    note("screenshot");
    if (scenario === "screenshot_failure") throw new Error("injected screenshot failure");
  },
};
const browser = {
  newContext: async () => {
    note("context");
    if (scenario === "context_setup_failure") throw new Error("injected context setup failure");
    return { newPage: async () => { note("page"); return page; } };
  },
  close: async () => {
    note("browser_close");
    if (scenario === "close_failure_after_crash" || scenario === "close_failure_success") throw new Error("injected browser close failure");
  },
};
mock.module("playwright", { namedExports: { chromium: { launch: async () => {
  note("launch");
  if (scenario === "browser_setup_failure") throw new Error("injected browser setup failure");
  return browser;
} } } });

// A query gives this read-only namespace a separate cache identity. Retain real
// helper exports (including fixture pacing) while replacing orchestration I/O.
// Guard child_process too: even a missing mock must not start a real server.
mock.module("node:child_process", { namedExports: { spawn: () => { throw new Error("Runner fixture must never spawn a server"); } } });
const harnessUrl = new URL("./harness.mjs", runnerUrl);
const actualHarness = await import(harnessUrl.href + "?fixture-exports");
mock.module(harnessUrl.href, { namedExports: {
  ...actualHarness,
  BASE: "http://fixture.invalid",
  log: (message) => note("log", message),
  startServer: async () => {
    note("server_start");
    if (scenario === "server_setup_failure") throw new Error("injected server setup failure");
    return { ownedFixtureServer: true };
  },
  stopServer: (server) => {
    note("server_stop", server?.ownedFixtureServer === true);
    if (scenario === "stop_failure") throw new Error("injected server cleanup failure");
  },
  attachSink: () => { activeSink = { step: "boot", signals: [] }; note("sink"); return activeSink; },
  ensureArtifacts: () => { note("artifacts"); return "/mock-artifacts/"; },
  createRunner: (sink) => ({
    assert: (condition, message) => { if (!condition) throw new Error(message); },
    step: async (name, task) => {
      stepCount++;
      try { await task(); note("step_pass", name); }
      catch { failures++; note("step_fail", name); }
    },
    report: () => {
      const ok = failures === 0 && sink.signals.length === 0;
      note("report", ok);
      if (scenario === "report_failure") throw new Error("injected report failure");
      return ok;
    },
  }),
} });

// Read registrations from the real runner so later feature journeys are also
// replaced, without deleting, skipping or rewriting any orchestration calls.
for (const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*["'](\.\/[^"']+)["']/gm)) {
  const [, names, specifier] = match;
  if (specifier === "./harness.mjs") continue;
  const namedExports = {};
  for (const entry of names.split(",").map((name) => name.trim()).filter(Boolean)) {
    const name = entry.split(/\s+as\s+/)[0];
    namedExports[name] = async (...args) => {
      note("journey", name);
      if (name === "creatorJourney" && ["crash_before_first", "screenshot_failure", "close_failure_after_crash"].includes(scenario)) throw new Error("injected crash before steps");
      if (name === "firstRunJourney" && scenario === "crash_last_journey") throw new Error("injected last journey crash");
      const runner = args.find((arg) => arg && typeof arg.step === "function" && typeof arg.report === "function");
      if (!runner) throw new Error("Actual journey did not receive its runner");
      await runner.step(name, async () => {
        if (name === "creatorJourney" && scenario === "step_failure") throw new Error("injected recorded step failure");
      });
      if (name === "creatorJourney" && scenario === "browser_signal") activeSink.signals.push({ kind: "pageerror", detail: "injected browser signal" });
      if (name === "creatorJourney" && scenario === "crash_after_pass") throw new Error("injected crash after a passed step");
    };
  }
  mock.module(new URL(specifier, runnerUrl).href, { namedExports });
}
await import(runnerUrl.href);
