import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installNudgeSnoozed, isIosDevice, snoozeInstallNudge } from "./installNudge";
import { INSTALL_NUDGE_SNOOZE_DAYS, INSTALL_NUDGE_STORAGE_KEY } from "@/lib/pwa/config";

// RM-4: the fan's home-screen install nudge. Pure rules here; the rendered card
// (after a win only, hidden when installed) is covered by e2e + a11y.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- platform -------------------------------------------------------------------
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD_OS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
check("iPhone is iOS", isIosDevice(IPHONE));
check("iPadOS (desktop UA + touch) is iOS", isIosDevice(IPAD_OS, "MacIntel", 5));
check("a real Mac is not iOS", !isIosDevice(IPAD_OS, "MacIntel", 0));
check("Android is not iOS (it gets the native Install prompt)", !isIosDevice(ANDROID, "Linux armv8l", 5));

// --- 14-day snooze, storage wrapped in try/catch ----------------------------------
const mem = new Map<string, string>();
const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const DAY = 86_400_000;
const t0 = 1_700_000_000_000;
check("not snoozed before any dismissal", !installNudgeSnoozed(t0, store));
snoozeInstallNudge(t0, store);
check("dismissal is stored under the named key", mem.get(INSTALL_NUDGE_STORAGE_KEY) === String(t0));
check("snoozed right after Not now", installNudgeSnoozed(t0 + 1000, store));
check("still snoozed on day 13", installNudgeSnoozed(t0 + 13 * DAY, store));
check(`back after ${INSTALL_NUDGE_SNOOZE_DAYS} days`, !installNudgeSnoozed(t0 + INSTALL_NUDGE_SNOOZE_DAYS * DAY, store));
check("a future timestamp (clock skew) does not hide it forever", !installNudgeSnoozed(t0 - DAY, store));
mem.set(INSTALL_NUDGE_STORAGE_KEY, "garbage");
check("a corrupt value is ignored", !installNudgeSnoozed(t0, store));
const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};
check("blocked storage: reads as not snoozed", !installNudgeSnoozed(t0, throwing));
snoozeInstallNudge(t0, throwing);
check("blocked storage: dismiss does not throw", true);
check("no window (SSR): not snoozed", !installNudgeSnoozed(t0));

// --- the component's guard rails (static) ------------------------------------------
const src = readFileSync(join(import.meta.dirname, "InstallNudge.tsx"), "utf8");
check("hidden when already installed (display-mode: standalone)", src.includes("(display-mode: standalone)") && /navigator as Navigator & \{ standalone\?: boolean \}/.test(src));
check(
  "hidden on a paused link and while on a break (F6 engagement gate)",
  /useLinkPause\(\)/.test(src) &&
    /useFanBreak\(\)/.test(src) &&
    /fanEngagementAllowed\(\{ selfExcluded: paused, breakUntil \}, now\)/.test(src) &&
    /const eligible = !standalone && engaged &&/.test(src)
);
check("offered only once armed by a win", /armed && eligible/.test(src));
check("uses the native prompt on Android, never on its own", /preventDefault\(\)/.test(src) && /deferred\.prompt\(\)/.test(src));
check("never stores the token", !/token/i.test(src.replace(/\/\/.*$/gm, "")));
const spinClient = readFileSync(join(import.meta.dirname, "..", "SpinClient.tsx"), "utf8");
const controller = readFileSync(join(import.meta.dirname, "FanGameController.tsx"), "utf8");
check("SpinClient delegates its token-bound pass and gallery to exactly one shared controller",
  /import FanGameController from "\.\/fan\/FanGameController"/.test(spinClient) &&
  (spinClient.match(/<FanGameController\b/g) ?? []).length === 1 &&
  /<FanGameController key=\{pass\.token\} pass=\{pass\} gallery=\{gallery\} \/>/.test(spinClient) &&
  !/fetch\(|useSpinRecovery\(/.test(spinClient));
check("SpinClient mounts it once, armed by a revealed win only outside pause/break",
  (spinClient.match(/<InstallNudge\b/g) ?? []).length === 0 &&
  (controller.match(/<InstallNudge\b/g) ?? []).length === 1 &&
  /<InstallNudge armed=\{reveal && won !== null && engaged\} \/>/.test(controller) &&
  /const engaged = fanEngagementAllowed\(\{ blocked: pass\.blocked, selfExcluded: paused, breakUntil \}, now\)/.test(controller));

console.log(`install nudge: ${passed} checks passed`);
