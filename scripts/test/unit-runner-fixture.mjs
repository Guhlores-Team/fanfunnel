// Native child fixture: execute the actual unit runner with fake discovery and
// process spawning. No suite, browser, server or package-manager process runs.
import { mock } from "node:test";
import { writeSync } from "node:fs";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2];
const unsafe = {
  unsafe_semicolon: "bad;command.test.ts",
  unsafe_dollar: "bad$(command).test.ts",
  unsafe_backtick: "bad`command`.test.ts",
  unsafe_space: "bad file.test.ts",
  unsafe_quote: 'bad"file.test.ts',
  unsafe_pipe: "bad|file.test.ts",
  unsafe_parentheses: "bad(file).test.ts",
  traversal_escape: "../escape.test.ts",
  traversal_reentry: "../src/reentry.test.ts",
  traversal_nested: "folder/../reentry.test.ts",
  unsafe_backslash_entry: "folder\\reentry.test.ts",
};
const ordinary = ["src/a.test.ts", "src/b.test.ts", "src/nested/c.test.ts", "src/z.test.ts"];
const dynamic = ["src/app/api/creator-requests/[id]/route.test.ts", "src/app/docs/[...slug]/page.test.ts", "src/app/docs/[[...parts]]/route.test.ts", "src/plain.test.ts"];
const allowed = new Set(["normal_success", "dynamic_success", "failures_collect", "spawn_error_zero", "signal_zero", "null_status", "mixed_failures", "fallback_binary", "discovery_failure", ...Object.keys(unsafe)]);
if (!allowed.has(scenario)) throw new Error("Unknown unit runner fixture scenario");
const dirs = new Map();
const calls = [];
const discovered = [];
function add(file) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = join(...parts.slice(0, i));
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    dirs.get(dir).add(parts[i]);
  }
}
for (const file of [...(scenario === "dynamic_success" ? dynamic : ordinary), "src/ignored.tsx", "src/nested/readme.md"]) add(file);
if (Object.hasOwn(unsafe, scenario)) { dirs.clear(); dirs.set("src", new Set([unsafe[scenario]])); }
process.env.PATH = ["/fixture-missing", "/fixture-bin"].join(delimiter);
process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
globalThis.fetch = async () => { throw new Error("Unit runner fixture must not use the network"); };
const expectedPreloadPath = join(process.cwd(), "scripts/test-preload.mjs");
process.on("exit", (code) => writeSync(1, "UNIT_RUNNER_FIXTURE:" + JSON.stringify({ scenario, code, calls, discovered, expectedPreloadPath }) + "\n"));
mock.module("node:fs", { namedExports: {
  readdirSync: (dir) => {
    discovered.push(dir);
    if (scenario === "discovery_failure") throw new Error("injected discovery failure");
    if (!dirs.has(dir)) throw new Error("Unexpected discovery directory: " + dir);
    return [...dirs.get(dir)].reverse();
  },
  statSync: (file) => ({ isDirectory: () => dirs.has(file) }),
  existsSync: (file) => scenario !== "fallback_binary" && file === join("/fixture-bin", process.platform === "win32" ? "npx.COM" : "npx"),
} });
mock.module("node:child_process", { namedExports: { spawnSync: (binary, args, options) => {
  const index = calls.length;
  const response = { status: 0, signal: null, error: undefined };
  if (scenario === "failures_collect" && (index === 0 || index === 2)) response.status = index + 1;
  if ((scenario === "spawn_error_zero" && index === 0) || (scenario === "mixed_failures" && index === 1)) response.error = new Error("injected EPERM");
  if ((scenario === "signal_zero" && index === 0) || (scenario === "mixed_failures" && index === 2)) response.signal = "SIGTERM";
  if (scenario === "null_status" && index === 0) response.status = null;
  if (scenario === "mixed_failures" && index === 0) response.status = 2;
  calls.push({ binary, args, options, result: { status: response.status, signal: response.signal, error: response.error?.message ?? null } });
  return response;
} } });
await import(pathToFileURL(join(process.cwd(), "scripts/run-tests.mjs")).href);
