/**
 * RM-4: the app service worker stays inert and narrowly scoped.
 *
 * It exists so web push can add `push` / `notificationclick` handlers for the
 * installed dashboard app. It must never cache: no fetch handler, no Cache
 * Storage, no imported scripts. It is registered from one place only, with the
 * /dashboard scope, and never on a fan's /spin/<token> page (whose responses
 * carry the fan's bearer token).
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SERVICE_WORKER_SCOPE, SERVICE_WORKER_URL } from "./config";

const ROOT = join(import.meta.dirname, "../../..");

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const sw = stripComments(readFileSync(join(ROOT, "public", "sw.js"), "utf8"));
check("sw.js exists at the registered URL", SERVICE_WORKER_URL === "/sw.js");
check("sw.js has no fetch handler", !/["']fetch["']/.test(sw) && !/\bonfetch\b/.test(sw));
check("sw.js never uses Cache Storage", !/\bcaches\b/.test(sw) && !/\bCache\b/.test(sw));
check("sw.js imports no scripts", !/importScripts|\bimport\s*\(|\bimport\s+[\w{*]/.test(sw));
check("sw.js makes no network calls", !/\bfetch\s*\(|XMLHttpRequest|sendBeacon/.test(sw));
const events = [...sw.matchAll(/addEventListener\(\s*["'](\w+)["']/g)].map((m) => m[1]);
const allowed = ["install", "activate", "push", "notificationclick", "notificationclose", "pushsubscriptionchange"];
check(`sw.js listens only to lifecycle/push events (${events.join(", ")})`, events.every((e) => allowed.includes(e)));

check("scope is the dashboard only", SERVICE_WORKER_SCOPE === "/dashboard");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}
const src = files(join(ROOT, "src"));
const registrars = src.filter((f) => /serviceWorker\s*\.\s*register\s*\(/.test(stripComments(readFileSync(f, "utf8"))));
check(
  `exactly one service worker registration (found: ${registrars.map((f) => relative(ROOT, f)).join(", ") || "none"})`,
  registrars.length === 1 && registrars[0].endsWith(join("components", "pwa", "AppServiceWorker.tsx"))
);
const reg = stripComments(readFileSync(registrars[0], "utf8"));
check("it registers with the dashboard scope constant", /scope:\s*SERVICE_WORKER_SCOPE/.test(reg));
check("it bypasses the HTTP cache for the worker script", /updateViaCache:\s*["']none["']/.test(reg));

const mounts = src.filter((f) => /<AppServiceWorker\b/.test(readFileSync(f, "utf8")));
check(
  `mounted only by the dashboard page (found: ${mounts.map((f) => relative(ROOT, f)).join(", ") || "none"})`,
  mounts.length === 1 && mounts[0].endsWith(join("app", "dashboard", "page.tsx"))
);
const fanSide = src.filter((f) => {
  const rel = relative(ROOT, f);
  return rel.startsWith(join("src", "app", "spin")) || rel.startsWith(join("src", "components", "fan")) || rel.endsWith("SpinClient.tsx");
});
check("fan pages never touch service workers", fanSide.every((f) => !/serviceWorker|AppServiceWorker/.test(stripComments(readFileSync(f, "utf8")))));

const nextConfig = readFileSync(join(ROOT, "next.config.ts"), "utf8");
check("sw.js is served no-store", /source:\s*"\/sw\.js"[\s\S]*?no-cache, no-store, must-revalidate/.test(nextConfig));

console.log(`service worker: ${passed} checks passed`);
