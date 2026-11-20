// Pure helpers for the fan's home-screen install nudge (RM-4), kept out of the
// component so they are unit-tested.
import { INSTALL_NUDGE_SNOOZE_DAYS, INSTALL_NUDGE_STORAGE_KEY } from "@/lib/pwa/config";

const DAY_MS = 86_400_000;

/**
 * iPhone / iPad, where "Add to Home Screen" lives in the Share sheet and there
 * is no install event. iPadOS reports a Mac platform, so a touch-capable
 * "MacIntel" counts too.
 */
export function isIosDevice(userAgent: string, platform = "", maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}

type KV = Pick<Storage, "getItem" | "setItem">;

function storage(): KV | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked storage (private mode, policy)
  }
}

/** True while a "Not now" from the last INSTALL_NUDGE_SNOOZE_DAYS is in force. */
export function installNudgeSnoozed(now = Date.now(), store: KV | null = storage()): boolean {
  try {
    const at = Number(store?.getItem(INSTALL_NUDGE_STORAGE_KEY) ?? "");
    return Number.isFinite(at) && at > 0 && now - at < INSTALL_NUDGE_SNOOZE_DAYS * DAY_MS && at <= now;
  } catch {
    return false;
  }
}

export function snoozeInstallNudge(now = Date.now(), store: KV | null = storage()): void {
  try {
    store?.setItem(INSTALL_NUDGE_STORAGE_KEY, String(now));
  } catch {
    /* storage full or blocked: the card just hides for this page view */
  }
}
